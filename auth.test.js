'use strict';
// node --test auth.test.js  (needs DATABASE_URL; creates and drops its own database)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword, verifyPassword, passwordProblem } = require('./auth.js');
const { createAdmin } = require('./create-admin.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_auth_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let db, app, pwHash;
const mk = async (username, over = {}) => (await db.query(
  'INSERT INTO users (username,name,role,password_hash,active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [username, over.name || username, over.role || 'nurse', pwHash, over.active !== false])).rows[0].id;
const login = (u, p, a = app) => request(a).post('/api/login').send({ username: u, password: p });
const cookieOf = (r) => (r.headers['set-cookie'] || []).find((c) => c.startsWith('emr_sid='));
const tokenOf = (r) => cookieOf(r).split(';')[0].slice('emr_sid='.length);
const me = (tok, a = app) => request(a).get('/api/session').set('Cookie', 'emr_sid=' + tok);

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name)); await migrate(db, __dirname);
  app = createApp({ db });
  pwHash = await hashPassword(PW);
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('hashing: scrypt string with its own parameters and salt; right and wrong password; policy', async () => {
  const h1 = await hashPassword(PW), h2 = await hashPassword(PW);
  assert.match(h1, /^scrypt\$32768\$8\$1\$/); assert.notEqual(h1, h2, 'a new salt every time'); assert.ok(!h1.includes(PW));
  assert.equal(await verifyPassword(PW, h1), true); assert.equal(await verifyPassword(PW + 'x', h1), false);
  assert.equal(await verifyPassword(PW, 'plain-text'), false); assert.equal(await verifyPassword(PW, null), false);
  assert.equal(passwordProblem('short'), 'Use at least 12 characters'); assert.equal(passwordProblem(PW), null);
  await assert.rejects(db.query("INSERT INTO users (username,name,password_hash) VALUES ('bad','Bad','plaintext')"), /users_hash_format/);
});

test('login: cookie is httpOnly, SameSite=Lax, not Secure in dev; only the hash of the token is stored; no password data returned', async () => {
  await mk('asha', { name: 'Dr Asha', role: 'doctor' });
  const r = await login('ASHA', PW);                                    // username is case-insensitive
  assert.equal(r.status, 200); assert.deepEqual(r.body, { id: r.body.id, name: 'Dr Asha', role: 'doctor', mustChangePassword: false, allowed: require('./permissions.js').allowedActions({ role: 'doctor' }) });
  const c = cookieOf(r); assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/); assert.doesNotMatch(c, /Secure/); assert.match(c, /Max-Age=43200/);
  const tok = tokenOf(r), s = (await db.query('SELECT id FROM sessions WHERE user_id=$1', [r.body.id])).rows;
  assert.equal(tok.length, 64); assert.deepEqual(s.map((x) => x.id), [crypto.createHash('sha256').update(tok).digest('hex')]); assert.notEqual(s[0].id, tok);
  assert.ok(!JSON.stringify(r.body).includes('scrypt'));
  assert.ok((await db.query('SELECT last_login_at FROM users WHERE id=$1', [r.body.id])).rows[0].last_login_at);
  const w = await me(tok); assert.equal(w.status, 200); assert.equal(w.body.name, 'Dr Asha');
});

test('the cookie is Secure in production mode', async () => {
  const a = createApp({ db, authOptions: { secure: true } }); await mk('prod1');
  assert.match(cookieOf(await login('prod1', PW, a)), /Secure/);
});

test('wrong password and unknown user get the same answer; no session; bad bodies are 400', async () => {
  await mk('bob');
  const a = await login('bob', 'wrong password!!'), b = await login('nobody', PW);
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.deepEqual(a.body, b.body); assert.equal(a.body.error.code, 'invalid_credentials');
  assert.equal(cookieOf(a), undefined);
  assert.equal((await request(app).post('/api/login').send({ username: 'bob' })).status, 400);
  assert.equal((await request(app).post('/api/login').send({ username: 'bob', password: PW, extra: 1 })).status, 400);
  assert.equal((await request(app).get('/api/session')).status, 401);
  assert.equal((await me('0'.repeat(64))).status, 401); assert.equal((await me('junk')).status, 401);
});

test('lockout: 5 wrong passwords lock the account, even the right password is then refused, and it unlocks after the time', async () => {
  const id = await mk('carol');
  for (let i = 0; i < 5; i++) assert.equal((await login('carol', 'wrong password!!')).status, 401);
  const u = (await db.query('SELECT failed_logins, locked_until FROM users WHERE id=$1', [id])).rows[0];
  assert.equal(u.failed_logins, 5); assert.ok(u.locked_until);
  const r = await login('carol', PW); assert.equal(r.status, 429); assert.equal(r.body.error.code, 'account_locked'); assert.ok(+r.headers['retry-after'] > 0); assert.equal(cookieOf(r), undefined);
  assert.equal((await db.query('SELECT failed_logins FROM users WHERE id=$1', [id])).rows[0].failed_logins, 5, 'no further counting while locked');
  await db.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE id=$1", [id]);
  const ok = await login('carol', PW); assert.equal(ok.status, 200);
  assert.deepEqual((await db.query('SELECT failed_logins, locked_until FROM users WHERE id=$1', [id])).rows[0], { failed_logins: 0, locked_until: null });
});

test('a success resets the failure count', async () => {
  const id = await mk('dave');
  for (let i = 0; i < 3; i++) await login('dave', 'wrong password!!');
  assert.equal((await login('dave', PW)).status, 200);
  assert.equal((await db.query('SELECT failed_logins FROM users WHERE id=$1', [id])).rows[0].failed_logins, 0);
});

