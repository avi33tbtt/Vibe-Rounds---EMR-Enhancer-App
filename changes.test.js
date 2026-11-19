'use strict';
// node --test changes.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 37a: GET /api/cases/:id/changes (live refresh) and the client-made row id on POST /api/cases/:id/rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_chg_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let db, app;
const actors = {};
async function getActor(req) {            // TEST-ONLY actor: an admin unless the request sends x-test-role
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await db.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['test-' + role, 'Test ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const api = () => request(app);
const as = (role) => ({ get: (u) => api().get(u).set('x-test-role', role), post: (u) => api().post(u).set('x-test-role', role) });
const newCase = async () => (await api().post('/api/cases').send({})).body;
const addRow = (id, hr, extra = {}) => api().post(`/api/cases/${id}/rows`).send({ setId: 'care.vitals', groupId: 'vit', row: { hr }, ...extra });
const auditCount = async (action) => +(await db.query('SELECT count(*) n FROM audit_log WHERE action=$1', [action])).rows[0].n;
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name));
  await migrate(db, __dirname);
  app = createApp({ db, getActor });
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('37a: a row can carry a client-made id; sending it again returns the stored row and adds nothing', async () => {
  const c = await newCase(), rid = crypto.randomUUID();
  const first = await addRow(c.id, 70, { id: rid });
  assert.equal(first.status, 201); assert.equal(first.body.id, rid);
  const before = await auditCount('row.add');
  const again = await addRow(c.id, 99, { id: rid });                       // a lost reply, re-sent: the stored row wins, the new text is NOT written
  assert.equal(again.status, 200); assert.equal(again.body.id, rid); assert.deepEqual(again.body.row, { hr: 70 });
  assert.equal(await auditCount('row.add'), before);
  assert.equal((await api().get('/api/cases/' + c.id)).body.values['care.vitals/@vit'].length, 1);
  const other = await newCase();
  assert.equal((await addRow(other.id, 70, { id: rid })).status, 409);       // the id belongs to another case: never moved, never merged
  assert.equal((await addRow(c.id, 70, { id: 'not-a-uuid' })).status, 400);
});

test('37a: GET /cases/:id carries asOf, a time to pass back as ?since=', async () => {
  const c = await newCase(), g = (await api().get('/api/cases/' + c.id)).body;
  assert.ok(!Number.isNaN(Date.parse(g.asOf)));
  assert.ok(Date.parse(g.asOf) <= Date.now() + 1000);
});

test('37a: changes after a time: rows, values, notes, acknowledgements, and who changed them last', async () => {
  const c = await newCase(), since = ago(60);
  const row = (await addRow(c.id, 71)).body;
  await api().put(`/api/cases/${c.id}/values`).send({ key: 'care.vitals/__ref', value: { x: 1 }, expectedVersion: 0 });
  const note = (await api().post(`/api/cases/${c.id}/notes`).send({ type: 'narrative', text: 'first' })).body;
  await api().post(`/api/cases/${c.id}/alert-acks`).send({ ruleId: 'r1', setId: 'care.vitals', sig: 's1' });
  const r = await as('doctor').get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(since)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, false);
  assert.deepEqual(r.body.rows.map((x) => [x.id, x.row.hr, x.version]), [[row.id, 71, 1]]);
  assert.deepEqual(r.body.values.map((x) => [x.key, x.value, x.version]), [['care.vitals/__ref', { x: 1 }, 1]]);
  assert.deepEqual(r.body.notes.map((x) => [x.id, x.text, x.status]), [[note.id, 'first', 'draft']]);
  assert.deepEqual(r.body.acks.map((x) => [x.ruleId, x.sig]), [['r1', 's1']]);
  assert.equal(r.body.latest.byName, 'Test admin');                          // the doctor asks, the admin wrote
  assert.equal((await as('admin').get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(since)}`)).body.latest, null);   // your own changes are not "updated by someone"
  assert.ok(!Number.isNaN(Date.parse(r.body.cursor)));
});

test('37a: nothing after the cursor; a later change shows up on the next call only', async () => {
  const c = await newCase(); await addRow(c.id, 60);
  const one = (await api().get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(ago(60))}`)).body;
  assert.equal(one.rows.length, 1);
  const quiet = (await api().get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(new Date(Date.now() + 5000).toISOString())}`)).body;
  assert.deepEqual([quiet.rows, quiet.values, quiet.notes, quiet.acks], [[], [], [], []]);
  await addRow(c.id, 61);
  const two = (await api().get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(one.cursor)}`)).body;   // the cursor overlaps a little: the first row may come again, with the same version
  assert.ok(two.rows.some((x) => x.row.hr === 61));
  assert.ok(two.rows.every((x) => x.version === 1));
});

