'use strict';
// node --test audit-admin.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 33d. The admin Audit screen's server half: GET /api/audit (filters, paging) and GET /api/audit.csv (itself audited). Runs as the restricted emr_app role.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { ROUTE_ACTIONS, ACTIONS } = require('./permissions.js');
const { csvCell, auditPage, CSV_COLUMNS } = require('./audit.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_auda_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {                       // TEST-ONLY actor, as in audit.test.js
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['adm-' + role, 'Admin test ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const api = () => request(app);
const as = (role) => (role === 'admin' ? {} : { 'x-test-role': role });
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
const since = async (id) => (await owner.query('SELECT * FROM audit_log WHERE id > $1 ORDER BY id', [id])).rows;
/** Minimal RFC 4180 reader for the tests (quoted cells, doubled quotes, CRLF). */
function parseCsv(t) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csvText = (r) => r.text || (Buffer.isBuffer(r.body) ? r.body.toString('utf8') : '');

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${pw}'`);
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = pw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb, getActor });
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('only an admin can read the log or export it; the permission is in the one table and both routes are mapped', async () => {
  assert.deepEqual(ACTIONS['audit.read'], ['admin']);
  assert.equal(ROUTE_ACTIONS['GET /audit'], 'audit.read'); assert.equal(ROUTE_ACTIONS['GET /audit.csv'], 'audit.read');
  await api().post('/api/cases').send({ narrative: 'seed' });                     // make sure there is something to protect
  const m = await maxId();
  for (const role of ['doctor', 'nurse', 'informatician', 'viewer']) {
    for (const url of ['/api/audit', '/api/audit.csv']) {
      const r = await api().get(url).set(as(role));
      assert.equal(r.status, 403, `${role} ${url}`);
      assert.equal(r.body.items, undefined, `${role} ${url}: no data in a refusal`);
    }
  }
  assert.deepEqual(await since(m), [], 'a refused export writes no audit_export row');
  assert.equal((await api().get('/api/audit')).status, 200);
  assert.equal((await api().get('/api/audit.csv')).status, 200);
});

test('GET /audit: newest first, filters by user, patient, action (exact or prefix), dates, and pages with a cursor', async () => {
  const pid = (await owner.query(`INSERT INTO patients (mrn,name) VALUES ('M-33d','Aud Patient') RETURNING id`)).rows[0].id;
  const c = (await api().post('/api/cases').send({ narrative: 'x' })).body;
  await owner.query('UPDATE cases SET patient_id=$2 WHERE id=$1', [c.id, pid]);
  for (let i = 0; i < 3; i++) await api().post(`/api/cases/${c.id}/rows`).send({ setId: 'care.t', groupId: 'vitals', row: { hr: String(60 + i) } });
  await api().put('/api/prefs/theme').set(as('nurse')).send({ value: 'dark' });          // an action by someone else

  const all = (await api().get('/api/audit?limit=200')).body;
  assert.ok(all.items.length >= 6);
  const ids = all.items.map((i) => BigInt(i.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? 1 : -1)), 'newest first');
  assert.ok(all.items[0].at && all.items[0].action && 'before' in all.items[0] && 'after' in all.items[0], 'the screen gets the full row');

  const byPatient = (await api().get('/api/audit?patient=' + pid)).body.items;
  assert.ok(byPatient.length === 3 && byPatient.every((i) => i.patientId === pid && i.action === 'row.add'));
  const byName = (await api().get('/api/audit?user=ADM-nurse')).body.items;                      // username, case-insensitive
  assert.ok(byName.length >= 1 && byName.every((i) => i.username === 'adm-nurse' && i.role === 'nurse'));
  const byId = (await api().get('/api/audit?user=' + actors.nurse.id)).body.items;
  assert.deepEqual(byId.map((i) => i.id), byName.map((i) => i.id));
  assert.equal((await api().get('/api/audit?action=row.add')).body.items.every((i) => i.action === 'row.add'), true);
  const pre = (await api().get('/api/audit?action=row.*&limit=200')).body.items;
  assert.ok(pre.length >= 3 && pre.every((i) => i.action.startsWith('row.')));
  assert.equal((await api().get('/api/audit?action=r_w.*')).body.items.length, 0, '_ in a prefix is literal, not a wildcard');
  assert.equal((await api().get('/api/audit?user=nobody-' + crypto.randomBytes(3).toString('hex'))).body.items.length, 0);

  const future = new Date(Date.now() + 86400000).toISOString(), past = new Date(Date.now() - 86400000).toISOString();
  assert.equal((await api().get('/api/audit?from=' + encodeURIComponent(future))).body.items.length, 0);
  assert.equal((await api().get('/api/audit?to=' + encodeURIComponent(past))).body.items.length, 0);
  assert.ok((await api().get('/api/audit?from=' + encodeURIComponent(past) + '&to=' + encodeURIComponent(future))).body.items.length >= 6);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((await api().get(`/api/audit?from=${today}&to=${today}`)).body.items.length >= 6, 'a bare "to" date includes that whole UTC day');

  const p1 = (await api().get('/api/audit?limit=2')).body;                                         // paging: no gaps, no repeats
  assert.equal(p1.items.length, 2); assert.ok(p1.nextBefore);
  const p2 = (await api().get('/api/audit?limit=2&before=' + p1.nextBefore)).body;
  assert.ok(BigInt(p2.items[0].id) < BigInt(p1.items[1].id));
  const seen = new Set(); let cur = null, pages = 0;
  do { const pg = (await api().get('/api/audit?limit=3' + (cur ? '&before=' + cur : ''))).body; pg.items.forEach((i) => { assert.ok(!seen.has(i.id)); seen.add(i.id); }); cur = pg.nextBefore; pages++; } while (cur && pages < 100);
  assert.equal(seen.size, all.items.length, 'paging through returns every row once');
  assert.equal((await api().get('/api/audit?limit=100000')).status, 400, 'limit is capped by validation');
});

