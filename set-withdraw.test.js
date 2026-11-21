'use strict';
// node --test set-fork.test.js  (needs DATABASE_URL; creates and drops its own database)
// 42b7: forking a set to a local copy. Made-up set ids only. Runs as the restricted emr_app role, like review-requests.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_wd_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'informatician';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['wd-' + role, 'WD ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const llm = { name: 'mock', model: 'mock-1', complete: async () => '{}' };
const ACC = { view: ["admin"], enter: ["admin"], amend: ["admin"], approve: ["admin"], configure: ["admin"], export: ["admin"] };
const post = (u, b, role) => { const q = request(app).post(u); if (role) q.set('x-test-role', role); return q.send(b); };
const save = (setId, body) => post('/api/element-sets', { setId, kind: 'custom', body });
const reqs = async (id) => (await owner.query('SELECT * FROM review_requests WHERE set_id=$1 ORDER BY set_version', [id])).rows;

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

test('43b4: saving a new version withdraws the waiting request on the older version, and audits it', async () => {
  assert.equal((await save('user.w1', { title: 'One', access: ACC })).status, 201);
  const s = await post('/api/review-requests', { setId: 'user.w1', version: 1 }, 'doctor');
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const r2 = await save('user.w1', { title: 'One edited', access: ACC });
  assert.equal(r2.status, 201); assert.equal(r2.body.version, 2);
  const rows = await reqs('user.w1');
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'withdrawn');
  const a = (await owner.query("SELECT * FROM audit_log WHERE action='set.save' AND entity_id='user.w1' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual(a.after.withdrawnRequests, [{ id: rows[0].id, version: 1 }]);
});
test('43b4: the new version can be submitted again; a decided or in-review request is not touched', async () => {
  const again = await post('/api/review-requests', { setId: 'user.w1', version: 2 }, 'doctor');
  assert.equal(again.status, 201, JSON.stringify(again.body));
  await owner.query("UPDATE review_requests SET status='in_review' WHERE set_id='user.w1' AND set_version=2");
  assert.equal((await save('user.w1', { title: 'One again', access: ACC })).status, 201);
  const rows = await reqs('user.w1');
  assert.deepEqual(rows.map((x) => x.status), ['withdrawn', 'in_review']);
});
test('43b4: a first save, or a set with no request, withdraws nothing and adds no key to the audit row', async () => {
  assert.equal((await save('user.w2', { title: 'Two', access: ACC })).status, 201);
  assert.equal((await save('user.w2', { title: 'Two b', access: ACC })).status, 201);
  const a = (await owner.query("SELECT * FROM audit_log WHERE action='set.save' AND entity_id='user.w2' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal('withdrawnRequests' in a.after, false);
});