test('per-address limiter also stops guessing at usernames that do not exist', async () => {
  const a = createApp({ db, authOptions: { maxIpFailures: 3 } });
  for (let i = 0; i < 3; i++) assert.equal((await login('ghost' + i, 'whatever password', a)).status, 401);
  const r = await login('ghost9', 'whatever password', a); assert.equal(r.status, 429); assert.equal(r.body.error.code, 'too_many_attempts');
});

test('inactive users cannot log in, and deactivating ends an open session', async () => {
  assert.equal((await login(await (async () => { await mk('gone', { active: false }); return 'gone'; })(), PW)).status, 401);
  const id = await mk('erin'); const r = await login('erin', PW), tok = tokenOf(r);
  assert.equal((await me(tok)).status, 200);
  await db.query('UPDATE users SET active=false WHERE id=$1', [id]);
  assert.equal((await me(tok)).status, 401);
  assert.equal((await db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [id])).rows[0].n, 0);
});

test('idle timeout: 30 minutes without use ends the session; use inside the window keeps it alive', async () => {
  const id = await mk('frank'), tok = tokenOf(await login('frank', PW));
  await db.query("UPDATE sessions SET last_seen = now() - interval '20 minutes' WHERE user_id=$1", [id]);
  assert.equal((await me(tok)).status, 200);
  const seen = (await db.query("SELECT last_seen > now() - interval '1 minute' AS fresh FROM sessions WHERE user_id=$1", [id])).rows[0];
  assert.equal(seen.fresh, true, 'last_seen slides forward');
  await db.query("UPDATE sessions SET last_seen = now() - interval '31 minutes' WHERE user_id=$1", [id]);
  const r = await me(tok); assert.equal(r.status, 401); assert.equal(r.body.error.code, 'session_expired');
  assert.match((r.headers['set-cookie'] || []).join(), /emr_sid=;/);
  assert.equal((await db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [id])).rows[0].n, 0);
  assert.equal((await me(tok)).status, 401);
});

test('absolute timeout: a busy session still ends at its fixed limit', async () => {
  const id = await mk('gina'), tok = tokenOf(await login('gina', PW));
  await db.query("UPDATE sessions SET expires_at = now() - interval '1 second', created_at = now() - interval '13 hours' WHERE user_id=$1", [id]);
  const r = await me(tok); assert.equal(r.status, 401); assert.equal(r.body.error.code, 'session_expired');
});

test('logout deletes the session; the old cookie stops working; logout without a session is fine; other sessions survive', async () => {
  const id = await mk('hank'), t1 = tokenOf(await login('hank', PW)), t2 = tokenOf(await login('hank', PW));
  assert.notEqual(t1, t2);
  const out = await request(app).post('/api/logout').set('Cookie', 'emr_sid=' + t1); assert.equal(out.status, 204); assert.match(out.headers['set-cookie'].join(), /emr_sid=;/);
  assert.equal((await me(t1)).status, 401); assert.equal((await me(t2)).status, 200);
  assert.equal((await request(app).post('/api/logout')).status, 204);
  assert.equal((await db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [id])).rows[0].n, 1);
});

test('mustChangePassword is reported at login; data routes now need the session (chunk 32b: no dev user)', async () => {
  const id = await mk('ivy'); await db.query('UPDATE users SET must_change_password=true WHERE id=$1', [id]);
  const r = await login('ivy', PW);
  assert.equal(r.body.mustChangePassword, true);
  assert.equal((await request(app).get('/api/me')).status, 401);
  const m = await request(app).get('/api/me').set('Cookie', 'emr_sid=' + tokenOf(r));
  assert.equal(m.status, 200); assert.equal(m.body.mode, 'session'); assert.equal(m.body.id, id);
});

// ---------------------------------------------------------------- chunk 32c: create-admin
test('create-admin: needs a typed strong password, no default exists, first admin can log in, a second is refused unless allowed', async () => {
  await db.query("DELETE FROM sessions"); await db.query("UPDATE users SET active=false WHERE role='admin'");   // earlier tests may have made admins
  await assert.rejects(createAdmin(db, { username: 'root', name: 'Root', password: 'short' }), /at least 12/);
  await assert.rejects(createAdmin(db, { username: 'bad name', name: 'Root', password: PW }), /Username/);
  await assert.rejects(createAdmin(db, { username: 'root', name: '', password: PW }), /Name is required/);
  assert.equal((await db.query("SELECT count(*)::int n FROM users WHERE username='root'")).rows[0].n, 0, 'nothing created by the refusals');
  const id = await createAdmin(db, { username: 'root', name: 'Root', password: PW });
  const u = (await db.query('SELECT role,active,must_change_password,password_hash FROM users WHERE id=$1', [id])).rows[0];
  assert.equal(u.role, 'admin'); assert.equal(u.active, true); assert.equal(u.must_change_password, false); assert.ok(u.password_hash.startsWith('scrypt$') && !u.password_hash.includes(PW));
  assert.equal((await login('root', PW)).status, 200);
  await assert.rejects(createAdmin(db, { username: 'root2', name: 'R2', password: PW }), /already exists/);
  await assert.rejects(createAdmin(db, { username: 'ROOT', name: 'R3', password: PW }, { allowMore: true }), /already taken/);
  assert.ok(await createAdmin(db, { username: 'root2', name: 'R2', password: PW }, { allowMore: true }));
});
