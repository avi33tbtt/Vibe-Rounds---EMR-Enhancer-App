'use strict';
// node --test review-approve.test.js  (needs DATABASE_URL; creates and drops its own database)
// 44a2a: POST /api/review-requests/:id/approve. Made-up set ids only. Runs as the restricted emr_app role (needs 015_review_approve.sql).
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
const name = 'emr_ap_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['ap-' + role, 'AP ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const llm = { name: 'mock', model: 'mock-1', complete: async () => '{}' };
const ACC = { view: ['admin'], enter: ['admin'], amend: ['admin'], approve: ['admin'], configure: ['admin'], export: ['admin'] };   // same shape as review-requests.test.js
const post = (u, b, role) => { const q = request(app).post(u); if (role) q.set('x-test-role', role); return q.send(b); };
const save = (setId, body, extra = {}) => post('/api/element-sets', { setId, kind: 'custom', body, ...extra });
const approve = (id, role = 'informatician', body = {}) => post(`/api/review-requests/${id}/approve`, body, role);
// save a valid set and submit it through the real route
const submit = async (setId, role = 'doctor') => {
  assert.equal((await save(setId, { title: setId, access: ACC })).status, 201, setId);
  const r = await post('/api/review-requests', { setId, version: 1 }, role);
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id;
};
// a request made straight in the database (the submit route would refuse it), authored by the doctor
const direct = async (setId, version = 1, status = 'submitted') => {
  await getActor({ headers: { 'x-test-role': 'doctor' } });
  const h = (await owner.query('SELECT content_hash FROM element_sets WHERE set_id=$1 AND version=$2', [setId, version])).rows[0].content_hash;
  return (await owner.query('INSERT INTO review_requests (set_id,set_version,author_id,status,content_hash,submitted_at) VALUES ($1,$2,$3,$4,$5,now()) RETURNING id', [setId, version, actors.doctor.id, status, h])).rows[0].id;
};
const tier = async (setId, v = 1) => (await owner.query('SELECT tier FROM element_sets WHERE set_id=$1 AND version=$2', [setId, v])).rows[0].tier;
const rr = async (id) => (await owner.query('SELECT * FROM review_requests WHERE id=$1', [id])).rows[0];
const evs = async (id) => (await owner.query('SELECT * FROM review_events WHERE request_id=$1 ORDER BY id', [id])).rows;
const audits = async (id) => (await owner.query("SELECT * FROM audit_log WHERE action='review.approve' AND entity_id=$1", [id])).rows;
const untouched = async (id, setId, st = 'submitted') => {
  assert.equal((await rr(id)).status, st); assert.equal((await rr(id)).reviewer_id, null);
  assert.equal(await tier(setId), 'local-draft'); assert.equal((await audits(id)).length, 0);
  assert.ok(!(await evs(id)).some((e) => e.event === 'approved'));
};

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

test('the route is registered with content.review', () => {
  assert.equal(ROUTE_ACTIONS['POST /review-requests/:id/approve'], 'content.review');
});

test('an informatician approves: request approved, reviewer from the session, version frozen as local-reviewed, one event, one audit row', async () => {
  const id = await submit('user.a');
  const before = (await owner.query("SELECT body, content_hash FROM element_sets WHERE set_id='user.a' AND version=1")).rows[0];
  const r = await approve(id, 'informatician', { comment: 'Reads well' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'approved'); assert.equal(r.body.tier, 'local-reviewed'); assert.equal(r.body.reviewerId, actors.informatician.id);
  const row = await rr(id);
  assert.equal(row.status, 'approved'); assert.equal(row.reviewer_id, actors.informatician.id); assert.ok(row.decided_at); assert.equal(row.comment, 'Reads well');
  assert.equal(await tier('user.a'), 'local-reviewed');
  const after = (await owner.query("SELECT body, content_hash FROM element_sets WHERE set_id='user.a' AND version=1")).rows[0];
  assert.deepEqual(after, before);   // body and hash never change
  const e = (await evs(id)).filter((x) => x.event === 'approved');
  assert.equal(e.length, 1); assert.equal(e[0].user_id, actors.informatician.id);
  const a = await audits(id);
  assert.equal(a.length, 1); assert.equal(a[0].user_id, actors.informatician.id); assert.equal(a[0].role, 'informatician');
  assert.equal(a[0].before.tier, 'local-draft'); assert.equal(a[0].after.tier, 'local-reviewed');
});

test('an admin may approve a request written by someone else; doctor, nurse and viewer are refused (403) and nothing changes', async () => {
  const id = await submit('user.b');
  for (const role of ['doctor', 'nurse', 'viewer']) assert.equal((await approve(id, role)).status, 403, role);
  await untouched(id, 'user.b');
  assert.equal((await approve(id, 'admin')).status, 200);
});

test('the author cannot approve their own request (403 own_request), even as informatician or admin; nothing changes', async () => {
  const idI = await submit('user.own_i', 'informatician');
  const r = await approve(idI, 'informatician');
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'own_request');
  await untouched(idI, 'user.own_i');
  const idA = await submit('user.own_a', 'admin');
  assert.equal((await approve(idA, 'admin')).status, 403);
  await untouched(idA, 'user.own_a');
});