test('GET /audit refuses bad input with 400 and never builds SQL from it', async () => {
  for (const q of ['patient=not-a-uuid', 'from=yesterday', 'to=2026-13-45x', "action=row.add';DROP TABLE audit_log;--", 'action=*', 'limit=abc', 'limit=0x10', 'before=-5', 'before=1;2',
    'unknown=1', 'user[]=a&user[]=b', 'user=' + 'x'.repeat(101), 'patient=' + crypto.randomUUID() + '&patient=' + crypto.randomUUID()]) {
    const r = await api().get('/api/audit?' + q);
    assert.equal(r.status, 400, q);
  }
  assert.equal((await api().get("/api/audit?user=" + encodeURIComponent("x' OR '1'='1"))).body.items.length, 0, 'odd text in user is just a name that matches nobody');
  assert.equal((await owner.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name='audit_log'`)).rows[0].n, 1);
});

test('GET /audit.csv: same filter, header row, metadata only, and it writes exactly one audit_export row (with the filter)', async () => {
  const c = (await api().post('/api/cases').send({ narrative: 'SECRET-NARRATIVE-33d' })).body;
  await api().patch('/api/cases/' + c.id).send({ expectedVersion: 1, narrative: 'SECRET-CHANGED-33d' });
  const m = await maxId();
  const r = await api().get('/api/audit.csv?action=case.*&user=adm-admin').buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (x) => (d += x)); res.on('end', () => cb(null, d)); });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/csv/); assert.match(r.headers['content-disposition'], /attachment/); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-audit-truncated'], 'false');
  const rows = parseCsv(r.body);
  assert.deepEqual(rows[0], CSV_COLUMNS);
  assert.equal(rows.length - 1, Number(r.headers['x-audit-rows']));
  assert.ok(rows.slice(1).every((x) => x[5].startsWith('case.') && x[3] === 'adm-admin' && x.length === CSV_COLUMNS.length));
  assert.ok(!r.body.includes('SECRET-NARRATIVE-33d') && !r.body.includes('SECRET-CHANGED-33d'), 'before/after (clinical content) are not exported');
  const w = await since(m);
  assert.equal(w.length, 1); assert.equal(w[0].action, 'audit_export'); assert.equal(w[0].entity, 'audit_log');
  assert.equal(w[0].user_id, actors.admin.id); assert.equal(w[0].role, 'admin'); assert.ok(w[0].ip);
  assert.deepEqual(w[0].after.filter, { action: 'case.*', user: 'adm-admin' }); assert.equal(w[0].after.rows, rows.length - 1); assert.equal(w[0].after.truncated, false);
  // the export is itself in the next export, but not in its own
  const again = parseCsv(csvText(await api().get('/api/audit.csv?action=audit_export').buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (x) => (d += x)); res.on('end', () => cb(null, d)); }).then((x) => ({ text: x.body }))));
  assert.ok(again.length >= 2 && again.slice(1).some((x) => x[0] === String(w[0].id)), 'a later export lists the earlier export');
  // bad filters are refused before anything is read or recorded
  const m2 = await maxId();
  assert.equal((await api().get('/api/audit.csv?patient=zzz')).status, 400);
  assert.equal((await api().get('/api/audit.csv?before=5')).status, 400, 'paging is for the screen; an export takes filters only');
  assert.deepEqual(await since(m2), []);
});

test('CSV cells that start with = + - @ are neutralised and awkward text stays one cell', async () => {
  assert.equal(csvCell('=1+1'), "'=1+1"); assert.equal(csvCell('+cmd'), "'+cmd"); assert.equal(csvCell('-2+3'), "'-2+3"); assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.ok(csvCell('\tx').startsWith("'"), 'a leading tab is neutralised too');
  assert.equal(csvCell('plain'), 'plain'); assert.equal(csvCell(null), ''); assert.equal(csvCell(5n), '5');
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('l1\nl2'), '"l1\nl2"');
  assert.equal(csvCell('=a,"b"'), '"\'=a,""b"""');
  const c = (await api().post('/api/cases').send({ narrative: 'x' })).body;
  const reasons = ['=HYPERLINK("http://x","y")', '+1+1', '-1-1', '@SUM(1)', 'two, parts', 'line one\nline two'];
  for (const reason of reasons) {
    const row = (await api().post(`/api/cases/${c.id}/rows`).send({ setId: 'care.t', groupId: 'g', row: { a: 1 } })).body;
    assert.equal((await api().post(`/api/cases/${c.id}/rows/${row.id}/error`).send({ expectedVersion: 1, reason })).status, 200);
  }
  const r = await api().get('/api/audit.csv?action=row.entered_in_error').buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (x) => (d += x)); res.on('end', () => cb(null, d)); });
  const rows = parseCsv(r.body).slice(1), col = CSV_COLUMNS.indexOf('reason');
  const got = rows.map((x) => x[col]);
  for (const reason of reasons) assert.ok(got.includes(/^[=+\-@]/.test(reason) ? "'" + reason : reason), 'reason survives: ' + JSON.stringify(reason));
  assert.ok(rows.every((x) => x.length === CSV_COLUMNS.length), 'quotes, commas and newlines never split a row');
  assert.ok(got.filter(Boolean).every((v) => !/^[=+\-@]/.test(v)), 'no exported cell starts with a formula character');
});

test('if the export cannot be recorded, nothing is exported', async () => {
  await owner.query(`CREATE FUNCTION fail_export() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`);
  await owner.query('CREATE TRIGGER fail_export_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_export()');
  const log = console.error; console.error = () => {};
  const m = await maxId();
  try {
    const r = await api().get('/api/audit.csv');
    assert.equal(r.status, 500);
    assert.ok(!/id,at,user_id/.test(r.text || ''), 'no CSV in the failure response');
    assert.equal((await api().get('/api/audit')).status, 200, 'viewing the screen writes nothing, so it still works');
  } finally {
    console.error = log;
    await owner.query('DROP TRIGGER fail_export_t ON audit_log'); await owner.query('DROP FUNCTION fail_export()');
  }
  assert.deepEqual(await since(m), []);
  assert.equal((await api().get('/api/audit.csv')).status, 200, 'the trigger was the cause');
});

test('viewing the screen (GET /audit) writes no audit row, and the export cap is reported rather than silent', async () => {
  const m = await maxId();
  await api().get('/api/audit'); await api().get('/api/audit?action=row.*');
  assert.deepEqual(await since(m), []);
  for (let i = 0; i < 3; i++) await api().put('/api/prefs/k' + i).send({ value: i });
  const p = await auditPage(owner, {}, 2, 2);                                                       // cap of 2 stands in for the 50 000 export cap
  assert.equal(p.rows.length, 2); assert.ok(p.nextBefore, 'more rows than the cap are reported as truncated');
  const q = await auditPage(owner, {}, 5000, 3);
  assert.equal(q.rows.length, 3);
});