test('37a: an amended row, an edited draft note and a signed note come back with their new versions', async () => {
  const c = await newCase(), since = ago(60);
  const row = (await addRow(c.id, 70)).body;
  await api().patch(`/api/cases/${c.id}/rows/${row.id}`).send({ expectedVersion: 1, row: { hr: 75 }, reason: 'typo fixed' });
  const n = (await api().post(`/api/cases/${c.id}/notes`).send({ type: 'narrative', text: 'a' })).body;
  await api().patch(`/api/cases/${c.id}/notes/${n.id}`).send({ expectedVersion: 1, text: 'b' });
  let ch = (await api().get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(since)}`)).body;
  assert.deepEqual(ch.rows.map((x) => [x.row.hr, x.version]), [[75, 2]]);
  assert.deepEqual(ch.notes.map((x) => [x.text, x.version]), [['b', 2]]);
  await api().post(`/api/cases/${c.id}/notes/${n.id}/sign`).send({ expectedVersion: 2 });
  ch = (await api().get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(since)}`)).body;
  assert.deepEqual(ch.notes.map((x) => [x.status, x.version, x.signedByName]), [['signed', 3, 'Test admin']]);
  const old = await db.query('SELECT updated_at >= created_at AS ok FROM case_notes WHERE id=$1', [n.id]);
  assert.equal(old.rows[0].ok, true);
});

test('37a: the case record is sent only when its version moved past ?caseVersion', async () => {
  const c = await newCase(), since = encodeURIComponent(ago(60));
  assert.equal((await api().get(`/api/cases/${c.id}/changes?since=${since}&caseVersion=1`)).body.case, null);
  await api().patch('/api/cases/' + c.id).send({ expectedVersion: 1, narrative: 'changed' });
  const ch = (await api().get(`/api/cases/${c.id}/changes?since=${since}&caseVersion=1`)).body;
  assert.equal(ch.case.version, 2); assert.equal(ch.case.narrative, 'changed');
  assert.equal((await api().get(`/api/cases/${c.id}/changes?since=${since}&caseVersion=2`)).body.case, null);
  assert.ok((await api().get(`/api/cases/${c.id}/changes?since=${since}`)).body.case);      // no version given: send it
});

test('37a: rows entered in error come back without their content unless the caller may see them', async () => {
  const c = await newCase(), since = encodeURIComponent(ago(60));
  const row = (await addRow(c.id, 88)).body;
  await api().post(`/api/cases/${c.id}/rows/${row.id}/error`).send({ expectedVersion: 1, reason: 'wrong patient' });
  const nurse = (await as('nurse').get(`/api/cases/${c.id}/changes?since=${since}`)).body.rows[0];
  assert.deepEqual(Object.keys(nurse).sort(), ['changedAt', 'groupId', 'id', 'setId', 'status', 'version']);
  assert.equal(nurse.status, 'entered_in_error');
  const doc = (await as('doctor').get(`/api/cases/${c.id}/changes?since=${since}`)).body.rows[0];
  assert.equal(doc.errorReason, 'wrong patient'); assert.equal(doc.row.hr, 88);
});

test('37a: an informatician gets no patient identity; every role may poll; polling writes no audit row', async () => {
  const c = await newCase(), url = `/api/cases/${c.id}/changes?since=${encodeURIComponent(ago(60))}`;
  const before = +(await db.query('SELECT count(*) n FROM audit_log')).rows[0].n;
  for (const role of ['admin', 'doctor', 'nurse', 'viewer', 'informatician']) assert.equal((await as(role).get(url)).status, 200, role);
  const inf = (await as('informatician').get(url)).body.case;
  assert.equal(inf.patientRecord, null); assert.equal(inf.encounterRecord, null);
  assert.equal(+(await db.query('SELECT count(*) n FROM audit_log')).rows[0].n, before);
});

test('37a: bad input is refused: missing or malformed since, unknown or malformed case', async () => {
  const c = await newCase();
  assert.equal((await api().get(`/api/cases/${c.id}/changes`)).status, 400);
  assert.equal((await api().get(`/api/cases/${c.id}/changes?since=yesterday`)).status, 400);
  assert.equal((await api().get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(ago(5))}&caseVersion=x`)).status, 400);
  assert.equal((await api().get(`/api/cases/${c.id}/changes?since=${encodeURIComponent(ago(5))}&other=1`)).status, 400);
  assert.equal((await api().get(`/api/cases/${crypto.randomUUID()}/changes?since=${encodeURIComponent(ago(5))}`)).status, 404);
  assert.equal((await api().get(`/api/cases/not-a-uuid/changes?since=${encodeURIComponent(ago(5))}`)).status, 404);
});

test('37a: changes never include another case', async () => {
  const a = await newCase(), b = await newCase(); await addRow(a.id, 1); await addRow(b.id, 2);
  const ch = (await api().get(`/api/cases/${a.id}/changes?since=${encodeURIComponent(ago(60))}`)).body;
  assert.deepEqual(ch.rows.map((x) => x.row.hr), [1]);
});