test('only a waiting or in-review request can be approved: a second approval and other statuses give 409 bad_status', async () => {
  const id = await submit('user.c');
  assert.equal((await approve(id)).status, 200);
  const again = await approve(id, 'admin'); assert.equal(again.status, 409); assert.equal(again.body.error.code, 'bad_status');
  assert.equal((await evs(id)).filter((x) => x.event === 'approved').length, 1); assert.equal((await audits(id)).length, 1);
  assert.equal((await save('user.d', { title: 'D', access: ACC })).status, 201);
  for (const st of ['changes_requested', 'rejected', 'withdrawn', 'draft']) {
    const i = await direct('user.d', 1, st);
    const r = await approve(i); assert.equal(r.status, 409, st); assert.equal(r.body.error.code, 'bad_status', st);
    await owner.query('UPDATE review_requests SET status=$2 WHERE id=$1', [i, 'rejected']);   // frees the set for the next loop
  }
  assert.equal(await tier('user.d'), 'local-draft');
  const ir = await direct('user.d', 1, 'in_review');
  assert.equal((await approve(ir)).status, 200);
});

test('unknown or malformed id is 404; a body key that names the reviewer, or a too long comment, is 400', async () => {
  assert.equal((await approve(crypto.randomUUID())).status, 404);
  assert.equal((await approve('not-an-id')).status, 404);
  const id = await submit('user.e');
  assert.equal((await approve(id, 'informatician', { reviewerId: actors.admin.id })).status, 400);
  assert.equal((await approve(id, 'informatician', { comment: 'x'.repeat(2001) })).status, 400);
  await untouched(id, 'user.e');
});

test('a version with lint errors is refused (422) and nothing changes', async () => {
  assert.equal((await save('user.bad', { title: 'Bad', sections: [{ fields: [{ id: 'f', label: 'F', type: 'magic' }] }], access: ACC })).status, 201);
  const id = await direct('user.bad');
  const r = await approve(id); assert.equal(r.status, 422); assert.equal(r.body.error.code, 'lint_failed');
  await untouched(id, 'user.bad');
});

test('a changed hash is refused (409 hash_mismatch)', async () => {
  const id = await submit('user.h');
  await owner.query("UPDATE review_requests SET content_hash='sha256:other' WHERE id=$1", [id]);
  const r = await approve(id); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'hash_mismatch');
  await untouched(id, 'user.h');
});

test('an old version is refused (409 conflict) when a newer one exists', async () => {
  assert.equal((await save('user.v', { title: 'V1', access: ACC })).status, 201);
  const id = await direct('user.v', 1, 'in_review');   // an in_review request is left alone when a newer version is saved (43b4)
  assert.equal((await save('user.v', { title: 'V2', access: ACC }, { expectedVersion: 1 })).status, 201);
  assert.equal((await rr(id)).status, 'in_review');
  const r = await approve(id); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'conflict');
  await untouched(id, 'user.v', 'in_review');
});

test('rules or bands need two reviewers: refused for now (409 needs_two_reviewers) and nothing changes', async () => {
  assert.equal((await save('user.r1', { title: 'R', access: ACC, rules: [{ id: 'x' }] })).status, 201);
  assert.equal((await save('user.r2', { title: 'B', access: ACC, sections: [{ bands: [{ label: 'x' }] }] })).status, 201);
  for (const setId of ['user.r1', 'user.r2']) {
    const id = await direct(setId);
    const r = await approve(id); assert.equal(r.status, 409, setId); assert.equal(r.body.error.code, 'needs_two_reviewers', setId);
    await untouched(id, setId);
  }
});

test('an approved version cannot be submitted again (409 already_reviewed); a new version can', async () => {
  const id = await submit('user.f'); assert.equal((await approve(id)).status, 200);
  const r = await post('/api/review-requests', { setId: 'user.f', version: 1 }, 'doctor');
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'already_reviewed');
  assert.equal((await save('user.f', { title: 'F2', access: ACC }, { expectedVersion: 1 })).status, 201);
  assert.equal(await tier('user.f', 2), 'local-draft');
  assert.equal((await post('/api/review-requests', { setId: 'user.f', version: 2 }, 'doctor')).status, 201);
});

test('the app role may change the tier column (015_review_approve.sql)', async () => {
  const r = await appDb.query("UPDATE element_sets SET tier = tier WHERE set_id = 'user.a' AND version = 1");
  assert.equal(r.rowCount, 1);
  // Not tested here: that body, content_hash and version cannot be changed by the app role. That depends on earlier grants I could not see: check with \dp element_sets in psql.
});
