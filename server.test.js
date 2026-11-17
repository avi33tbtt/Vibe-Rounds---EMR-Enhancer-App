'use strict';
// node --test server.test.js   (needs DATABASE_URL pointing at a server where the user can CREATE DATABASE)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { loadConfig, createDb, migrate, createApp } = require('./server.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const testName = 'emr_test_' + crypto.randomBytes(4).toString('hex');
const adminUrl = (() => { const u = new URL(base); u.pathname = '/postgres'; return u.toString(); })();
const testUrl = (() => { const u = new URL(base); u.pathname = '/' + testName; return u.toString(); })();
let db, app, tmp;

test.before(async () => {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect(); await admin.query(`CREATE DATABASE ${testName}`); await admin.end();
  db = createDb(testUrl);
  app = createApp({ db });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(tmp, '001_a.sql'), 'CREATE TABLE t_a (id int);');
  fs.writeFileSync(path.join(tmp, '002_b.sql'), 'CREATE TABLE t_b (id int);');
});
test.after(async () => {
  if (db) await db.close();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS ${testName} WITH (FORCE)`); await admin.end();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('config fails fast without DATABASE_URL', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://x' }).port, 3000);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: 'abc' }), /PORT/);
});

test('migrations run once, in order, and never twice', async () => {
  assert.deepEqual(await migrate(db, tmp), ['001_a.sql', '002_b.sql']);
  assert.deepEqual(await migrate(db, tmp), []);
  const r = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.equal(r.rows.length, 2);
});

test('a changed, already-applied migration is refused', async () => {
  fs.writeFileSync(path.join(tmp, '001_a.sql'), 'CREATE TABLE t_a (id int, x int);');
  await assert.rejects(() => migrate(db, tmp), /changed after it was applied/);
});

test('a failing migration rolls back completely', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig2-'));
  fs.writeFileSync(path.join(d, '001_bad.sql'), 'CREATE TABLE t_ok (id int); SELECT nope_nope();');
  await assert.rejects(() => migrate(db, d));
  const r = await db.query("SELECT to_regclass('t_ok') AS t");
  assert.equal(r.rows[0].t, null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('withTx rolls back on error', async () => {
  await db.query('CREATE TABLE tx_t (id int)');
  await assert.rejects(() => db.withTx(async (c) => { await c.query('INSERT INTO tx_t VALUES (1)'); throw new Error('boom'); }));
  assert.equal((await db.query('SELECT count(*)::int n FROM tx_t')).rows[0].n, 0);
});

test('GET /api/health ok', async () => {
  const r = await request(app).get('/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok', db: 'ok' });
});

test('GET /api/health reports 503 when DB is down', async () => {
  const dead = createDb('postgres://nobody@127.0.0.1:1/none');
  const r = await request(createApp({ db: dead })).get('/api/health');
  assert.equal(r.status, 503);
  assert.equal(r.body.status, 'degraded');
  await dead.close();
});

test('static: app files served, server files and dotfiles are not', async () => {
  for (const f of ['/', '/enhancer.html', '/element-sets.js', '/cds-rules.js']) {
    const r = await request(app).get(f);
    assert.ok([200, 404].includes(r.status), f); // 404 only if that file is not in the folder yet
    if (fs.existsSync(path.join(__dirname, f === '/' ? 'enhancer.html' : f.slice(1)))) assert.equal(r.status, 200, f);
  }
  for (const f of ['/server.js', '/.env', '/package.json', '/server.test.js', '/001_core.sql']) {
    assert.equal((await request(app).get(f)).status, 404, f);
  }
});

test('unknown API route returns the standard error shape', async () => {
  // The API resolves an actor (a users-table lookup) on every /api request, and the schema is only migrated
  // in a later test, so this test supplies a stub actor and stays independent of the database schema.
  const stubApp = createApp({ db, getActor: async () => ({ id: '00000000-0000-0000-0000-000000000000', role: 'admin' }) });
  const r = await request(stubApp).get('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
});

// ---------------- schema v1 (001_core.sql) ----------------
const rejects = (p, re) => assert.rejects(p, re);
test('001_core.sql applies once to a fresh database', async () => {
  assert.deepEqual(await migrate(db, __dirname), ['001_core.sql']);
  assert.deepEqual(await migrate(db, __dirname), []);
});

test('schema: concurrent row appends both succeed', async () => {
  const c = (await db.query("INSERT INTO cases (narrative, demo_patient) VALUES ('', '{}') RETURNING id")).rows[0].id;
  const add = (v) => db.query("INSERT INTO case_rows (case_id,set_id,group_id,row,row_time) VALUES ($1,'care.vitals','vit',$2,now())", [c, JSON.stringify({ hr: v })]);
  await Promise.all([add(70), add(80)]);
  assert.equal((await db.query('SELECT count(*)::int n FROM case_rows WHERE case_id=$1', [c])).rows[0].n, 2);
});

test('schema: entered_in_error needs a reason; invalid timestamps keep the row', async () => {
  const c = (await db.query("INSERT INTO cases (demo_patient) VALUES ('{}') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO case_rows (case_id,set_id,group_id,row,row_time) VALUES ($1,'s','g','{}',NULL)", [c]);
  await rejects(db.query("INSERT INTO case_rows (case_id,set_id,group_id,row,status) VALUES ($1,'s','g','{}','entered_in_error')", [c]), /check/);
  await rejects(db.query("INSERT INTO case_rows (case_id,set_id,group_id,row,status) VALUES ($1,'s','g','{}','deleted')", [c]), /check/);
});

test('schema: a rule cannot be enabled without an approver (unapproved rules never run)', async () => {
  await rejects(db.query("INSERT INTO cds_rules (owner_set_id,rule_id,body,enabled) VALUES ('s','r1','{}',true)"), /check/);
  await db.query("INSERT INTO cds_rules (owner_set_id,rule_id,body) VALUES ('s','r2','{}')");
});

test('schema: audit_log is append-only', async () => {
  const id = (await db.query("INSERT INTO audit_log (action,entity) VALUES ('t','t') RETURNING id")).rows[0].id;
  await rejects(db.query('UPDATE audit_log SET action=$2 WHERE id=$1', [id, 'x']), /append-only/);
  await rejects(db.query('DELETE FROM audit_log WHERE id=$1', [id]), /append-only/);
});

test('schema: roles, case_values keys, marketplace read-only, own-review ban', async () => {
  await rejects(db.query("INSERT INTO users (username,name,role) VALUES ('a','A','root')"), /check/);
  const c = (await db.query("INSERT INTO cases (demo_patient) VALUES ('{}') RETURNING id")).rows[0].id;
  await rejects(db.query("INSERT INTO case_values (case_id,key,value) VALUES ($1,'nokey','1')", [c]), /check/);
  await db.query("INSERT INTO case_values (case_id,key,value) VALUES ($1,'care.vitals/__ref','{}')", [c]);
  await rejects(db.query("INSERT INTO element_sets (set_id,kind,body,source,read_only) VALUES ('m','care','{}','marketplace',false)"), /check/);
  const u = (await db.query("INSERT INTO users (username,name,role) VALUES ('inf','I','informatician') RETURNING id")).rows[0].id;
  await rejects(db.query("INSERT INTO review_requests (set_id,set_version,author_id,reviewer_id) VALUES ('s',1,$1,$1)", [u]), /check/);
});
