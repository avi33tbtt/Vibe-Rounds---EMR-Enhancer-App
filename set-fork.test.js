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
const name = 'emr_fk_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'informatician';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['fk-' + role, 'FK ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const llm = { name: 'mock', model: 'mock-1', complete: async () => '{}' };
const ACC = { view: ['admin'], enter: ['admin'], amend: ['admin'], approve: ['admin'], configure: ['admin'], export: ['admin'] };
const post = (b, role) => { const q = request(app).post('/api/element-sets'); if (role) q.set('x-test-role', role); return q.send(b); };
const fork = (setId, from, body) => post({ setId, kind: 'custom', body: body || { title: 'Copy', access: ACC }, forkedFrom: from });
const rowsOf = async (id) => (await owner.query('SELECT * FROM element_sets WHERE set_id=$1 ORDER BY version', [id])).rows;
const ORIG_BODY = { setId: 'mk.orig', kind: 'custom', version: 1, title: 'Original', access: ACC };
const ORIG_HASH = 'sha256:' + crypto.createHash('sha256').update('orig').digest('hex');

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${pw}'`);
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = pw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb, getActor, llm });
  await owner.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier,content_hash) VALUES ('mk.orig',1,'custom',$1,'marketplace',true,'marketplace-verified',$2)`, [JSON.stringify(ORIG_BODY), ORIG_HASH]);
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('42b7: forking a read-only set gives a new local draft, version 1, with forkedFrom and the original hash from the server', async () => {
  const r = await fork('local.copy_one', { setId: 'mk.orig', version: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.setId, 'local.copy_one'); assert.equal(r.body.version, 1);
  assert.equal(r.body.tier, 'local-draft'); assert.equal(r.body.readOnly, false); assert.equal(r.body.source, 'user');
  assert.deepEqual(r.body.forkedFrom, { setId: 'mk.orig', version: 1, contentHash: ORIG_HASH });
});

test('42b7: the original is byte-identical after a fork', async () => {
  const before = await rowsOf('mk.orig');
  assert.equal((await fork('local.copy_two', { setId: 'mk.orig', version: 1 })).status, 201);
  const after = await rowsOf('mk.orig');
  assert.deepEqual(after, before);
  assert.equal(after.length, 1); assert.equal(after[0].content_hash, ORIG_HASH); assert.equal(after[0].read_only, true);
});

test('42b7: an existing id is 409, an id not starting with local. is 422, an unknown original is 404', async () => {
  assert.equal((await fork('local.copy_one', { setId: 'mk.orig', version: 1 })).status, 409);
  const bad = await fork('user.copy', { setId: 'mk.orig', version: 1 });
  assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'bad_fork_id');
  assert.equal((await fork('local.copy_x', { setId: 'mk.nope', version: 1 })).status, 404);
  assert.equal((await fork('local.copy_y', { setId: 'mk.orig', version: 9 })).status, 404);
  assert.equal((await rowsOf('local.copy_x')).length, 0); assert.equal((await rowsOf('local.copy_y')).length, 0);
});

test('42b7: a tier, readOnly, source, forkedFrom or package typed in the body is not stored', async () => {
  const r = await fork('local.copy_three', { setId: 'mk.orig', version: 1 },
    { title: 'C3', access: ACC, tier: 'marketplace-verified', readOnly: true, source: 'marketplace', forkedFrom: { setId: 'x', version: 1, contentHash: 'sha256:fake' }, package: { id: 'a.b', version: '1.0.0', contentHash: 'x' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = (await rowsOf('local.copy_three'))[0];
  assert.equal(row.tier, 'local-draft'); assert.equal(row.read_only, false); assert.equal(row.source, 'user');
  for (const k of ['tier', 'readOnly', 'source', 'forkedFrom', 'package']) assert.equal(k in row.body, false, k);
  assert.equal(row.forked_from.contentHash, ORIG_HASH);
});

test('42b7: version 2 of a fork keeps forkedFrom', async () => {
  const r = await post({ setId: 'local.copy_one', kind: 'custom', body: { title: 'Copy v2', access: ACC }, expectedVersion: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.version, 2); assert.deepEqual(r.body.forkedFrom, { setId: 'mk.orig', version: 1, contentHash: ORIG_HASH });
});

test('42b7: editing a local-reviewed set makes a new draft version and leaves the reviewed one unchanged', async () => {
  assert.equal((await post({ setId: 'user.rev', kind: 'custom', body: { title: 'Rev', access: ACC } })).status, 201);
  await owner.query("UPDATE element_sets SET tier='local-reviewed' WHERE set_id='user.rev' AND version=1");
  const before = (await rowsOf('user.rev'))[0];
  const r = await post({ setId: 'user.rev', kind: 'custom', body: { title: 'Rev 2', access: ACC }, expectedVersion: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.tier, 'local-draft'); assert.equal(r.body.version, 2);
  const rows = await rowsOf('user.rev');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tier, 'local-reviewed'); assert.equal(rows[0].content_hash, before.content_hash); assert.deepEqual(rows[0].body, before.body);
});

test('42b7: a fork request without forkedFrom still works as a plain new set, and a bad forkedFrom shape is 400', async () => {
  assert.equal((await post({ setId: 'local.plain', kind: 'custom', body: { title: 'P', access: ACC } })).status, 201);
  assert.equal((await post({ setId: 'local.bad', kind: 'custom', body: { title: 'P', access: ACC }, forkedFrom: { setId: 'mk.orig' } })).status, 400);
  assert.equal((await post({ setId: 'local.bad', kind: 'custom', body: { title: 'P', access: ACC }, forkedFrom: { setId: 'mk.orig', version: 1, contentHash: 'sha256:x' } })).status, 400);
});
