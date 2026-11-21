'use strict';
// node --test review-requests.test.js  (needs DATABASE_URL; creates and drops its own database)
// 43b3: POST /api/review-requests. Made-up set ids only. Runs as the restricted emr_app role, like audit.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_rr_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['rr-' + role, 'RR ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const llm = { name: 'mock', model: 'mock-1', complete: async () => '{}' };
const ACC = { view: ['admin'], enter: ['admin'], amend: ['admin'], approve: ['admin'], configure: ['admin'], export: ['admin'] };   // shape from VIEWS.md; adjust if validateAccess wants another
const post = (u, b, role) => { const q = request(app).post(u); if (role) q.set('x-test-role', role); return q.send(b); };
const save = (setId, body) => post('/api/element-sets', { setId, kind: 'custom', body });
const count = async () => Number((await owner.query('SELECT count(*) n FROM review_requests')).rows[0].n);
const auditRows = async () => (await owner.query("SELECT * FROM audit_log WHERE action='review.submit' ORDER BY id")).rows;

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

test('a valid saved version is submitted: one row, one audit row, author from the session', async () => {
  assert.equal((await save('user.ok', { title: 'Ok', access: ACC })).status, 201);
  const r = await post('/api/review-requests', { setId: 'user.ok', version: 1 }, 'doctor');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'submitted');
  const row = (await owner.query('SELECT * FROM review_requests WHERE id=$1', [r.body.id])).rows[0];
  assert.equal(row.author_id, actors.doctor.id);
  const ev = (await owner.query('SELECT * FROM review_events WHERE request_id=$1', [r.body.id])).rows;
  assert.equal(ev.length, 1); assert.equal(ev[0].event, 'submitted'); assert.equal(ev[0].user_id, actors.doctor.id);
  assert.match(row.content_hash, /^sha256:/);
  const a = (await auditRows()).filter((x) => x.entity_id === r.body.id);
  assert.equal(a.length, 1); assert.equal(a[0].user_id, actors.doctor.id);
});

test('a body key that names the author is refused (400): the author comes from the session', async () => {
  const r = await post('/api/review-requests', { setId: 'user.ok', version: 1, submittedBy: actors.admin.id });
  assert.equal(r.status, 400);
});

test('the same version cannot be submitted twice while it waits (409 already_submitted)', async () => {
  const n = await count(), r = await post('/api/review-requests', { setId: 'user.ok', version: 1 });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'already_submitted');
  assert.equal(await count(), n);
});

test('an old version is refused (409 conflict) and nothing is stored', async () => {
  assert.equal((await save('user.two', { title: 'T', access: ACC })).status, 201);
  assert.equal((await post('/api/element-sets', { setId: 'user.two', kind: 'custom', body: { title: 'T2', access: ACC }, expectedVersion: 1 })).status, 201);
  const n = await count(), r = await post('/api/review-requests', { setId: 'user.two', version: 1 });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'conflict');
  assert.equal(await count(), n);
});

test('lint errors are refused (422) and nothing is stored or audited', async () => {
  assert.equal((await save('user.bad', { title: 'Bad', sections: [{ fields: [{ id: 'f', label: 'F', type: 'magic' }] }], access: ACC })).status, 201);
  const n = await count(), au = (await auditRows()).length, r = await post('/api/review-requests', { setId: 'user.bad', version: 1 });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'lint_failed');
  assert.equal(await count(), n); assert.equal((await auditRows()).length, au);
});

test('unknown set is 404; a read-only (not user) set is 403', async () => {
  assert.equal((await post('/api/review-requests', { setId: 'user.nope', version: 1 })).status, 404);
  await owner.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier,content_hash) VALUES ('mk.ro',1,'custom','{}','marketplace',true,'marketplace-verified','sha256:x')`);
  assert.equal((await post('/api/review-requests', { setId: 'mk.ro', version: 1 })).status, 403);
});

test('roles: nurse and viewer are refused (403); doctor, informatician and admin may submit', async () => {
  for (const role of ['nurse', 'viewer']) assert.equal((await post('/api/review-requests', { setId: 'user.two', version: 2 }, role)).status, 403, role);
  assert.equal((await post('/api/review-requests', { setId: 'user.two', version: 2 }, 'informatician')).status, 201);
});

test('a request cannot be reviewed by its author: the table refuses reviewer = author', async () => {
  const id = (await owner.query("SELECT id FROM review_requests LIMIT 1")).rows[0].id, au = (await owner.query('SELECT author_id FROM review_requests WHERE id=$1', [id])).rows[0].author_id;
  await assert.rejects(owner.query('UPDATE review_requests SET reviewer_id=$2 WHERE id=$1', [id, au]), /violates check constraint/);
});
