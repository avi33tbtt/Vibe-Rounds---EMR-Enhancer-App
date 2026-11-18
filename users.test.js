'use strict';
// node --test users.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 32e1: admin users routes and POST /password, against REAL login sessions and the restricted emr_app database role.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword, verifyPassword } = require('./auth.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_users_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, hash;
const who = {};                                                   // role -> {id, agent}

/** A user created straight in the database, then signed in through the real login route (agent carries cookie and CSRF token). */
async function mk(username, role, { pw = PW, mustChange = false } = {}) {
  const id = (await owner.query('INSERT INTO users (username,name,role,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [username, 'Name ' + username, role, pw === PW ? hash : await hashPassword(pw), mustChange])).rows[0].id;
  return { id, username, agent: await signIn(username, pw) };
}
async function signIn(username, pw = PW) {
  const agent = request.agent(app);
  const r = await agent.post('/api/login').send({ username, password: pw });
  if (r.status !== 200) return Object.assign(agent, { loginStatus: r.status });
  agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
  return Object.assign(agent, { loginStatus: 200 });
}
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
const since = async (id) => (await owner.query("SELECT * FROM audit_log WHERE id > $1 AND action NOT LIKE 'auth.%' ORDER BY id", [id])).rows;   // sign-in events (33e) have their own tests in audit-auth.test.js
const sessionsOf = async (id) => (await owner.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [id])).rows[0].n;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);   // what an admin does once (003_audit_grants.sql)
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb });                                     // NO getActor: real sessions, restricted role
  hash = await hashPassword(PW);
  for (const role of P.ROLES) who[role] = await mk('u_' + role, role);
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('role matrix: only an admin may list or change users; every role may call POST /password', async () => {
  const routes = [['get', '/api/users'], ['post', '/api/users'], ['post', `/api/users/${who.nurse.id}/deactivate`], ['post', `/api/users/${who.nurse.id}/reactivate`],
    ['post', `/api/users/${who.nurse.id}/reset-password`], ['post', `/api/users/${who.nurse.id}/role`]];
  for (const role of ['doctor', 'nurse', 'informatician', 'viewer']) {
    for (const [m, url] of routes) {
      const r = await who[role].agent[m](url).send({});
      assert.equal(r.status, 403, `${role} ${m} ${url}`); assert.equal(r.body.error.code, 'forbidden');
      assert.match(r.body.error.message, new RegExp(`Your role \\(${role}\\) may not manage users`)); assert.equal(r.body.error.action, 'user.manage');
    }
  }
  for (const [m, url] of routes) assert.notEqual((await request(app)[m](url).send({})).status, 200, 'logged out');
  assert.equal((await request(app).get('/api/users')).status, 401);
  for (const role of P.ROLES) assert.equal((await who[role].agent.post('/api/password').send({})).status, 400, role + ': allowed in, then the empty body is refused');
  assert.equal((await request(app).post('/api/password').send({})).status, 401);
  assert.deepEqual(P.ACTIONS['user.manage'], ['admin']); assert.deepEqual([...P.ACTIONS['password.change']].sort(), [...P.ROLES].sort());
});

