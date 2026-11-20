'use strict';
// node --test code-systems-route.test.js  (needs DATABASE_URL; creates and drops its own database)
// Phase P, P3a: GET /api/code-systems lists the code systems for every signed-in role, writes nothing and leaves no audit row.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const { seedCodeSystems } = require('./seed.js');
const { CODE_SYSTEMS } = require('./code-systems.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const dbName = 'emr_csr_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, hash;
const who = {};

async function mk(role) {
  await owner.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a_' + role, 'Name ' + role, role, hash]);
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/login').send({ username: 'a_' + role, password: PW })).status, 200);
  agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
  return agent;
}
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
  await seedCodeSystems(owner, CODE_SYSTEMS);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(dbName)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString()); app = createApp({ db: appDb });
  hash = await hashPassword(PW);
  for (const role of P.ROLES) who[role] = await mk(role);
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('P3a: the route is mapped to the existing ref.read action', () => {
  assert.equal(P.ROUTE_ACTIONS['GET /code-systems'], 'ref.read');
});
test('P3a: every role reads the five standard systems with id, uri, name, kind and licenceNote', async () => {
  for (const role of P.ROLES) {
    const r = await who[role].get('/api/code-systems');
    assert.equal(r.status, 200, role);
    assert.deepEqual(r.body.map((x) => x.id), ['icd10', 'icd11', 'loinc', 'snomed', 'ucum'], role);
    assert.deepEqual(Object.keys(r.body[0]).sort(), ['id', 'kind', 'licenceNote', 'name', 'uri'], role);
    assert.ok(r.body.every((x) => x.kind === 'standard' && x.licenceNote));
  }
});
test('P3a: a local system is listed after the standard ones', async () => {
  await owner.query("INSERT INTO code_systems (id,uri,name,kind) VALUES ('aaa-local','urn:local:aaa','Mine','local')");
  const r = await who.nurse.get('/api/code-systems');
  assert.equal(r.body[r.body.length - 1].id, 'aaa-local');
});
test('P3a: reading writes nothing and adds no audit row; signed out is refused', async () => {
  const before = await maxId(), n = Number((await owner.query('SELECT count(*) n FROM code_systems')).rows[0].n);
  await who.viewer.get('/api/code-systems');
  assert.equal((await owner.query("SELECT count(*) n FROM audit_log WHERE id > $1 AND action NOT LIKE 'auth.%'", [before])).rows[0].n, '0');
  assert.equal(Number((await owner.query('SELECT count(*) n FROM code_systems')).rows[0].n), n);
  assert.equal((await request(app).get('/api/code-systems')).status, 401);
});
