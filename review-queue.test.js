'use strict';
// node --test review-queue.test.js  (needs DATABASE_URL; creates and drops its own database)
// 44a1b: GET /api/review-requests, the review queue. Made-up set ids only. Runs as the restricted emr_app role, like review-requests.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { ROUTE_ACTIONS, can } = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_rq_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['rq-' + role, 'RQ ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const llm = { name: 'mock', model: 'mock-1', complete: async () => '{}' };
const ACC = { view: ['admin'], enter: ['admin'], amend: ['admin'], approve: ['admin'], configure: ['admin'], export: ['admin'] };   // same shape as review-requests.test.js
const post = (u, b, role) => { const q = request(app).post(u); if (role) q.set('x-test-role', role); return q.send(b); };
const get = (u, role) => { const q = request(app).get(u); if (role) q.set('x-test-role', role); return q; };
const submit = async (setId, title, role = 'doctor') => {
  assert.equal((await post('/api/element-sets', { setId, kind: 'custom', body: { title, access: ACC } })).status, 201, setId);
  const r = await post('/api/review-requests', { setId, version: 1 }, role);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
};
const ids = (r) => r.body.requests.map((x) => x.setId);

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${pw}'`);
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = pw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb, getActor, llm });
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('the route is registered with content.review, so only admin and informatician are allowed by the table', () => {
  assert.equal(ROUTE_ACTIONS['GET /review-requests'], 'content.review');
  for (const role of ['admin', 'informatician']) assert.equal(can({ role }, 'content.review'), true, role);
  for (const role of ['doctor', 'nurse', 'viewer']) assert.equal(can({ role }, 'content.review'), false, role);
});

test('an empty queue is an empty list (200)', async () => {
  const r = await get('/api/review-requests');
  assert.equal(r.status, 200); assert.deepEqual(r.body, { requests: [] });
});

test('roles: doctor, nurse and viewer are refused (403); informatician and admin may read', async () => {
  for (const role of ['doctor', 'nurse', 'viewer']) assert.equal((await get('/api/review-requests', role)).status, 403, role);
  for (const role of ['informatician', 'admin']) assert.equal((await get('/api/review-requests', role)).status, 200, role);
});

test('only open requests are listed: submitted, in_review and changes_requested; not draft, approved, rejected or withdrawn', async () => {
  const q = {};
  for (const k of ['sub', 'rev', 'chg', 'apr', 'rej', 'drf', 'wdr']) q[k] = await submit('user.q_' + k, 'Title ' + k);
  await owner.query("UPDATE review_requests SET status='in_review' WHERE id=$1", [q.rev]);
  await owner.query("UPDATE review_requests SET status='changes_requested' WHERE id=$1", [q.chg]);
  await owner.query("UPDATE review_requests SET status='approved' WHERE id=$1", [q.apr]);
  await owner.query("UPDATE review_requests SET status='rejected' WHERE id=$1", [q.rej]);
  await owner.query("UPDATE review_requests SET status='draft' WHERE id=$1", [q.drf]);
  // withdrawn the real way (43b4): saving a newer version of a set with a waiting request
  assert.equal((await post('/api/element-sets', { setId: 'user.q_wdr', kind: 'custom', body: { title: 'Title wdr 2', access: ACC }, expectedVersion: 1 })).status, 201);
  assert.equal((await owner.query('SELECT status FROM review_requests WHERE id=$1', [q.wdr])).rows[0].status, 'withdrawn');
  const r = await get('/api/review-requests', 'informatician');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r).sort(), ['user.q_chg', 'user.q_rev', 'user.q_sub']);
  assert.deepEqual(r.body.requests.map((x) => x.status).sort(), ['changes_requested', 'in_review', 'submitted']);
});

test('each item carries id, set id, version, kind, title, status, hash, author and time; no body', async () => {
  const r = await get('/api/review-requests');
  const x = r.body.requests.find((y) => y.setId === 'user.q_sub');
  assert.ok(x);
  assert.match(x.id, /^[0-9a-f-]{36}$/); assert.equal(x.version, 1); assert.equal(x.kind, 'custom'); assert.equal(x.title, 'Title sub');
  assert.equal(x.status, 'submitted'); assert.match(x.contentHash, /^sha256:/);
  assert.equal(x.authorId, actors.doctor.id); assert.equal(x.authorName, 'RQ doctor'); assert.equal(x.reviewerId, null);
  assert.ok(!Number.isNaN(Date.parse(x.submittedAt)));
  assert.deepEqual(Object.keys(x).sort(), ['authorId', 'authorName', 'contentHash', 'id', 'kind', 'reviewerId', 'setId', 'status', 'submittedAt', 'title', 'version']);
});

test('the list is oldest first', async () => {
  await owner.query("UPDATE review_requests SET submitted_at = '2026-01-03T00:00:00Z' WHERE set_id='user.q_sub'");
  await owner.query("UPDATE review_requests SET submitted_at = '2026-01-01T00:00:00Z' WHERE set_id='user.q_chg'");
  await owner.query("UPDATE review_requests SET submitted_at = '2026-01-02T00:00:00Z' WHERE set_id='user.q_rev'");
  assert.deepEqual(ids(await get('/api/review-requests')), ['user.q_chg', 'user.q_rev', 'user.q_sub']);
});

test('?status filters to one open status; anything else is 400', async () => {
  assert.deepEqual(ids(await get('/api/review-requests?status=in_review')), ['user.q_rev']);
  assert.deepEqual(ids(await get('/api/review-requests?status=submitted')), ['user.q_sub']);
  assert.deepEqual(ids(await get('/api/review-requests?status=changes_requested')), ['user.q_chg']);
  for (const bad of ['status=approved', 'status=withdrawn', 'status=bogus', 'status=', 'x=1', 'status=submitted&status=in_review']) assert.equal((await get('/api/review-requests?' + bad)).status, 400, bad);
});

test('reading the queue writes no audit row and changes no request', async () => {
  const au = async () => Number((await owner.query('SELECT count(*) n FROM audit_log')).rows[0].n);
  const rr = async () => (await owner.query('SELECT id, status, submitted_at FROM review_requests ORDER BY id')).rows;
  const a0 = await au(), r0 = JSON.stringify(await rr());
  assert.equal((await get('/api/review-requests')).status, 200);
  assert.equal((await get('/api/review-requests', 'doctor')).status, 403);
  assert.equal(await au(), a0); assert.equal(JSON.stringify(await rr()), r0);
});

test('an author who is also an informatician sees their own request in the queue (listing is not reviewing)', async () => {
  const id = await submit('user.q_own', 'Own', 'informatician');
  const x = (await get('/api/review-requests', 'informatician')).body.requests.find((y) => y.id === id);
  assert.ok(x); assert.equal(x.authorId, actors.informatician.id);   // the author rule is enforced when reviewing (44a2d), not when listing
});