test('create: generated temporary password shown once, must change, username unique ignoring case, policy and shape checks', async () => {
  const a = who.admin.agent;
  const r = await a.post('/api/users').send({ username: 'Newbie', name: ' New Person ', role: 'nurse' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.username, 'Newbie'); assert.equal(r.body.user.name, 'New Person'); assert.equal(r.body.user.role, 'nurse');
  assert.equal(r.body.user.active, true); assert.equal(r.body.user.mustChangePassword, true); assert.equal(r.body.user.lastLoginAt, null);
  const tmp = r.body.temporaryPassword;
  assert.match(tmp, /^[A-Za-z0-9]{16}$/);
  assert.ok(!JSON.stringify(r.body.user).includes('scrypt') && !('password_hash' in r.body.user), 'no hash in the answer');
  const row = (await owner.query("SELECT password_hash,must_change_password FROM users WHERE username='Newbie'")).rows[0];
  assert.ok(row.must_change_password); assert.ok(!row.password_hash.includes(tmp)); assert.ok(await verifyPassword(tmp, row.password_hash));
  const login = await request(app).post('/api/login').send({ username: 'newbie', password: tmp });                   // works, and says it must be changed
  assert.equal(login.status, 200); assert.equal(login.body.mustChangePassword, true);
  assert.equal((await a.post('/api/users').send({ username: 'NEWBIE', name: 'x', role: 'viewer' })).status, 409, 'case-insensitive duplicate');
  assert.equal((await a.post('/api/users').send({ username: 'NEWBIE', name: 'x', role: 'viewer' })).body.error.code, 'username_taken');
  const typed = 'a typed password 123';
  const t = await a.post('/api/users').send({ username: 'typed1', name: 'Typed', role: 'doctor', password: typed });
  assert.equal(t.status, 201); assert.ok(!('temporaryPassword' in t.body), 'a typed password is never echoed'); assert.ok(!JSON.stringify(t.body).includes(typed));
  assert.equal((await request(app).post('/api/login').send({ username: 'typed1', password: typed })).status, 200);
  for (const bad of [{ username: 'x', name: 'x', role: 'nurse', password: 'short' }, { username: 'bad name', name: 'x', role: 'nurse' }, { username: 'ok2', name: '', role: 'nurse' },
    { username: 'ok2', name: 'x', role: 'boss' }, { username: 'ok2', name: 'x', role: 'nurse', mustChangePassword: false }, { username: 'ok2', name: 'x', role: 'nurse', active: false }]) {
    assert.equal((await a.post('/api/users').send(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await owner.query("SELECT 1 FROM users WHERE username='ok2'")).rows.length, 0);
});

test('list: fields, no secrets, newest login shown', async () => {
  const r = await who.admin.agent.get('/api/users');
  assert.equal(r.status, 200); assert.ok(r.body.length >= 6);
  const me = r.body.find((u) => u.username === 'u_admin');
  assert.deepEqual(Object.keys(me).sort(), ['active', 'createdAt', 'id', 'lastLoginAt', 'locked', 'mustChangePassword', 'name', 'role', 'username']);
  assert.ok(me.lastLoginAt, 'login stamped'); assert.equal(me.locked, false);
  assert.ok(!JSON.stringify(r.body).includes('scrypt'));
  const names = r.body.map((u) => u.username.toLowerCase()); assert.deepEqual(names, [...names].sort());
});

test('deactivate ends that user\'s sessions at once and blocks login; reactivate restores it and clears a lock; never deletes', async () => {
  const a = who.admin.agent, v = await mk('victim1', 'nurse');
  const v2 = await signIn('victim1'); assert.equal(await sessionsOf(v.id), 2);
  assert.equal((await v.agent.get('/api/cases')).status, 200);
  const before = await maxId();
  const r = await a.post(`/api/users/${v.id}/deactivate`).send({});
  assert.equal(r.status, 200); assert.equal(r.body.active, false);
  assert.equal(await sessionsOf(v.id), 0, 'all sessions removed in the same transaction');
  assert.equal((await v.agent.get('/api/cases')).status, 401); assert.equal((await v2.get('/api/cases')).status, 401);
  assert.equal((await request(app).post('/api/login').send({ username: 'victim1', password: PW })).status, 401);
  assert.equal((await a.post(`/api/users/${v.id}/deactivate`).send({})).body.error.code, 'already_inactive');
  const rows = await since(before); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'user.deactivate'); assert.equal(rows[0].entity_id, v.id);
  assert.equal(rows[0].after.sessionsEnded, 2); assert.equal(rows[0].before.active, true); assert.equal(rows[0].user_id, who.admin.id);
  await owner.query("UPDATE users SET failed_logins=5, locked_until=now()+interval '15 minutes' WHERE id=$1", [v.id]);
  const re = await a.post(`/api/users/${v.id}/reactivate`).send({});
  assert.equal(re.status, 200); assert.equal(re.body.active, true); assert.equal(re.body.locked, false);
  assert.equal((await a.post(`/api/users/${v.id}/reactivate`).send({})).body.error.code, 'already_active');
  assert.equal((await request(app).post('/api/login').send({ username: 'victim1', password: PW })).status, 200);
  assert.equal((await owner.query('SELECT count(*)::int n FROM users WHERE id=$1', [v.id])).rows[0].n, 1, 'the row is still there');
  assert.equal((await a.post('/api/users/11111111-1111-4111-8111-111111111111/deactivate').send({})).status, 404);
  assert.equal((await a.post('/api/users/not-a-uuid/deactivate').send({})).status, 404);
});

test('reset password: temporary password once, must change, sessions ended, lock cleared, old password dead; not for your own account', async () => {
  const a = who.admin.agent, v = await mk('victim2', 'doctor');
  await owner.query("UPDATE users SET failed_logins=5, locked_until=now()+interval '15 minutes' WHERE id=$1", [v.id]);
  const before = await maxId();
  const r = await a.post(`/api/users/${v.id}/reset-password`).send({});
  assert.equal(r.status, 200); assert.equal(r.body.user.mustChangePassword, true); assert.equal(r.body.user.locked, false);
  assert.match(r.body.temporaryPassword, /^[A-Za-z0-9]{16}$/);
  assert.equal(await sessionsOf(v.id), 0); assert.equal((await v.agent.get('/api/cases')).status, 401);
  assert.equal((await request(app).post('/api/login').send({ username: 'victim2', password: PW })).status, 401, 'old password no longer works');
  const login = await request(app).post('/api/login').send({ username: 'victim2', password: r.body.temporaryPassword });
  assert.equal(login.status, 200); assert.equal(login.body.mustChangePassword, true);
  const typed = await a.post(`/api/users/${v.id}/reset-password`).send({ password: 'another typed password' });
  assert.equal(typed.status, 200); assert.ok(!('temporaryPassword' in typed.body)); assert.ok(!JSON.stringify(typed.body).includes('another typed'));
  assert.equal((await a.post(`/api/users/${v.id}/reset-password`).send({ password: 'short' })).status, 400);
  assert.equal((await a.post(`/api/users/${who.admin.id}/reset-password`).send({})).body.error.code, 'use_password_change');
  const rows = await since(before); assert.deepEqual(rows.map((x) => x.action), ['user.reset_password', 'user.reset_password']);
  assert.equal(rows[0].after.generated, true); assert.equal(rows[1].after.generated, false);
});

test('role change: takes effect on the next request, same session; refuses no-op and an unknown role; audit has before and after', async () => {
  const a = who.admin.agent, v = await mk('victim3', 'viewer');
  assert.equal((await v.agent.post('/api/cases').send({})).status, 403);
  const before = await maxId();
  const r = await a.post(`/api/users/${v.id}/role`).send({ role: 'nurse' });
  assert.equal(r.status, 200); assert.equal(r.body.role, 'nurse');
  assert.equal((await v.agent.post('/api/cases').send({})).status, 201, 'a nurse can create a case, with the session she already had');
  assert.equal((await a.post(`/api/users/${v.id}/role`).send({ role: 'nurse' })).body.error.code, 'no_change');
  assert.equal((await a.post(`/api/users/${v.id}/role`).send({ role: 'root' })).status, 400);
  assert.equal((await a.post(`/api/users/${v.id}/role`).send({ role: 'doctor', active: false })).status, 400);
  const rows = (await since(before)).filter((x) => x.action.startsWith('user.')); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'user.role');
  assert.equal(rows[0].before.role, 'viewer'); assert.equal(rows[0].after.role, 'nurse');
});

test('POST /password: needs the right current password, policy, new differs; ends other sessions but keeps this one; clears must-change; no secrets in audit', async () => {
  const u = await mk('changer', 'nurse', { mustChange: true }), other = await signIn('changer');
  assert.equal(await sessionsOf(u.id), 2);
  const before = await maxId();
  const post = (body) => u.agent.post('/api/password').send(body);
  const wrong = await post({ currentPassword: 'not it at all!', newPassword: 'a brand new passphrase' });
  assert.equal(wrong.status, 422); assert.equal(wrong.body.error.code, 'wrong_password');
  assert.equal((await u.agent.get('/api/session')).status, 200, 'a wrong current password is not a sign-out (not 401)');
  assert.equal((await post({ currentPassword: PW, newPassword: 'short' })).status, 400);
  assert.equal((await post({ currentPassword: PW, newPassword: PW })).status, 400, 'must differ');
  assert.equal((await post({ currentPassword: PW, newPassword: 'a brand new passphrase', userId: who.admin.id })).status, 400, 'no other account can be named');
  assert.equal((await since(before)).length, 0, 'refused attempts write nothing');
  const NEW = 'a brand new passphrase';
  const ok = await post({ currentPassword: PW, newPassword: NEW });
  assert.equal(ok.status, 204);
  assert.equal((await u.agent.get('/api/cases')).status, 200, 'this session stays');
  assert.equal((await other.get('/api/cases')).status, 401, 'other sessions of the same user are ended');
  assert.equal(await sessionsOf(u.id), 1);
  const row = (await owner.query('SELECT password_hash,must_change_password FROM users WHERE id=$1', [u.id])).rows[0];
  assert.equal(row.must_change_password, false); assert.ok(await verifyPassword(NEW, row.password_hash)); assert.ok(!(await verifyPassword(PW, row.password_hash)));
  assert.equal((await request(app).post('/api/login').send({ username: 'changer', password: PW })).status, 401);
  const login = await request(app).post('/api/login').send({ username: 'changer', password: NEW });
  assert.equal(login.status, 200); assert.equal(login.body.mustChangePassword, false);
  const rows = await since(before); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'password.change'); assert.equal(rows[0].user_id, u.id);
  assert.equal(rows[0].after.otherSessionsEnded, 1);
});

