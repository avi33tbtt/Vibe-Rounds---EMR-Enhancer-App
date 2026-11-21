'use strict';
// node --test analytics-export.test.js  (needs DATABASE_URL; creates and drops its own database)
// Phase F, F7c: GET /api/analytics/export (action analytics.export: admin and informatician). The only analytics route in the EMR.
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
const dbName = 'emr_aex_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery', SALT = 'test-salt-123456';
let owner, appDb, app, hash, savedSalt;
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
  savedSalt = process.env.EXPORT_SALT; process.env.EXPORT_SALT = SALT;       // read at request time, never from the request
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(dbName)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString()); app = createApp({ db: appDb });
  hash = await hashPassword(PW);
  for (const role of P.ROLES) who[role] = await mk(role);
  assert.equal((await who.doctor.post('/api/cases').send({ narrative: 'F7c test case' })).status, 201);
});
test.after(async () => {
  if (savedSalt === undefined) delete process.env.EXPORT_SALT; else process.env.EXPORT_SALT = savedSalt;
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('F7c: the route is mapped to analytics.export, held by admin and informatician only', () => {
  assert.equal(P.ROUTE_ACTIONS['GET /analytics/export'], 'analytics.export');
  assert.deepEqual([...P.ROLES].filter((r) => P.can({ id: 'x', role: r }, 'analytics.export')).sort(), ['admin', 'informatician']);
});
test('F7c: doctor, nurse and viewer are refused (403); signed out is 401; nothing is audited for a refusal', async () => {
  const before = await n("SELECT count(*) n FROM audit_log WHERE action='analytics.export'");
  for (const role of ['doctor', 'nurse', 'viewer']) assert.equal((await who[role].get('/api/analytics/export')).status, 403, role);
  assert.equal((await request(app).get('/api/analytics/export')).status, 401);
  assert.equal(await n("SELECT count(*) n FROM audit_log WHERE action='analytics.export'"), before);
});
test('F7c: a missing or short salt fails closed (500, no data, no audit row)', async () => {
  const before = await n("SELECT count(*) n FROM audit_log WHERE action='analytics.export'");
  for (const bad of [undefined, 'short']) {
    if (bad === undefined) delete process.env.EXPORT_SALT; else process.env.EXPORT_SALT = bad;
    const r = await who.admin.get('/api/analytics/export');
    assert.equal(r.status, 500); assert.equal(r.body.error.code, 'export_not_configured'); assert.equal(r.body.bundle, undefined);
  }
  process.env.EXPORT_SALT = SALT;
  assert.equal(await n("SELECT count(*) n FROM audit_log WHERE action='analytics.export'"), before);
});
test('F7c: unreadable dates are 400; a salt in the query string is ignored', async () => {
  assert.equal((await who.admin.get('/api/analytics/export?from=nope')).status, 400);
  assert.equal((await who.admin.get('/api/analytics/export?to=nope')).status, 400);
  assert.equal((await who.admin.get('/api/analytics/export?salt=x')).status, 200);
});
test('F7c: admin export writes one audit row with the filter used, and no identifier appears in the response', async () => {
  const before = await n("SELECT count(*) n FROM audit_log WHERE action='analytics.export'");
  const r = await who.admin.get('/api/analytics/export?ward=W1&from=2020-01-01');
  assert.equal(r.status, 200);
  assert.equal(r.body.bundle.resourceType, 'Bundle'); assert.ok(Array.isArray(r.body.manifest.elements));
  const rows = (await owner.query("SELECT after FROM audit_log WHERE action='analytics.export' ORDER BY id DESC")).rows;
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].after.ward, 'W1'); assert.ok(rows[0].after.from.startsWith('2020-01-01'));
  const text = JSON.stringify(r.body);
  const ids = (await owner.query(`SELECT id::text v FROM patients UNION SELECT id::text FROM encounters UNION SELECT id::text FROM cases
    UNION SELECT id::text FROM case_rows UNION SELECT mrn FROM patients WHERE mrn IS NOT NULL UNION SELECT name FROM patients`)).rows;
  for (const x of ids) assert.ok(!text.includes(x.v), 'identifier leaked: ' + x.v);
});
test('F7c: an informatician may export; the export changes no case', async () => {
  const cases = (await owner.query('SELECT id, version, updated_at FROM cases ORDER BY id')).rows;
  assert.equal((await who.informatician.get('/api/analytics/export')).status, 200);
  assert.deepEqual((await owner.query('SELECT id, version, updated_at FROM cases ORDER BY id')).rows, cases);
});
