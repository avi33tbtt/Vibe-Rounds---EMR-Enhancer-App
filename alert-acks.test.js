'use strict';
// node --test alert-acks.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 35b: alert acknowledgements are server records (alert_acks). Real login sessions and the restricted emr_app database role, as in patients.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const dbName = 'emr_ack_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, hash;
const who = {};

async function mk(role) {
  const id = (await owner.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', ['a_' + role, 'Name ' + role, role, hash])).rows[0].id;
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/login').send({ username: 'a_' + role, password: PW })).status, 200);
  agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
  return { id, agent };
}
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
const since = async (id) => (await owner.query("SELECT * FROM audit_log WHERE id > $1 AND action NOT LIKE 'auth.%' ORDER BY id", [id])).rows;
const newCase = async () => (await who.doctor.agent.post('/api/cases').send({})).body;
const ackBody = (o = {}) => ({ ruleId: 'r1', setId: 'care.t', sig: 'r1|>=|38||2026-01-01T00:00:00.000Z|1', ...o });
const ack = (as, id, body) => who[as].agent.post(`/api/cases/${id}/alert-acks`).send(body);

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(dbName)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb });
  hash = await hashPassword(PW);
  for (const role of P.ROLES) who[role] = await mk(role);
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('35b: an acknowledgement is stamped with the session user and time, writes exactly one audit row, and the case reads it back', async () => {
  const cs = await newCase(), before = await maxId();
  const r = await ack('nurse', cs.id, ackBody());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.byName, 'Name nurse'); assert.equal(r.body.by, who.nurse.id); assert.equal(r.body.source, 'user'); assert.ok(!Number.isNaN(Date.parse(r.body.ackedAt)));
  const rows = await since(before);
  assert.equal(rows.length, 1); assert.equal(rows[0].action, 'alert.ack'); assert.equal(rows[0].entity, 'alert_ack'); assert.equal(rows[0].user_id, who.nurse.id); assert.equal(rows[0].role, 'nurse'); assert.ok(rows[0].ip);
  assert.deepEqual(rows[0].after, { setId: 'care.t', ruleId: 'r1' });   // ids only: the sig carries reading values and is not audited
  const g = (await who.viewer.agent.get('/api/cases/' + cs.id)).body;
  assert.equal(g.alertLog.length, 1); assert.deepEqual({ ...g.alertLog[0], id: 0, ackedAt: 0 }, { id: 0, ruleId: 'r1', setId: 'care.t', sig: ackBody().sig, ackedAt: 0, by: who.nurse.id, byName: 'Name nurse', source: 'user' });
  assert.equal(g.version, cs.version, 'acknowledging does not change the case version');
  assert.deepEqual((await who.viewer.agent.get(`/api/cases/${cs.id}/alert-acks`)).body.map((x) => x.ruleId), ['r1']);
});

test('35b: a second person acknowledging the same alert gets the first record (200, their name shown, nothing written); a new sig is a new acknowledgement', async () => {
  const cs = await newCase();
  assert.equal((await ack('nurse', cs.id, ackBody())).status, 201);
  const before = await maxId(), again = await ack('doctor', cs.id, ackBody());
  assert.equal(again.status, 200); assert.equal(again.body.byName, 'Name nurse'); assert.equal(again.body.by, who.nurse.id);
  assert.equal((await since(before)).length, 0, 'no audit row and no new record for a repeat');
  assert.equal(Number((await owner.query('SELECT count(*) n FROM alert_acks WHERE case_id=$1', [cs.id])).rows[0].n), 1);
  const b2 = await maxId(), changed = await ack('doctor', cs.id, ackBody({ sig: 'r1|>=|39||2026-01-02T00:00:00.000Z|1' }));
  assert.equal(changed.status, 201); assert.equal(changed.body.byName, 'Name doctor'); assert.equal((await since(b2)).length, 1);
  const log = (await who.nurse.agent.get('/api/cases/' + cs.id)).body.alertLog;
  assert.deepEqual(log.map((x) => x.byName), ['Name nurse', 'Name doctor'], 'oldest first');
  // the same sig on another case or for another rule is independent
  const other = await newCase(); assert.equal((await ack('doctor', other.id, ackBody())).status, 201); assert.equal((await ack('doctor', cs.id, ackBody({ ruleId: 'r2' }))).status, 201);
});