test('audit rows for user changes never contain a password, a hash or a temporary password', async () => {
  const a = who.admin.agent, secret = 'typed secret passphrase 42';
  const made = await a.post('/api/users').send({ username: 'leaktest', name: 'Leak Test', role: 'viewer' });
  const gen = made.body.temporaryPassword;
  const id = made.body.user.id;
  const reset = await a.post(`/api/users/${id}/reset-password`).send({ password: secret });
  assert.equal(reset.status, 200);
  const lt = await signIn('leaktest', secret); await lt.post('/api/password').send({ currentPassword: secret, newPassword: 'yet another passphrase 7' });
  const all = JSON.stringify((await owner.query("SELECT * FROM audit_log WHERE action LIKE 'user.%' OR action = 'password.change'")).rows);
  for (const s of [gen, secret, 'yet another passphrase 7', 'scrypt$', 'password_hash']) assert.ok(!all.includes(s), 'audit must not contain: ' + s);
  const actions = (await owner.query("SELECT action FROM audit_log WHERE entity_id=$1 AND action NOT LIKE 'auth.%' ORDER BY id", [id])).rows.map((x) => x.action);
  assert.deepEqual(actions, ['user.create', 'user.reset_password', 'password.change']);
  // and the answer to a list or role change never carries one either
  const list = JSON.stringify((await a.get('/api/users')).body); assert.ok(!list.includes('scrypt') && !list.includes(secret));
});

