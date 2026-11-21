'use strict';
// node --test elements-routes.test.js  (needs DATABASE_URL; creates and drops its own database)
// Phase F, F5: GET /api/elements/index (ref.read) and GET /api/cases/:id/elements (case.read) are read-only.
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
const dbName = 'emr_elr_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, hash, caseId;
const who = {};

async function mk(role) {
  await owner.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a_' + role, 'Name ' + role, role, hash]);
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/login').send({ username: 'a_' + role, password: PW })).status, 200);
  agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
  return agent;
}
const n = async (sql, p) => Number((await owner.query(sql, p)).rows[0].n);

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(dbName)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString()); app = createApp({ db: appDb });
  hash = await hashPassword(PW);
  for (const role of P.ROLES) who[role] = await mk(role);
  const c = await who.doctor.post('/api/cases').send({ narrative: 'F5 test case' });
  assert.equal(c.status, 201); caseId = c.body.id;
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('F5: routes are mapped to ref.read and case.read', () => {
  assert.equal(P.ROUTE_ACTIONS['GET /elements/index'], 'ref.read');
  assert.equal(P.ROUTE_ACTIONS['GET /cases/:id/elements'], 'case.read');
});
test('F5: every role reads the index; the registration core comes last and is not a recording set', async () => {
  for (const role of P.ROLES) {
    const r = await who[role].get('/api/elements/index');
    assert.equal(r.status, 200, role);
    const last = r.body.sets[r.body.sets.length - 1];
    assert.equal(last.setId, 'core.registration'); assert.equal(last.recording, false);
    assert.ok(last.provides.length > 0);
  }
});
test('F5: nurse and viewer read a case\'s element rows', async () => {
  for (const role of ['nurse', 'viewer']) {
    const r = await who[role].get(`/api/cases/${caseId}/elements`);
    assert.equal(r.status, 200, role);
    assert.equal(r.body.caseId, caseId); assert.ok(Array.isArray(r.body.elements));
  }
});
test('F5: an unknown case is 404; signed out is 401', async () => {
  assert.equal((await who.nurse.get('/api/cases/00000000-0000-4000-8000-000000000000/elements')).status, 404);
  assert.equal((await request(app).get('/api/elements/index')).status, 401);
  assert.equal((await request(app).get(`/api/cases/${caseId}/elements`)).status, 401);
});
test('F5: reading writes nothing: the index adds no audit row, the case read adds at most one view row, no case or row changes', async () => {
  const maxId = await n('SELECT coalesce(max(id),0) n FROM audit_log');
  const cases = await owner.query('SELECT version, updated_at FROM cases WHERE id=$1', [caseId]);
  const rows = await n('SELECT count(*) n FROM case_rows');
  await who.doctor.get('/api/elements/index');
  assert.equal(await n("SELECT count(*) n FROM audit_log WHERE id > $1 AND action NOT LIKE 'auth.%'", [maxId]), 0);
  await who.doctor.get(`/api/cases/${caseId}/elements`);
  await who.doctor.get(`/api/cases/${caseId}/elements`);
  const added = (await owner.query("SELECT action FROM audit_log WHERE id > $1 AND action NOT LIKE 'auth.%'", [maxId])).rows;
  assert.ok(added.length <= 1 && added.every((x) => x.action === 'view'), JSON.stringify(added));
  assert.deepEqual((await owner.query('SELECT version, updated_at FROM cases WHERE id=$1', [caseId])).rows, cases.rows);
  assert.equal(await n('SELECT count(*) n FROM case_rows'), rows);
});
