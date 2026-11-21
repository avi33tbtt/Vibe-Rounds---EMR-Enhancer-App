'use strict';
// node --test review-decide.test.js  (needs DATABASE_URL; creates and drops its own database)
// 44a2c: POST /api/review-requests/:id/request-changes and /reject. Made-up set ids only. Runs as the restricted emr_app role, like review-approve.test.js.
// 44a2d (the guard tests at the end): the author is refused, one approval is not enough, a comment is always required, a failed write leaves no half rows.
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
const name = 'emr_dc_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['dc-' + role, 'DC ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const llm = { name: 'mock', model: 'mock-1', complete: async () => '{}' };
const ACC = { view: ['admin'], enter: ['admin'], amend: ['admin'], approve: ['admin'], configure: ['admin'], export: ['admin'] };   // same shape as review-approve.test.js
const call = (method, u, b, role) => { const q = request(app)[method](u); if (role) q.set('x-test-role', role); return b === undefined ? q : q.send(b); };
const post = (u, b, role) => call('post', u, b, role);
const save = (setId, body, extra = {}) => post('/api/element-sets', { setId, kind: 'custom', body, ...extra });
const changes = (id, body = { comment: 'Please add a unit' }, role = 'informatician') => post(`/api/review-requests/${id}/request-changes`, body, role);
const reject = (id, body = { comment: 'Not suitable' }, role = 'informatician') => post(`/api/review-requests/${id}/reject`, body, role);
// a saved set and a request made straight in the database, authored by the doctor
const direct = async (setId, status = 'submitted', body = { title: setId, access: ACC }) => {
  assert.equal((await save(setId, body)).status, 201, setId);
  await getActor({ headers: { 'x-test-role': 'doctor' } });
  const h = (await owner.query('SELECT content_hash FROM element_sets WHERE set_id=$1 AND version=1', [setId])).rows[0].content_hash;
  return (await owner.query('INSERT INTO review_requests (set_id,set_version,author_id,status,content_hash,submitted_at) VALUES ($1,1,$2,$3,$4,now()) RETURNING id', [setId, actors.doctor.id, status, h])).rows[0].id;
};
const tier = async (setId) => (await owner.query('SELECT tier FROM element_sets WHERE set_id=$1 AND version=1', [setId])).rows[0].tier;
const rr = async (id) => (await owner.query('SELECT * FROM review_requests WHERE id=$1', [id])).rows[0];
const evs = async (id) => (await owner.query('SELECT * FROM review_events WHERE request_id=$1 ORDER BY id', [id])).rows;
const audits = async (id, action) => (await owner.query('SELECT * FROM audit_log WHERE action=$1 AND entity_id=$2', [action, id])).rows;
const untouched = async (id, status) => {
  const row = await rr(id);
  assert.equal(row.status, status); assert.equal(row.reviewer_id, null); assert.equal(row.comment, null);
  assert.equal((await evs(id)).length, 0);
  assert.equal((await audits(id, 'review.request_changes')).length + (await audits(id, 'review.reject')).length, 0);
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

test('both routes are registered with content.review', () => {
  assert.equal(ROUTE_ACTIONS['POST /review-requests/:id/request-changes'], 'content.review');
  assert.equal(ROUTE_ACTIONS['POST /review-requests/:id/reject'], 'content.review');
});

test('request changes: status changes_requested, reviewer from the session, comment kept, one event, one audit row, version untouched, still in the queue', async () => {
  const id = await direct('user.c1');
  const before = (await owner.query("SELECT body, content_hash FROM element_sets WHERE set_id='user.c1' AND version=1")).rows[0];
  const r = await changes(id, { comment: 'Please add a unit to the first field' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'changes_requested'); assert.equal(r.body.reviewerId, actors.informatician.id);
  assert.equal(r.body.comment, 'Please add a unit to the first field'); assert.equal(r.body.decidedAt, null);
  const row = await rr(id);
  assert.equal(row.status, 'changes_requested'); assert.equal(row.reviewer_id, actors.informatician.id); assert.equal(row.decided_at, null);
  const e = await evs(id);
  assert.equal(e.length, 1); assert.equal(e[0].event, 'changes_requested'); assert.equal(e[0].user_id, actors.informatician.id);
  assert.equal(e[0].detail.comment, 'Please add a unit to the first field'); assert.equal(e[0].detail.version, 1);
  const a = await audits(id, 'review.request_changes');
  assert.equal(a.length, 1); assert.equal(a[0].user_id, actors.informatician.id);
  assert.deepEqual(a[0].before, { status: 'submitted' }); assert.equal(a[0].after.status, 'changes_requested');
  assert.ok(!JSON.stringify(a[0].after).includes('Please add a unit'), 'the comment text is not copied into the audit row');
  assert.equal(await tier('user.c1'), 'local-draft');
  const after = (await owner.query("SELECT body, content_hash FROM element_sets WHERE set_id='user.c1' AND version=1")).rows[0];
  assert.deepEqual(after, before);
  const q = await call('get', '/api/review-requests', undefined, 'informatician');
  assert.ok(q.body.requests.some((x) => x.id === id && x.status === 'changes_requested'));
});

test('reject: status rejected with a decision time, reviewer from the session, one event, one audit row, version untouched, out of the queue', async () => {
  const id = await direct('user.r1');
  const r = await reject(id, { comment: 'Not suitable for the library' }, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'rejected'); assert.equal(r.body.reviewerId, actors.admin.id); assert.ok(r.body.decidedAt);
  const row = await rr(id);
  assert.equal(row.status, 'rejected'); assert.equal(row.comment, 'Not suitable for the library'); assert.ok(row.decided_at);
  const e = await evs(id);
  assert.equal(e.length, 1); assert.equal(e[0].event, 'rejected'); assert.equal(e[0].detail.comment, 'Not suitable for the library');
  const a = await audits(id, 'review.reject');
  assert.equal(a.length, 1); assert.equal(a[0].after.status, 'rejected');
  assert.equal(await tier('user.r1'), 'local-draft');
  const q = await call('get', '/api/review-requests', undefined, 'informatician');
  assert.ok(!q.body.requests.some((x) => x.id === id));
});

test('a comment is required: none, blank or an unknown key is 400 and nothing changes (the reviewer is never taken from the body)', async () => {
  const id = await direct('user.v1');
  for (const body of [{}, { comment: '' }, { comment: '   ' }, { comment: 'ok', reviewerId: actors.admin.id }]) {
    for (const go of [changes, reject]) { const r = await go(id, body); assert.equal(r.status, 400, JSON.stringify(body)); }
  }
  await untouched(id, 'submitted');
});

test('a doctor, a nurse and a viewer are refused with 403 and nothing changes', async () => {
  const id = await direct('user.p1');
  for (const role of ['doctor', 'nurse', 'viewer']) {
    assert.equal((await changes(id, { comment: 'x' }, role)).status, 403, role);
    assert.equal((await reject(id, { comment: 'x' }, role)).status, 403, role);
  }
  await untouched(id, 'submitted');
});

test('an unknown or malformed id is 404', async () => {
  assert.equal((await changes('00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await reject('00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await changes('not-an-id')).status, 404);
});

test('only a waiting or in-review request can be decided: 409 bad_status for the others, nothing written', async () => {
  for (const st of ['changes_requested', 'approved', 'rejected', 'withdrawn']) {
    const id = await direct('user.s_' + st);
    await owner.query('UPDATE review_requests SET status=$2 WHERE id=$1', [id, st]);
    for (const go of [changes, reject]) {
      const r = await go(id); assert.equal(r.status, 409, st); assert.equal(r.body.error && (r.body.error.code || r.body.error), 'bad_status', st);
    }
    const row = await rr(id);
    assert.equal(row.status, st); assert.equal(row.reviewer_id, null); assert.equal((await evs(id)).length, 0);
    assert.equal((await audits(id, 'review.request_changes')).length + (await audits(id, 'review.reject')).length, 0);
  }
});

test('a request already in review can be rejected; approvals recorded earlier stay in the history', async () => {
  const id = await direct('user.i1', 'in_review');
  await owner.query("INSERT INTO review_events (request_id, user_id, event, detail) VALUES ($1,$2,'approval_recorded','{}')", [id, (await getActor({ headers: { 'x-test-role': 'admin' } })).id]);
  const r = await reject(id, { comment: 'A second look found a problem' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await evs(id)).map((e) => e.event), ['approval_recorded', 'rejected']);
  assert.equal((await rr(id)).status, 'rejected');
});

test('after changes are requested: it cannot be approved, a new version withdraws it, and the new version can be submitted again', async () => {
  assert.equal((await save('user.f1', { title: 'F1', access: ACC })).status, 201);
  const s = await post('/api/review-requests', { setId: 'user.f1', version: 1 }, 'doctor');
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal((await changes(s.body.id)).status, 200);
  const ap = await post(`/api/review-requests/${s.body.id}/approve`, {}, 'informatician');
  assert.equal(ap.status, 409); assert.equal(await tier('user.f1'), 'local-draft');
  assert.equal((await save('user.f1', { title: 'F1 edited', access: ACC }, { expectedVersion: 1 })).status, 201);
  assert.equal((await rr(s.body.id)).status, 'withdrawn');
  const again = await post('/api/review-requests', { setId: 'user.f1', version: 2 }, 'doctor');
  assert.equal(again.status, 201, JSON.stringify(again.body));
});

// ---------------------------------------------------------------- 44a2d: guard tests for approve, request-changes and reject together
const GO = { 'request-changes': (id, role) => changes(id, { comment: 'x' }, role), reject: (id, role) => reject(id, { comment: 'x' }, role), approve: (id, role) => post(`/api/review-requests/${id}/approve`, {}, role) };
const REFS = [{ id: 'r1', citation: 'Local protocol (made-up test reference)' }];
const RULES_SET = { title: 'Rules', access: ACC, rules: [{ op: '>', threshold: 38 }], references: REFS };   // a rules set needs two different approving reviewers (44a2b)
const submitAs = async (setId, role, body = { title: setId, access: ACC }) => {
  assert.equal((await save(setId, body)).status, 201, setId);
  const r = await post('/api/review-requests', { setId, version: 1 }, role);
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id;
};
const noDecision = async (id) => {                                 // nothing was decided or recorded
  const e = await evs(id);
  assert.ok(!e.some((x) => ['approved', 'approval_recorded', 'changes_requested', 'rejected'].includes(x.event)), 'no decision event');
  for (const a of ['review.approve', 'review.request_changes', 'review.reject']) assert.equal((await audits(id, a)).length, 0, a);
};

test('the author cannot approve, request changes or reject their own request: 403 own_request as informatician or admin, nothing changes, and the database CHECK is a second wall', async () => {
  for (const role of ['informatician', 'admin']) {
    const setId = 'user.own_' + role, id = await submitAs(setId, role);
    for (const [what, go] of Object.entries(GO)) {
      const r = await go(id, role);
      assert.equal(r.status, 403, role + ' ' + what); assert.equal(r.body.error.code, 'own_request', role + ' ' + what);
    }
    const row = await rr(id);
    assert.equal(row.status, 'submitted'); assert.equal(row.reviewer_id, null); assert.equal(row.comment, null);
    assert.equal(await tier(setId), 'local-draft'); await noDecision(id);
    assert.equal((await evs(id)).length, 1);                        // only the 'submitted' event from the submit route
    await assert.rejects(owner.query('UPDATE review_requests SET reviewer_id=author_id WHERE id=$1', [id]), (e) => e.code === '23514');
  }
});

test('one approval is not enough, and a second reviewer may still send it back or reject it: the version never becomes local-reviewed', async () => {
  for (const [path, go, status] of [['request-changes', GO['request-changes'], 'changes_requested'], ['reject', GO.reject, 'rejected']]) {
    const setId = 'user.one_' + path.replace('-', '_');
    const id = await direct(setId, 'submitted', RULES_SET);          // direct() saves the set itself
    const one = await GO.approve(id, 'informatician');
    assert.equal(one.status, 200, JSON.stringify(one.body)); assert.equal(one.body.finalized, false); assert.equal(one.body.status, 'in_review');
    assert.equal(await tier(setId), 'local-draft');
    const r = await go(id, 'admin');
    assert.equal(r.status, 200, path + JSON.stringify(r.body)); assert.equal(r.body.status, status);
    assert.equal(await tier(setId), 'local-draft', path); assert.equal((await rr(id)).status, status);
    assert.deepEqual((await evs(id)).map((e) => e.event), ['approval_recorded', status], path);   // the first approval stays as history
    const late = await GO.approve(id, 'informatician');             // a decided or sent-back request cannot be approved any more
    assert.equal(late.status, 409, path); assert.equal(late.body.error.code, 'bad_status', path);
    assert.equal(await tier(setId), 'local-draft', path);
  }
});

test('a comment is always required for request changes and reject: missing, blank, not text, over 2000 characters or an extra key is 400, nothing changes; 2000 characters are accepted', async () => {
  const id = await direct('user.cm1');
  for (const body of [undefined, {}, { comment: '' }, { comment: ' \n\t ' }, { comment: null }, { comment: 5 }, { comment: ['x'] }, { comment: 'x'.repeat(2001) }, { comment: 'ok', extra: 1 }]) {
    for (const path of ['request-changes', 'reject']) {
      const r = await post(`/api/review-requests/${id}/${path}`, body, 'informatician');
      assert.equal(r.status, 400, path + ' ' + String(JSON.stringify(body)).slice(0, 40)); assert.equal(r.body.error.code, 'validation');
    }
  }
  await untouched(id, 'submitted');
  assert.equal((await changes(id, { comment: 'y'.repeat(2000) })).status, 200);
});

test('a failed write leaves no half rows: if the event or the audit insert fails, request changes and reject change nothing, and work again afterwards', async () => {
  for (const table of ['audit_log', 'review_events']) {
    for (const [path, go] of [['request-changes', GO['request-changes']], ['reject', GO.reject]]) {
      const id = await direct(`user.tx_${table}_${path.replace('-', '_')}`);
      await owner.query(`CREATE FUNCTION fail_dc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'write down'; END $$`);
      await owner.query(`CREATE TRIGGER fail_dc_t BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_dc()`);
      const log = console.error; console.error = () => {};
      try {
        assert.equal((await go(id, 'informatician')).status, 500, table + ' ' + path);
      } finally {
        console.error = log;
        await owner.query(`DROP TRIGGER fail_dc_t ON ${table}`); await owner.query('DROP FUNCTION fail_dc()');
      }
      await untouched(id, 'submitted');                             // status, reviewer, comment, events and audit rows all as before
      assert.equal(await tier(`user.tx_${table}_${path.replace('-', '_')}`), 'local-draft');
      assert.equal((await go(id, 'informatician')).status, 200, 'the trigger was the cause: ' + table + ' ' + path);
    }
  }
});