test('/me and /session report mustChangePassword from the database on every call, so a reset or a change shows at once', async () => {
  const u = await mk('flagger', 'nurse', { mustChange: true });
  assert.equal((await u.agent.get('/api/session')).body.mustChangePassword, true); assert.equal((await u.agent.get('/api/me')).body.mustChangePassword, true);
  assert.equal((await u.agent.post('/api/password').send({ currentPassword: PW, newPassword: 'flag cleared passphrase' })).status, 204);
  assert.equal((await u.agent.get('/api/session')).body.mustChangePassword, false); assert.equal((await u.agent.get('/api/me')).body.mustChangePassword, false);
  await who.admin.agent.post(`/api/users/${u.id}/reset-password`).send({});
  assert.equal((await who.admin.agent.get('/api/users')).body.find((x) => x.id === u.id).mustChangePassword, true);
});

test('last-admin rule: the only active admin cannot be deactivated or demoted, not even by themselves; a second admin lifts it; two at once cannot both win', async () => {
  const only = who.admin;
  const cnt = async () => (await owner.query("SELECT count(*)::int n FROM users WHERE role='admin' AND active AND password_hash IS NOT NULL")).rows[0].n;
  assert.equal(await cnt(), 1);
  for (const [path, body, word] of [['deactivate', {}, 'deactivate'], ['role', { role: 'doctor' }, 'demote']]) {
    const r = await only.agent.post(`/api/users/${only.id}/${path}`).send(body);
    assert.equal(r.status, 409, path); assert.equal(r.body.error.code, 'last_admin'); assert.match(r.body.error.message, new RegExp(`cannot ${word} the last active administrator`));
  }
  assert.equal(await cnt(), 1); assert.equal((await only.agent.get('/api/users')).status, 200, 'still signed in and still admin');
  // a user without a password does not count as an admin who can sign in
  await owner.query("INSERT INTO users (username,name,role,password_hash) VALUES ('ghost_admin','Ghost','admin',NULL)");
  assert.equal((await only.agent.post(`/api/users/${only.id}/deactivate`).send({})).status, 409);
  // two admins, both try to remove the other at the same moment: exactly one succeeds
  const b = await mk('admin_b', 'admin'), c2 = await mk('admin_c', 'admin');
  assert.equal(await cnt(), 3);
  const bothRemoveOne = await Promise.all([b.agent.post(`/api/users/${only.id}/deactivate`).send({}), c2.agent.post(`/api/users/${only.id}/role`).send({ role: 'nurse' })]);
  assert.deepEqual(bothRemoveOne.map((r) => r.status), [200, 200], 'two different admins can leave: the others remain');
  assert.equal(await cnt(), 2);
  const race = await Promise.all([b.agent.post(`/api/users/${c2.id}/deactivate`).send({}), c2.agent.post(`/api/users/${b.id}/deactivate`).send({})]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409], 'never zero admins');
  assert.equal(await cnt(), 1);
  // an admin may step down once someone else is an admin
  const d = await mk('admin_d', 'admin');
  assert.equal((await d.agent.post(`/api/users/${d.id}/role`).send({ role: 'doctor' })).status, 200);
  assert.equal(await cnt(), 1);
});

test('the restricted database role can do all of this (sessions delete, users update) but still cannot touch the audit log', async () => {
  await assert.rejects(appDb.query("UPDATE audit_log SET action='x'"), /permission denied/);
  await assert.rejects(appDb.query('DELETE FROM audit_log'), /permission denied/);
  assert.equal((await appDb.query('SELECT 1 AS ok')).rows[0].ok, 1);
});