test('35b: who may acknowledge: admin, doctor, nurse; viewer and informatician get 403 and nothing is written; bad input and unknown cases are refused', async () => {
  const cs = await newCase();
  for (const role of ['viewer', 'informatician']) { const b = await maxId(); assert.equal((await ack(role, cs.id, ackBody())).status, 403, role); assert.equal((await since(b)).length, 0); }
  assert.equal((await ack('admin', cs.id, ackBody({ sig: 'admin-sig' }))).status, 201);
  assert.equal((await request(app).post(`/api/cases/${cs.id}/alert-acks`).send(ackBody())).status, 401);
  assert.equal((await ack('doctor', cs.id, ackBody({ ruleId: 'bad id' }))).status, 400);
  assert.equal((await ack('doctor', cs.id, ackBody({ sig: '' }))).status, 400);
  assert.equal((await ack('doctor', cs.id, { ...ackBody(), userId: who.admin.id })).status, 400, 'who and when can never be sent');
  assert.equal((await ack('doctor', cs.id, { ...ackBody(), ackedAt: '2020-01-01T00:00:00Z' })).status, 400);
  assert.equal((await ack('doctor', crypto.randomUUID(), ackBody())).status, 404); assert.equal((await ack('doctor', 'nope', ackBody())).status, 404);
  assert.equal((await who.doctor.agent.get(`/api/cases/${crypto.randomUUID()}/alert-acks`)).status, 404);
});

test('35b: the case PATCH no longer takes alertLog (400), so a client cannot write acknowledgements as case data or as someone else', async () => {
  const cs = await newCase();
  const r = await who.nurse.agent.patch('/api/cases/' + cs.id).send({ expectedVersion: cs.version, alertLog: [{ ruleId: 'r1', ackedAt: new Date().toISOString() }] });
  assert.equal(r.status, 400);
  assert.equal((await who.nurse.agent.patch('/api/cases/' + cs.id).send({ expectedVersion: cs.version, pinned: [] })).status, 200, 'a nurse can still change the quick bar');
});

test('35b: acknowledgements are append-only: not even the owner can change or delete one, and the app role has no right to', async () => {
  const cs = await newCase(); assert.equal((await ack('doctor', cs.id, ackBody())).status, 201);
  await assert.rejects(owner.query('UPDATE alert_acks SET sig=$1 WHERE case_id=$2', ['x', cs.id]), /append-only/);
  await assert.rejects(owner.query('DELETE FROM alert_acks WHERE case_id=$1', [cs.id]), /append-only/);
  await assert.rejects(appDb.query('DELETE FROM alert_acks WHERE case_id=$1', [cs.id]), /permission denied|append-only/);
  await assert.rejects(appDb.query('UPDATE alert_acks SET sig=$1 WHERE case_id=$2', ['x', cs.id]), /permission denied|append-only/);
  assert.equal(Number((await owner.query('SELECT count(*) n FROM alert_acks WHERE case_id=$1', [cs.id])).rows[0].n), 1);
});

test('35b: import turns a browser alertLog into imported acknowledgements with no user (duplicates once, a bad time becomes now); the old column stays empty', async () => {
  const id = crypto.randomUUID(), t0 = '2026-01-05T10:00:00.000Z';
  const log = [{ ruleId: 'r1', setId: 'care.t', ackedAt: t0, sig: 's1' }, { ruleId: 'r1', setId: 'care.t', ackedAt: '2026-01-06T00:00:00.000Z', sig: 's1' }, { ruleId: 'r2', setId: 'care.t', ackedAt: 'not a time', sig: 's2' }];
  const r = await who.admin.agent.post('/api/import').send({ cases: [{ id, patient: { name: 'Demo', ageSex: '', bed: '', mrn: '' }, narrative: 'n', applied: [], pathways: [], values: {}, notes: [], alertLog: log }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const caseId = (await owner.query('SELECT id, alert_log FROM cases WHERE legacy_id=$1 OR id=$1::uuid', [id])).rows[0];
  assert.deepEqual(caseId.alert_log, []);
  const g = (await who.doctor.agent.get('/api/cases/' + caseId.id)).body.alertLog;
  assert.equal(g.length, 2); assert.ok(g.every((x) => x.source === 'imported' && x.by === null && x.byName === null));
  const s1 = g.find((x) => x.sig === 's1'); assert.equal(s1.ackedAt, t0, 'the first of two duplicates is kept with its original time');
  assert.ok(Math.abs(Date.now() - Date.parse(g.find((x) => x.sig === 's2').ackedAt)) < 60000, 'an unreadable time becomes the import time');
});
