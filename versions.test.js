'use strict';
// node --test versions.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 33b: old versions of rows and values are kept, "entered in error" needs a reason and hides without removing, clinical data is never deleted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_ver_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let db, app, appRole;                                   // appRole: a connection that acts as the restricted emr_app role (003_audit_grants.sql)
const actors = {};
async function getActor(req) {                          // TEST-ONLY actor, as in api.test.js
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await db.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['ver-' + role, 'Ver ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const as = (role) => ({ get: (u) => request(app).get(u).set('x-test-role', role), post: (u, b) => request(app).post(u).set('x-test-role', role).send(b),
  patch: (u, b) => request(app).patch(u).set('x-test-role', role).send(b), put: (u, b) => request(app).put(u).set('x-test-role', role).send(b),
  delete: (u) => request(app).delete(u).set('x-test-role', role) });
const rejected = (p, re) => assert.rejects(p, (e) => re.test(e.message));
const newCase = async () => (await as('admin').post('/api/cases', { narrative: 'v' })).body;
const rowCount = async (sql, p) => (await db.query(sql, p)).rows[0].n;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name)); await migrate(db, __dirname);
  await db.query(`INSERT INTO element_sets (set_id,version,kind,body,source) VALUES ('care.t',1,'care','{}','user')`);   // a nurse may chart in care sets
  app = createApp({ db, getActor });
  appRole = new Client({ connectionString: withDb(name) }); await appRole.connect(); await appRole.query('SET ROLE emr_app');
});
test.after(async () => {
  if (appRole) await appRole.end();
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('editing a reading keeps every old version with who wrote it, who replaced it, when and why', async () => {
  const c = await newCase(), url = `/api/cases/${c.id}/rows`;
  const r1 = (await as('nurse').post(url, { setId: 'care.t', groupId: 'vitals', row: { hr: '80' } })).body;
  const e1 = await as('doctor').patch(`${url}/${r1.id}`, { expectedVersion: 1, row: { hr: '90' }, reason: 'transcription error' });
  assert.equal(e1.status, 200); assert.equal(e1.body.version, 2);
  const e2 = await as('nurse').patch(`${url}/${r1.id}`, { expectedVersion: 2, row: { hr: '95' } });            // a nurse may amend a reading she entered herself
  assert.equal(e2.status, 200);
  const e3 = await as('doctor').patch(`${url}/${r1.id}`, { expectedVersion: 3, row: { hr: '99' } });
  assert.equal(e3.status, 200);
  const v = (await db.query('SELECT * FROM row_versions WHERE row_id=$1 ORDER BY version', [r1.id])).rows;
  assert.deepEqual(v.map((x) => [x.version, x.row.hr]), [[1, '80'], [2, '90'], [3, '95']]);                 // the live row holds 99
  assert.equal(v[0].written_by, actors.nurse.id); assert.equal(v[0].replaced_by, actors.doctor.id); assert.equal(v[0].reason, 'transcription error');
  assert.equal(v[1].written_by, actors.doctor.id); assert.equal(v[1].replaced_by, actors.nurse.id); assert.equal(v[1].reason, null); assert.ok(v[0].written_at && v[0].replaced_at);
  assert.equal(v[2].written_by, actors.nurse.id); assert.equal(v[2].replaced_by, actors.doctor.id);
  assert.equal((await as('doctor').patch(`${url}/${r1.id}`, { expectedVersion: 1, row: { hr: '1' } })).status, 409);   // stale: nothing saved
  assert.equal(await rowCount('SELECT count(*)::int n FROM row_versions WHERE row_id=$1', [r1.id]), 3);
  assert.equal((await as('doctor').patch(`${url}/${r1.id}`, { expectedVersion: 4, row: { hr: '1' }, reason: 'x' })).status, 400);   // a reason, when given, is at least 3 characters
});

test('editing a saved value keeps the old value; creating one keeps nothing', async () => {
  const c = await newCase(), url = `/api/cases/${c.id}/values`, k = 'care.t/note';
  assert.equal((await as('doctor').put(url, { key: k, value: 'a', expectedVersion: 0 })).status, 200);
  assert.equal(await rowCount('SELECT count(*)::int n FROM value_versions WHERE case_id=$1', [c.id]), 0);
  assert.equal((await as('admin').put(url, { key: k, value: 'b', expectedVersion: 1, reason: 'corrected dose unit' })).status, 200);
  assert.equal((await as('doctor').put(url, { key: k, value: 'c', expectedVersion: 2 })).status, 200);
  const v = (await db.query('SELECT * FROM value_versions WHERE case_id=$1 AND key=$2 ORDER BY version', [c.id, k])).rows;
  assert.deepEqual(v.map((x) => [x.version, x.value]), [[1, 'a'], [2, 'b']]);
  assert.equal(v[0].written_by, actors.doctor.id); assert.equal(v[0].replaced_by, actors.admin.id); assert.equal(v[0].reason, 'corrected dose unit');
  assert.equal(v[1].written_by, actors.admin.id); assert.equal(v[1].replaced_by, actors.doctor.id);
  assert.equal((await as('doctor').put(url, { key: k, value: 'z', expectedVersion: 1 })).status, 409);       // stale
  assert.equal(await rowCount('SELECT count(*)::int n FROM value_versions WHERE case_id=$1', [c.id]), 2);
});

test('entered in error needs a reason, hides the reading by default, and keeps it with the reason', async () => {
  const c = await newCase(), url = `/api/cases/${c.id}/rows`;
  const r = (await as('nurse').post(url, { setId: 'care.t', groupId: 'vitals', row: { hr: '120' } })).body, err = `${url}/${r.id}/error`;
  for (const body of [{ expectedVersion: 1 }, { expectedVersion: 1, reason: '' }, { expectedVersion: 1, reason: '  ' }, { expectedVersion: 1, reason: 'no' }]) {
    assert.equal((await as('nurse').post(err, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await db.query('SELECT status FROM case_rows WHERE id=$1', [r.id])).rows[0].status, 'active');        // refused: nothing changed
  assert.equal(await rowCount('SELECT count(*)::int n FROM row_versions WHERE row_id=$1', [r.id]), 0);
  const ok = await as('nurse').post(err, { expectedVersion: 1, reason: 'wrong patient charted' });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'entered_in_error');
  assert.equal((await as('admin').get('/api/cases/' + c.id)).body.values['care.t/@vitals'], undefined);              // hidden by default
  const v = (await db.query('SELECT * FROM row_versions WHERE row_id=$1', [r.id])).rows;
  assert.equal(v.length, 1); assert.equal(v[0].row.hr, '120'); assert.equal(v[0].status, 'active'); assert.equal(v[0].reason, 'wrong patient charted'); assert.equal(v[0].replaced_by, actors.nurse.id);
  const kept = (await db.query('SELECT status, error_reason, row FROM case_rows WHERE id=$1', [r.id])).rows[0];
  assert.deepEqual([kept.status, kept.error_reason, kept.row.hr], ['entered_in_error', 'wrong patient charted', '120']);   // kept, not removed
  assert.equal((await as('doctor').patch(`${url}/${r.id}`, { expectedVersion: 2, row: { hr: '1' } })).status, 422);   // cannot be edited again
  assert.equal((await as('doctor').post(err, { expectedVersion: 2, reason: 'again please' })).status, 409);
});

test('GET include_errors=true works for doctors and admins only', async () => {
  const c = await newCase(), url = `/api/cases/${c.id}`;
  const r = (await as('admin').post(url + '/rows', { setId: 'care.t', groupId: 'g', row: { a: 1 } })).body;
  await as('admin').post(`${url}/rows/${r.id}/error`, { expectedVersion: 1, reason: 'entered by mistake' });
  for (const role of ['admin', 'doctor']) {
    const g = await as(role).get(url + '?include_errors=true');
    assert.equal(g.status, 200, role); assert.deepEqual(g.body.values['care.t/@g'].map((x) => x.__status), ['entered_in_error']);
    assert.equal((await as(role).get(url + '?includeErrors=1')).status, 200);                                  // the older spelling still works, with the same rule
  }
  for (const role of ['nurse', 'informatician', 'viewer']) {
    assert.equal((await as(role).get(url + '?include_errors=true')).status, 403, role);
    assert.equal((await as(role).get(url + '?includeErrors=1')).status, 403, role);
    const plain = await as(role).get(url); assert.equal(plain.status, 200); assert.equal(plain.body.values['care.t/@g'], undefined);   // default view hides it
  }
});

test('never DELETE: no route, the app role has no right, and the database refuses even the owner', async () => {
  const c = await newCase(), url = `/api/cases/${c.id}`;
  const r = (await as('admin').post(url + '/rows', { setId: 'care.t', groupId: 'g', row: { a: 1 } })).body;
  await as('admin').patch(`${url}/rows/${r.id}`, { expectedVersion: 1, row: { a: 2 } });
  await as('admin').put(url + '/values', { key: 'care.t/f', value: 1, expectedVersion: 0 }); await as('admin').put(url + '/values', { key: 'care.t/f', value: 2, expectedVersion: 1 });
  for (const u of [`${url}/rows/${r.id}`, url + '/values', url]) assert.equal((await as('admin').delete(u)).status, 404, u);   // no DELETE route exists
  for (const t of ['cases', 'case_rows', 'case_values', 'case_notes', 'row_versions', 'value_versions']) {
    await rejected(appRole.query(`DELETE FROM ${t}`), /permission denied/);                                   // the app role cannot
    await rejected(appRole.query(`TRUNCATE ${t}`), /permission denied/);
    await rejected(db.query(`DELETE FROM ${t}`), /append-only/);                                              // nobody can, not even the owner (trigger, also on an empty table)
    await rejected(db.query(`TRUNCATE ${t} CASCADE`), /append-only/);
  }
  for (const t of ['row_versions', 'value_versions']) {
    await rejected(appRole.query(`UPDATE ${t} SET version = version`), /permission denied/);
    await rejected(db.query(`UPDATE ${t} SET version = version`), /append-only/);
  }
  await appRole.query('SELECT count(*) FROM row_versions'); await appRole.query('SELECT count(*) FROM value_versions');
  assert.equal(await rowCount('SELECT count(*)::int n FROM row_versions WHERE row_id=$1', [r.id]), 1);
  assert.equal(await rowCount('SELECT count(*)::int n FROM value_versions WHERE case_id=$1', [c.id]), 1);
});

test('the old version is saved in the same transaction: if saving it fails the edit fails too', async () => {
  const c = await newCase(), url = `/api/cases/${c.id}`;
  const r = (await as('admin').post(url + '/rows', { setId: 'care.t', groupId: 'g', row: { a: 1 } })).body;
  await as('admin').put(url + '/values', { key: 'care.t/f', value: 1, expectedVersion: 0 });
  await db.query(`CREATE FUNCTION fail_ver() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'versions down'; END $$`);
  await db.query('CREATE TRIGGER fail_row_v BEFORE INSERT ON row_versions FOR EACH ROW EXECUTE FUNCTION fail_ver()');
  await db.query('CREATE TRIGGER fail_val_v BEFORE INSERT ON value_versions FOR EACH ROW EXECUTE FUNCTION fail_ver()');
  const log = console.error; console.error = () => {};
  try {
    assert.equal((await as('admin').patch(`${url}/rows/${r.id}`, { expectedVersion: 1, row: { a: 2 } })).status, 500);
    assert.equal((await as('admin').post(`${url}/rows/${r.id}/error`, { expectedVersion: 1, reason: 'mistake made' })).status, 500);
    assert.equal((await as('admin').put(url + '/values', { key: 'care.t/f', value: 2, expectedVersion: 1 })).status, 500);
    const row = (await db.query('SELECT row, version, status FROM case_rows WHERE id=$1', [r.id])).rows[0];
    assert.deepEqual([row.row.a, row.version, row.status], [1, 1, 'active']);
    assert.equal((await db.query('SELECT value, version FROM case_values WHERE case_id=$1', [c.id])).rows[0].version, 1);
  } finally {
    console.error = log;
    await db.query('DROP TRIGGER fail_row_v ON row_versions'); await db.query('DROP TRIGGER fail_val_v ON value_versions'); await db.query('DROP FUNCTION fail_ver()');
  }
  assert.equal((await as('admin').patch(`${url}/rows/${r.id}`, { expectedVersion: 1, row: { a: 2 } })).status, 200);   // the trigger was the cause
});

// ---------- chunk 33c1: record-view logging and the history route ----------
const viewRows = (cid, uid) => db.query(`SELECT * FROM audit_log WHERE action='view' AND entity='case' AND entity_id=$1 ${uid ? 'AND user_id=$2' : ''} ORDER BY id`, uid ? [cid, uid] : [cid]).then((r) => r.rows);
const noisy = async (fn) => { const log = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = log; } };

test('33c1: opening a case writes ONE view row (user, role, case, patient, no content); the same user again within 10 minutes writes none; another user writes their own', async () => {
  const c = (await as('admin').post('/api/cases', { narrative: 'SECRET-NARRATIVE-33c1' })).body;
  assert.deepEqual(await viewRows(c.id), []);                                                  // creating a case is case.create, not a view
  assert.equal((await as('nurse').get('/api/cases/' + c.id)).status, 200);
  assert.equal((await as('nurse').get('/api/cases/' + c.id)).status, 200);
  const n = await viewRows(c.id, actors.nurse.id);
  assert.equal(n.length, 1); assert.equal(n[0].role, 'nurse'); assert.equal(n[0].entity_id, c.id); assert.equal(n[0].patient_id, (await db.query('SELECT patient_id FROM cases WHERE id=$1', [c.id])).rows[0].patient_id);
  assert.equal(n[0].before, null); assert.equal(n[0].after, null); assert.equal(n[0].reason, null);
  assert.ok(!JSON.stringify(n[0]).includes('SECRET-NARRATIVE-33c1'), 'no clinical content in the row');
  assert.equal((await as('doctor').get('/api/cases/' + c.id)).status, 200);
  assert.equal((await viewRows(c.id, actors.doctor.id)).length, 1); assert.equal((await viewRows(c.id)).length, 2);
});

test('33c1: the throttle uses the database clock: a view 9 minutes ago still suppresses, one 11 minutes ago does not', async () => {
  const c = await newCase(), ins = (mins) => db.query(`INSERT INTO audit_log (user_id, role, action, entity, entity_id, at) VALUES ($1,'viewer','view','case',$2, now() - make_interval(mins => $3))`, [actors.admin.id, c.id, mins]);
  await ins(9); await as('admin').get('/api/cases/' + c.id); assert.equal((await viewRows(c.id, actors.admin.id)).length, 1, 'inside the window: nothing new');
  const d = await newCase(); await db.query(`INSERT INTO audit_log (user_id, role, action, entity, entity_id, at) VALUES ($1,'admin','view','case',$2, now() - interval '11 minutes')`, [actors.admin.id, d.id]);
  await as('admin').get('/api/cases/' + d.id); assert.equal((await viewRows(d.id, actors.admin.id)).length, 2, 'outside the window: a new row');
});

test('33c1: simultaneous opens by one user write exactly one row', async () => {
  const c = await newCase();
  const rs = await Promise.all(Array.from({ length: 6 }, () => as('doctor').get('/api/cases/' + c.id)));
  assert.ok(rs.every((r) => r.status === 200)); assert.equal((await viewRows(c.id, actors.doctor.id)).length, 1);
});

test('33c1: a refused, missing or malformed read writes nothing', async () => {
  const c = await newCase(), before = Number((await db.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
  assert.equal((await as('nurse').get(`/api/cases/${c.id}?include_errors=true`)).status, 403);        // refused: a nurse may not ask for error rows
  assert.equal((await as('admin').get('/api/cases/' + crypto.randomUUID())).status, 404);
  assert.equal((await as('admin').get('/api/cases/not-a-uuid')).status, 404);
  assert.equal((await request(app).get('/api/cases/' + c.id).set('x-test-role', 'admin')).status, 200);   // control: this one is allowed and does write
  const rows = (await db.query('SELECT action FROM audit_log WHERE id > $1 ORDER BY id', [before])).rows.map((r) => r.action);
  assert.deepEqual(rows, ['view']);
});

test('33c1: if the view row cannot be written the read FAILS and no case data is sent', async () => {
  const c = (await as('admin').post('/api/cases', { narrative: 'SECRET-FAIL-33c1' })).body;
  await db.query(`CREATE FUNCTION fail_view() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='view' THEN RAISE EXCEPTION 'audit down'; END IF; RETURN NEW; END $$`);
  await db.query('CREATE TRIGGER fail_view_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_view()');
  try {
    const r = await noisy(() => as('nurse').get('/api/cases/' + c.id));
    assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.body).includes('SECRET-FAIL-33c1')); assert.deepEqual(await viewRows(c.id), []);
    assert.equal((await as('nurse').get(`/api/cases/${c.id}/history`)).status, 200, 'history is not a view and does not depend on the view row');
  } finally { await db.query('DROP TRIGGER fail_view_t ON audit_log'); await db.query('DROP FUNCTION fail_view()'); }
  assert.equal((await as('nurse').get('/api/cases/' + c.id)).status, 200);
});

async function historyCase() {
  const c = await newCase(), url = `/api/cases/${c.id}`;
  const r1 = (await as('nurse').post(url + '/rows', { setId: 'care.t', groupId: 'vitals', row: { hr: '80' } })).body;
  assert.equal((await as('doctor').patch(`${url}/rows/${r1.id}`, { expectedVersion: 1, row: { hr: '90' }, reason: 'transcription error' })).status, 200);
  const r2 = (await as('nurse').post(url + '/rows', { setId: 'care.t', groupId: 'vitals', row: { hr: '300' } })).body;
  assert.equal((await as('doctor').post(`${url}/rows/${r2.id}/error`, { expectedVersion: 1, reason: 'wrong patient 33c1' })).status, 200);
  const r3 = (await as('nurse').post(url + '/rows', { setId: 'care.t', groupId: 'vitals', row: { hr: '70' } })).body;     // never changed: not in the history
  assert.equal((await as('doctor').put(url + '/values', { key: 'care.t/f', value: 1, expectedVersion: 0 })).status, 200);
  assert.equal((await as('admin').put(url + '/values', { key: 'care.t/f', value: 2, expectedVersion: 1 })).status, 200);
  return { c, r1, r2, r3 };
}

test('33c1: history lists each changed row and value, newest first, with who, when and why', async () => {
  const { c, r1, r2, r3 } = await historyCase(), h = (await as('doctor').get(`/api/cases/${c.id}/history`)); assert.equal(h.status, 200);
  assert.equal(h.body.caseId, c.id);
  assert.deepEqual(h.body.rows.map((r) => r.rowId).sort(), [r1.id, r2.id].sort(), 'a row nobody changed is not listed');
  const a = h.body.rows.find((r) => r.rowId === r1.id);
  assert.deepEqual(a.versions.map((v) => [v.version, v.current, v.row.hr]), [[2, true, '90'], [1, false, '80']]);
  assert.equal(a.versions[0].writtenBy, actors.doctor.id); assert.equal(a.versions[0].writtenByName, 'Ver doctor'); assert.ok(!Number.isNaN(Date.parse(a.versions[0].writtenAt)));
  assert.equal(a.versions[1].writtenBy, actors.nurse.id); assert.equal(a.versions[1].replacedBy, actors.doctor.id); assert.equal(a.versions[1].reason, 'transcription error'); assert.ok(a.versions[1].replacedAt);
  const e = h.body.rows.find((r) => r.rowId === r2.id);
  assert.equal(e.status, 'entered_in_error'); assert.equal(e.versions[0].reason, 'wrong patient 33c1'); assert.equal(e.versions[0].writtenBy, actors.doctor.id); assert.equal(e.versions[1].row.hr, '300');
  assert.equal(h.body.values.length, 1); assert.equal(h.body.values[0].key, 'care.t/f');
  assert.deepEqual(h.body.values[0].versions.map((v) => [v.version, v.current, v.value, v.writtenBy]), [[2, true, 2, actors.admin.id], [1, false, 1, actors.doctor.id]]);
  assert.equal((await as('admin').get(`/api/cases/${c.id}/history`)).body.rows.length, 2, 'admin sees entered-in-error rows too');
});

test('33c1: rows entered in error, their versions and their reasons are for doctor and admin only', async () => {
  const { c, r1, r2 } = await historyCase();
  for (const role of ['nurse', 'viewer', 'informatician']) {
    const g = await as(role).get(`/api/cases/${c.id}/history`); assert.equal(g.status, 200, role);
    assert.deepEqual(g.body.rows.map((r) => r.rowId), [r1.id], role);
    const txt = JSON.stringify(g.body); assert.ok(!txt.includes(r2.id) && !txt.includes('wrong patient 33c1') && !txt.includes('300'), role + ': nothing of the hidden row');
    assert.equal(g.body.values.length, 1, role);
  }
});

test('33c1: history never returns another case; unknown or malformed ids are 404; reading it writes no audit row', async () => {
  const A = await historyCase(), B = await historyCase(), m = Number((await db.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
  const ha = (await as('admin').get(`/api/cases/${A.c.id}/history`)).body, hb = (await as('admin').get(`/api/cases/${B.c.id}/history`)).body;
  const idsA = ha.rows.map((r) => r.rowId), idsB = hb.rows.map((r) => r.rowId);
  assert.ok(idsA.every((i) => !idsB.includes(i)) && idsA.length === 2 && idsB.length === 2); assert.ok(!JSON.stringify(ha).includes(B.r1.id) && !JSON.stringify(hb).includes(A.r1.id));
  assert.equal((await as('admin').get(`/api/cases/${crypto.randomUUID()}/history`)).status, 404);
  assert.equal((await as('admin').get('/api/cases/not-a-uuid/history')).status, 404);
  assert.equal(Number((await db.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m), m, 'no audit row from reading history');
});
