'use strict';
// node --test review-request-get.test.js  (needs DATABASE_URL; creates and drops its own database)
// 44a1c: GET /api/review-requests/:id. The server reads the stored version and lints it again. Made-up set ids only. Runs as the restricted emr_app role.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { ROUTE_ACTIONS } = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_rg_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['rg-' + role, 'RG ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const llm = { name: 'mock', model: 'mock-1', complete: async () => '{}' };
const ACC = { view: ['admin'], enter: ['admin'], amend: ['admin'], approve: ['admin'], configure: ['admin'], export: ['admin'] };   // same shape as review-requests.test.js
const post = (u, b, role) => { const q = request(app).post(u); if (role) q.set('x-test-role', role); return q.send(b); };
const get = (u, role) => { const q = request(app).get(u); if (role) q.set('x-test-role', role); return q; };
const save = (setId, body) => post('/api/element-sets', { setId, kind: 'custom', body });
const one = (id, role) => get('/api/review-requests/' + id, role);
let okId;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${pw}'`);
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = pw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb, getActor, llm });
  assert.equal((await save('user.ok', { title: 'Ok', access: ACC })).status, 201);
  const r = await post('/api/review-requests', { setId: 'user.ok', version: 1 }, 'doctor');
  assert.equal(r.status, 201, JSON.stringify(r.body)); okId = r.body.id;
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('the route is registered with content.review', () => {
  assert.equal(ROUTE_ACTIONS['GET /review-requests/:id'], 'content.review');
});

test('roles: doctor, nurse and viewer are refused (403); informatician and admin may read', async () => {
  for (const role of ['doctor', 'nurse', 'viewer']) assert.equal((await one(okId, role)).status, 403, role);
  for (const role of ['informatician', 'admin']) assert.equal((await one(okId, role)).status, 200, role);
});

test('a request is returned with its stored version, hash check, server lint and events', async () => {
  const r = await one(okId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.request.id, okId); assert.equal(r.body.request.setId, 'user.ok'); assert.equal(r.body.request.version, 1);
  assert.equal(r.body.request.status, 'submitted'); assert.equal(r.body.request.authorId, actors.doctor.id); assert.equal(r.body.request.authorName, 'RG doctor');
  assert.equal(r.body.request.reviewerId, null); assert.equal(r.body.request.decidedAt, null);
  assert.equal(r.body.set.setId, 'user.ok'); assert.equal(r.body.set.version, 1); assert.equal(r.body.set.body.title, 'Ok');
  assert.match(r.body.set.contentHash, /^sha256:/); assert.equal(r.body.hashMatches, true);
  assert.deepEqual(r.body.lint.errors, []); assert.ok(Array.isArray(r.body.lint.warnings));
  assert.equal(r.body.events.length, 1); assert.equal(r.body.events[0].event, 'submitted'); assert.equal(r.body.events[0].userId, actors.doctor.id);
});

test('unknown or malformed id is 404', async () => {
  assert.equal((await one(crypto.randomUUID())).status, 404);
  assert.equal((await one('not-an-id')).status, 404);
});

test('the server lints again: a request for a version with problems shows the errors (the client is not trusted)', async () => {
  assert.equal((await save('user.bad', { title: 'Bad', sections: [{ fields: [{ id: 'f', label: 'F', type: 'magic' }] }], access: ACC })).status, 201);
  const h = (await owner.query("SELECT content_hash FROM element_sets WHERE set_id='user.bad' AND version=1")).rows[0].content_hash;
  const id = (await owner.query("INSERT INTO review_requests (set_id, set_version, author_id, status, content_hash, submitted_at) VALUES ('user.bad',1,$1,'submitted',$2,now()) RETURNING id", [actors.doctor.id, h])).rows[0].id;   // made straight in the database: the submit route would refuse it
  const r = await one(id);
  assert.equal(r.status, 200);
  assert.ok(r.body.lint.errors.some((e) => e.code === 'unknown_field_type'), JSON.stringify(r.body.lint.errors));
  assert.equal(r.body.hashMatches, true);
});

test('hashMatches is false when the stored version no longer has the hash recorded at submission', async () => {
  await owner.query("UPDATE review_requests SET content_hash='sha256:other' WHERE id=$1", [okId]);
  assert.equal((await one(okId)).body.hashMatches, false);
  await owner.query("UPDATE review_requests SET content_hash=(SELECT content_hash FROM element_sets WHERE set_id='user.ok' AND version=1) WHERE id=$1", [okId]);
  assert.equal((await one(okId)).body.hashMatches, true);
});

test('a decided or withdrawn request can still be read', async () => {
  for (const st of ['approved', 'rejected', 'withdrawn']) {
    await owner.query('UPDATE review_requests SET status=$2 WHERE id=$1', [okId, st]);
    const r = await one(okId);
    assert.equal(r.status, 200, st); assert.equal(r.body.request.status, st);
  }
  await owner.query("UPDATE review_requests SET status='submitted' WHERE id=$1", [okId]);
});

test('reading a request writes no audit row and changes nothing', async () => {
  const au = async () => Number((await owner.query('SELECT count(*) n FROM audit_log')).rows[0].n);
  const state = async () => JSON.stringify((await owner.query('SELECT * FROM review_requests ORDER BY id')).rows) + JSON.stringify((await owner.query('SELECT * FROM review_events ORDER BY id')).rows);
  const a0 = await au(), s0 = await state();
  assert.equal((await one(okId)).status, 200); assert.equal((await one(okId, 'doctor')).status, 403);
  assert.equal(await au(), a0); assert.equal(await state(), s0);
});
