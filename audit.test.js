'use strict';
// node --test audit.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 33a. The whole API runs here as the restricted emr_app role (003_audit_grants.sql), so these tests also prove that role has enough rights
// for every write route while having none to change or remove audit rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { ROUTE_ACTIONS } = require('./permissions.js');
const { hashPassword } = require('./auth.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_audit_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {                       // TEST-ONLY actor, as in api.test.js; users are created through the owner connection
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['aud-' + role, 'Audit ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const api = () => request(app);
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
const since = async (id) => (await owner.query('SELECT * FROM audit_log WHERE id > $1 ORDER BY id', [id])).rows;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${pw}'`);          // what an admin does once (see 003_audit_grants.sql)
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

const NO_AUDIT = ['POST /import/dry-run', 'PATCH /element-sets/:setId', 'DELETE /element-sets/:setId'];   // write nothing, so there is nothing to audit
const mkCase = (id, extra = {}) => ({ id, patient: { name: 'Demo', ageSex: '40 F', bed: 'B2', mrn: 'M1' }, narrative: 'n', applied: [], pathways: [], values: {}, notes: [], ...extra });

test('every write route writes exactly one audit row, attributed to the logged-in user', async () => {
  const st = {}, imp = 'aud-' + crypto.randomBytes(3).toString('hex');
  const P = (u, b) => api().post(u).send(b), c = () => '/api/cases/' + st.c.id;
  // [route key as in permissions.js, expected audit action, expected HTTP status, request]
  const S = [
    ['POST /cases', 'case.create', 201, async () => (st.c = (await P('/api/cases', { patient: { name: 'A', ageSex: '1 M', bed: '1', mrn: '1' }, narrative: 'x' })).body, { status: 201 })],
    ['PATCH /cases/:id', 'case.update', 200, () => api().patch(c()).send({ expectedVersion: 1, narrative: 'y' })],
    ['POST /cases/:id/rows', 'row.add', 201, async () => { const r = await P(c() + '/rows', { setId: 'care.t', groupId: 'vitals', row: { hr: '80' } }); st.row = r.body; return r; }],
    ['PATCH /cases/:id/rows/:rowId', 'row.amend', 200, () => api().patch(`${c()}/rows/${st.row.id}`).send({ expectedVersion: 1, row: { hr: '90' } })],
    ['POST /cases/:id/rows/:rowId/error', 'row.entered_in_error', 200, () => P(`${c()}/rows/${st.row.id}/error`, { expectedVersion: 2, reason: 'wrong patient' })],
    ['PUT /cases/:id/values', 'value.set', 200, () => api().put(c() + '/values').send({ key: 'care.t/f', value: 1, expectedVersion: 0 })],
    ['POST /cases/:id/notes', 'note.create', 201, async () => { const r = await P(c() + '/notes', { type: 'narrative', text: 'draft' }); st.n = r.body; return r; }],
    ['PATCH /cases/:id/notes/:nid', 'note.edit', 200, () => api().patch(`${c()}/notes/${st.n.id}`).send({ expectedVersion: 1, text: 'draft2' })],
    ['POST /cases/:id/notes/:nid/sign', 'note.sign', 200, () => P(`${c()}/notes/${st.n.id}/sign`, { expectedVersion: 2 })],
    ['POST /cases/:id/notes/:nid/amend', 'note.amend', 201, () => P(`${c()}/notes/${st.n.id}/amend`, { reason: 'typo fix', text: 'amended' })],
    ['POST /element-sets', 'set.save', 201, () => P('/api/element-sets', { setId: 'user.t', kind: 'custom', body: {} })],
    ['POST /usage/:setId', 'usage.count', 200, () => P('/api/usage/care.t', {})],
    ['DELETE /usage', 'usage.clear', 204, () => api().delete('/api/usage')],
    ['POST /codes', 'code.add', 201, () => P('/api/codes', { system: 'snomed', code: '123456', display: 'x' })],
    ['POST /codes/:system/:code/live', 'code.verify_live', 200, () => P('/api/codes/snomed/123456/live', { ok: true })],
    ['PUT /bindings', 'binding.set', 200, () => api().put('/api/bindings').send({ setId: 'care.t', fieldId: 'f', system: 'snomed', code: '123456', display: 'x' })],
    ['DELETE /bindings/:setId/:fieldId', 'binding.delete', 204, () => api().delete('/api/bindings/care.t/f')],
    ['PUT /rules/:owner/:ruleId', 'rule.save', 200, () => api().put('/api/rules/care.t/r1').send({ body: { a: 1 }, expectedVersion: 0 })],
    ['POST /rules/:owner/:ruleId/approve', 'rule.approve', 200, () => P('/api/rules/care.t/r1/approve', { expectedVersion: 1 })],
    ['POST /rules/:owner/:ruleId/disable', 'rule.disable', 200, () => P('/api/rules/care.t/r1/disable', { expectedVersion: 2 })],
    ['DELETE /rules/:owner/:ruleId', 'rule.delete', 204, () => api().delete('/api/rules/care.t/r1?expectedVersion=3')],
    ['PUT /protocols/:setId', 'protocol.save', 200, () => api().put('/api/protocols/care.t').send({ body: {}, expectedVersion: 0 })],
    ['POST /protocols/:setId/approve', 'protocol.approve', 200, () => P('/api/protocols/care.t/approve', { expectedVersion: 1 })],
    ['PUT /prefs/:key', 'pref.set', 200, () => api().put('/api/prefs/theme').send({ value: 'dark' })],
    ['POST /users', 'user.create', 201, async () => { const r = await P('/api/users', { username: 'aud-new-' + imp, name: 'Aud New', role: 'nurse' }); st.u = r.body.user; return r; }],
    ['POST /users/:id/role', 'user.role', 200, () => P(`/api/users/${st.u.id}/role`, { role: 'viewer' })],
    ['POST /users/:id/reset-password', 'user.reset_password', 200, () => P(`/api/users/${st.u.id}/reset-password`, {})],
    ['POST /users/:id/deactivate', 'user.deactivate', 200, () => P(`/api/users/${st.u.id}/deactivate`, {})],
    ['POST /users/:id/reactivate', 'user.reactivate', 200, () => P(`/api/users/${st.u.id}/reactivate`, {})],
    ['POST /password', 'password.change', 204, async () => {          // the test actor has no password: give it one, then change it through the route
      await owner.query('UPDATE users SET password_hash=$2 WHERE id=$1', [actors.admin.id, await hashPassword('old test passphrase 1')]);
      return P('/api/password', { currentPassword: 'old test passphrase 1', newPassword: 'new test passphrase 2' });
    }],
    ['POST /import', 'import.commit', 201, () => P('/api/import', { cases: [mkCase(imp)] })],
    ['POST /import', 'import.failed', 422, () => P('/api/import', { cases: [mkCase(imp + '-bad', { values: { 'bad key with spaces': 1 } })] })],
  ];
  for (const [key, action, status, run] of S) {
    const before = await maxId(), r = await run();
    assert.equal(r.status, status, `${key}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    const rows = await since(before);
    assert.equal(rows.length, 1, `${key}: expected one audit row, got ${rows.length}`);
    assert.equal(rows[0].action, action, key);
    assert.equal(rows[0].user_id, actors.admin.id, key); assert.equal(rows[0].role, 'admin', key); assert.ok(rows[0].ip, key + ': ip');
  }
  // a new write route cannot slip in unaudited: it must be exercised above or listed as writing nothing
  const covered = new Set([...S.map((s) => s[0]), ...NO_AUDIT]);
  for (const key of Object.keys(ROUTE_ACTIONS).filter((k) => !k.startsWith('GET '))) assert.ok(covered.has(key), `${key} has no audit test (chunk 33a rule)`);
  // content of a few rows: before/after, reason, and the patient looked up from the case
  const hist = (await owner.query(`SELECT * FROM audit_log WHERE entity_id=$1 ORDER BY id`, [st.row.id])).rows;
  assert.deepEqual(hist.map((h) => h.action), ['row.add', 'row.amend', 'row.entered_in_error']);
  assert.equal(hist[1].before.row.hr, '80'); assert.equal(hist[1].after.row.hr, '90'); assert.equal(hist[2].reason, 'wrong patient');
  const pid = (await owner.query(`INSERT INTO patients (mrn,name) VALUES ('M-aud','P') RETURNING id`)).rows[0].id;
  await owner.query('UPDATE cases SET patient_id=$2 WHERE id=$1', [st.c.id, pid]);
  const m = await maxId(); await P(c() + '/rows', { setId: 'care.t', groupId: 'vitals', row: { hr: '70' } });
  assert.equal((await since(m))[0].patient_id, pid);
});

test('reads, refused and conflicting requests write no audit row and no data', async () => {
  const c = (await api().post('/api/cases').send({ narrative: 'keep' })).body, m = await maxId();
  await api().get('/api/cases'); await api().get('/api/cases/' + c.id); await api().get('/api/rules');
  assert.equal((await api().post('/api/import/dry-run').send({ cases: [mkCase('dry-' + c.id)] })).status, 200);
  assert.equal((await api().patch('/api/element-sets/user.t').send({})).status, 405);
  assert.equal((await api().patch('/api/cases/' + c.id).send({ expectedVersion: 99, narrative: 'lost' })).status, 409);       // stale version
  assert.equal((await api().post('/api/element-sets').set('x-test-role', 'nurse').send({ setId: 'n.t', kind: 'custom', body: {} })).status, 403);   // not allowed
  assert.equal((await api().post('/api/cases').send({ user_id: crypto.randomUUID(), narrative: 'forged' })).status, 400);       // actor cannot come from the body
  assert.deepEqual(await since(m), []);
  assert.equal((await owner.query('SELECT narrative FROM cases WHERE id=$1', [c.id])).rows[0].narrative, 'keep');
});

test('if the audit insert fails the change fails with it (nothing is saved)', async () => {
  const c = (await api().post('/api/cases').send({ narrative: 'before' })).body;
  const cases0 = (await owner.query('SELECT count(*)::int n FROM cases')).rows[0].n, m = await maxId();
  await owner.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`);
  await owner.query('CREATE TRIGGER fail_audit_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
  const log = console.error; console.error = () => {};
  try {
    for (const [r, what] of [[await api().post('/api/cases').send({ narrative: 'new' }), 'case create'],
      [await api().post(`/api/cases/${c.id}/rows`).send({ setId: 'care.t', groupId: 'g', row: { a: 1 } }), 'row add'],
      [await api().put(`/api/cases/${c.id}/values`).send({ key: 'care.t/f', value: 1, expectedVersion: 0 }), 'value set'],
      [await api().patch('/api/cases/' + c.id).send({ expectedVersion: 1, narrative: 'changed' }), 'case update'],
      [await api().put('/api/prefs/theme').send({ value: 'x' }), 'pref set']]) assert.equal(r.status, 500, what);
    assert.equal((await owner.query('SELECT count(*)::int n FROM cases')).rows[0].n, cases0);
    assert.equal((await owner.query('SELECT narrative, version FROM cases WHERE id=$1', [c.id])).rows[0].narrative, 'before');
    assert.equal((await owner.query('SELECT count(*)::int n FROM case_rows WHERE case_id=$1', [c.id])).rows[0].n, 0);
    assert.equal((await owner.query('SELECT count(*)::int n FROM case_values WHERE case_id=$1', [c.id])).rows[0].n, 0);
  } finally {
    console.error = log;
    await owner.query('DROP TRIGGER fail_audit_t ON audit_log'); await owner.query('DROP FUNCTION fail_audit()');
  }
  assert.deepEqual(await since(m), []);
  assert.equal((await api().post(`/api/cases/${c.id}/rows`).send({ setId: 'care.t', groupId: 'g', row: { a: 1 } })).status, 201);   // the trigger was the cause
});

test('the app role can INSERT and SELECT audit_log and review_events but not UPDATE, DELETE, TRUNCATE or drop them', async () => {
  const denied = (p, re) => assert.rejects(p, (e) => e.code === '42501' && re.test(e.message), String(re));
  await appDb.query(`INSERT INTO audit_log (action, entity) VALUES ('t', 't')`);
  assert.ok((await appDb.query('SELECT count(*)::int n FROM audit_log')).rows[0].n > 0);
  await appDb.query('SELECT count(*) FROM review_events');
  for (const t of ['audit_log', 'review_events']) {
    await denied(appDb.query(`UPDATE ${t} SET id = id`), /permission denied/);       // "permission denied", not the trigger's "append-only": the grant stops it first
    await denied(appDb.query(`DELETE FROM ${t}`), /permission denied/);
    await denied(appDb.query(`TRUNCATE ${t}`), /permission denied/);
    await denied(appDb.query(`DROP TABLE ${t}`), /must be owner/);
  }
  await denied(appDb.query('SELECT * FROM schema_migrations'), /permission denied/);
  assert.ok((await appDb.query('SELECT 1 FROM cases LIMIT 1')).rows);                // and it keeps ordinary working rights
});

test('audit rows carry the right user under concurrent requests from different users', async () => {
  const roles = ['admin', 'doctor', 'nurse'], jobs = [];
  for (const role of roles) await api().get('/api/me').set('x-test-role', role);           // create the three users first
  for (let i = 0; i < 12; i++) for (const role of roles) jobs.push(api().post('/api/cases').set('x-test-role', role).send({ narrative: `c${i}` }).then((r) => [role, r.body.id]));
  const done = await Promise.all(jobs);
  assert.equal(done.length, 36);
  for (const [role, id] of done) {
    const a = (await owner.query(`SELECT user_id, role FROM audit_log WHERE entity='case' AND entity_id=$1 AND action='case.create'`, [id])).rows;
    assert.equal(a.length, 1); assert.equal(a[0].user_id, actors[role].id); assert.equal(a[0].role, role);
  }
});
