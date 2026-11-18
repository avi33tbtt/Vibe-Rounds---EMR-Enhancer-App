'use strict';
// node --test audit-auth.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 33e: login, logout, failed login and account lock are audited, with no secret in any row and no unchecked growth.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');

try { require('node:fs').existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_aa_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, hash, nurseId;
const rows = async (after = 0) => (await owner.query('SELECT * FROM audit_log WHERE id > $1 ORDER BY id', [after])).rows;
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb });
  hash = await hashPassword(PW);
  nurseId = (await owner.query("INSERT INTO users (username,name,role,password_hash) VALUES ('rn_aa','RN','nurse',$1) RETURNING id", [hash])).rows[0].id;
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('login and logout each write one row with the user, role and ip; a logout without a session writes nothing', async () => {
  const m = await maxId(), agent = request.agent(app);
  assert.equal((await agent.post('/api/login').send({ username: 'rn_aa', password: PW })).status, 200);
  assert.equal((await agent.post('/api/logout')).status, 204);
  assert.equal((await request(app).post('/api/logout')).status, 204);          // no session: nothing to record
  const r = await rows(m);
  assert.deepEqual(r.map((x) => x.action), ['auth.login', 'auth.logout']);
  for (const x of r) { assert.equal(x.user_id, nurseId); assert.equal(x.role, 'nurse'); assert.ok(x.ip); assert.equal(x.entity, 'user'); }
});

test('failed login: unknown name has user_id null; known user is linked; no password anywhere; unsafe username is not stored', async () => {
  const m = await maxId();
  await request(app).post('/api/login').send({ username: 'nobody_here', password: 'SecretGuess-123456' });
  await request(app).post('/api/login').send({ username: 'rn_aa', password: 'AnotherGuess-987654' });
  await request(app).post('/api/login').send({ username: "x'); DROP TABLE users;--", password: 'pw-pw-pw-pw-pw' });
  const r = await rows(m);
  assert.deepEqual(r.map((x) => x.action), ['auth.login_failed', 'auth.login_failed', 'auth.login_failed']);
  assert.equal(r[0].user_id, null); assert.deepEqual(r[0].after, { reason: 'unknown_user', username: 'nobody_here' });
  assert.equal(r[1].user_id, nurseId); assert.equal(r[1].after.reason, 'bad_password');
  assert.equal(r[2].after.username, undefined); assert.equal(r[2].after.username_rejected, true);
  const all = JSON.stringify(r); for (const s of ['SecretGuess', 'AnotherGuess', 'pw-pw-pw', 'DROP TABLE', 'scrypt', hash]) assert.ok(!all.includes(s), 'no ' + s);
  assert.equal((await owner.query('SELECT failed_logins n FROM users WHERE id=$1', [nurseId])).rows[0].n, 1);
});

test('five failures: four failed rows, then the fifth writes failed + account_locked in one go; a locked attempt writes no row', async () => {
  await owner.query("INSERT INTO users (username,name,role,password_hash) VALUES ('lk_aa','LK','nurse',$1)", [hash]);
  const lk = (await owner.query("SELECT id FROM users WHERE username='lk_aa'")).rows[0].id;
  const m = await maxId();
  for (let i = 0; i < 5; i++) await request(app).post('/api/login').send({ username: 'lk_aa', password: 'wrong-' + i });
  const r = await rows(m);
  assert.deepEqual(r.map((x) => x.action), ['auth.login_failed', 'auth.login_failed', 'auth.login_failed', 'auth.login_failed', 'auth.login_failed', 'auth.account_locked']);
  assert.ok(r.every((x) => x.user_id === lk));
  const m2 = await maxId();
  assert.equal((await request(app).post('/api/login').send({ username: 'lk_aa', password: PW })).status, 429);
  assert.equal((await rows(m2)).length, 0, 'attempts while locked cannot grow the table');
});

test('the per-address limiter stays in front: once blocked, further attempts write nothing', async () => {
  const m = await maxId();
  const small = createApp({ db: appDb, authOptions: { maxIpFailures: 4 } });     // its own limiter state
  let blocked = 0;
  for (let i = 0; i < 12; i++) { const r = await request(small).post('/api/login').send({ username: 'spam_' + i, password: 'x-x-x-x-x-x-x' }); if (r.status === 429) blocked++; }
  const n = (await rows(m)).length;
  assert.ok(blocked > 0, 'limiter reached'); assert.ok(n <= 4, 'at most the limit were recorded, got ' + n);
});

test('if the audit insert fails the sign-in fails: no session is created', async () => {
  await owner.query("CREATE OR REPLACE FUNCTION aa_block() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$ LANGUAGE plpgsql");
  await owner.query("CREATE TRIGGER aa_block BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION aa_block()");
  try {
    const before = (await owner.query('SELECT count(*)::int n FROM sessions')).rows[0].n;
    const r = await request(app).post('/api/login').send({ username: 'rn_aa', password: PW });
    assert.equal(r.status, 500); assert.ok(!r.headers['set-cookie'], 'no cookie');
    assert.equal((await owner.query('SELECT count(*)::int n FROM sessions')).rows[0].n, before);
  } finally { await owner.query('DROP TRIGGER aa_block ON audit_log'); }
});

test('the admin Audit screen route can see the new events (action filter)', async () => {
  await owner.query("INSERT INTO users (username,name,role,password_hash) VALUES ('ad_aa','AD','admin',$1)", [hash]);
  const ag = request.agent(app); await ag.post('/api/login').send({ username: 'ad_aa', password: PW });
  ag.set('x-csrf-token', (await ag.get('/api/csrf')).body.token);
  const r = await ag.get('/api/audit?action=auth.login_failed');
  assert.equal(r.status, 200); assert.ok(JSON.stringify(r.body).includes('auth.login_failed'));
});
