'use strict';
// node --test permissions.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 32b spot tests: the permission table itself, and real login sessions (no test actor) against the API.
// Chunk 32c adds: the role x route matrix generated from the table, the CSRF check, and the author-forgery checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { mountApi } = require('./api.js');
const { hashPassword } = require('./auth.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_perm_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let db, app;
const who = {};                                   // role -> {id, agent}

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name)); await migrate(db, __dirname);
  app = createApp({ db });                        // NO getActor: real sessions only
  const h = await hashPassword(PW);
  for (const role of P.ROLES) {
    const id = (await db.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', ['u_' + role, 'User ' + role, role, h])).rows[0].id;
    const agent = request.agent(app);
    assert.equal((await agent.post('/api/login').send({ username: 'u_' + role, password: PW })).status, 200);
    agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);        // chunk 32c: state-changing requests carry this session's token
    who[role] = { id, agent };
  }
  const ins = (id, kind) => db.query(`INSERT INTO element_sets (set_id,version,kind,body,source) VALUES ($1,1,$2,'{}','user')`, [id, kind]);
  await ins('care.t', 'care'); await ins('disease.t', 'disease');
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('table: every route has a defined action, every action has valid roles, unknown actions fail loudly', () => {
  for (const [route, action] of Object.entries(P.ROUTE_ACTIONS)) assert.ok(P.ACTIONS[action], route + ' -> undefined action ' + action);
  for (const [action, roles] of Object.entries(P.ACTIONS)) { assert.ok(roles.length, action + ' has no role'); roles.forEach((r) => assert.ok(P.ROLES.includes(r), action + ': bad role ' + r)); }
  assert.throws(() => P.can({ role: 'admin' }, 'row.ad'), /Unknown permission action/);
  assert.equal(P.can(null, 'case.read'), false);
});

test('table: only doctor or admin approve; informatician and viewer never chart; PATCH case needs any field right', () => {
  assert.deepEqual([...P.ACTIONS['rule.approve']].sort(), ['admin', 'doctor']);
  assert.deepEqual([...P.ACTIONS['protocol.approve']].sort(), ['admin', 'doctor']);
  for (const role of ['informatician', 'viewer']) for (const a of ['row.add', 'row.amend_own', 'case.narrative', 'case.apply', 'note.write', 'value.write', 'rule.approve']) assert.equal(P.can({ role }, a), false, role + ' ' + a);
  assert.ok(P.ACTIONS['case.patch'].includes('nurse') && !P.ACTIONS['case.patch'].includes('viewer'));
});

test('every route registered in api.js is in ROUTE_ACTIONS, and every entry is registered (no stale or forgotten routes)', () => {
  const layers = (app._router || app.router).stack.filter((l) => l.handle && l.handle.stack && l.handle.stack.some((x) => x.route));
  const registered = layers.flatMap((l) => l.handle.stack.filter((x) => x.route).flatMap((x) => Object.keys(x.route.methods).map((m) => m.toUpperCase() + ' ' + x.route.path)));
  assert.ok(registered.length > 40, 'router not found');
  registered.splice(0, registered.length, ...registered.filter((x) => !['POST /login', 'POST /logout', 'GET /session', 'GET /csrf'].includes(x)));
  const PUBLIC = ['POST /login', 'POST /logout', 'GET /session', 'GET /csrf'];       // auth.js routes: the login itself, checked in auth.test.js
  for (const k of registered.filter((x) => !PUBLIC.includes(x))) assert.ok(P.ROUTE_ACTIONS[k], 'route without action: ' + k);
  for (const k of Object.keys(P.ROUTE_ACTIONS)) assert.ok(registered.includes(k), 'ROUTE_ACTIONS entry for a route that does not exist: ' + k);
});

test('a route registered without an action stops the server from starting; getActor override is refused in production', () => {
  assert.throws(() => P.guardRouter(express.Router()).get('/new-route', () => {}), /No permission action/);
  const old = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { assert.throws(() => mountApi(express(), { db, getActor: async () => ({ id: 'x', role: 'admin' }) }), /tests only/); } finally { process.env.NODE_ENV = old; }
  assert.throws(() => mountApi(express(), { db }), /requireAuth/);
});

test('no session, a forged test header or a stale cookie is a 401 on every kind of route', async () => {
  for (const [m, p] of [['get', '/api/cases'], ['post', '/api/cases'], ['get', '/api/rules'], ['post', '/api/import'], ['get', '/api/me']]) {
    const r = await request(app)[m](p).set('x-test-role', 'admin').set('Cookie', 'emr_sid=' + 'a'.repeat(64)).send({});
    assert.equal(r.status, 401, m + ' ' + p); assert.equal(r.body.error.code, 'unauthorized');
  }
});

test('viewer reads but cannot change anything clinical; keeps own preferences', async () => {
  const v = who.viewer.agent;
  assert.equal((await v.get('/api/cases')).status, 200);
  assert.equal((await v.get('/api/rules')).status, 200);
  assert.equal((await v.get('/api/me')).body.role, 'viewer');
  const r = await v.post('/api/cases').send({});
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'forbidden');
  assert.equal((await v.put('/api/prefs/density').send({ value: 'compact' })).status, 200);
  assert.equal((await v.post('/api/import/dry-run').send({})).status, 403);
});

test('nurse: charts in care sets only, amends only her own readings, cannot change narrative or sets, can pin and acknowledge', async () => {
  const n = who.nurse.agent, d = who.doctor.agent;
  const c = (await n.post('/api/cases').send({ patient: { name: 'N', ageSex: '1 M', bed: 'B', mrn: '1' } })).body;
  assert.equal(c.version, 1);
  const bad = await n.post(`/api/cases/${c.id}/rows`).send({ setId: 'care.t', groupId: 'g', row: { a: 1 }, enteredBy: who.doctor.id });
  assert.equal(bad.status, 400, 'author fields in the body are rejected, never read');
  const mine = await n.post(`/api/cases/${c.id}/rows`).send({ setId: 'care.t', groupId: 'g', row: { a: 1 } });
  assert.equal(mine.status, 201); assert.equal(mine.body.enteredBy, who.nurse.id, 'entered_by comes from the session');
  assert.equal((await n.post(`/api/cases/${c.id}/rows`).send({ setId: 'disease.t', groupId: 'g', row: { a: 1 } })).status, 403);
  assert.equal((await n.post(`/api/cases/${c.id}/rows`).send({ setId: 'no.such.set', groupId: 'g', row: { a: 1 } })).status, 403, 'unknown set: cannot be shown to be a care set');
  const theirs = (await d.post(`/api/cases/${c.id}/rows`).send({ setId: 'care.t', groupId: 'g', row: { a: 2 } })).body;
  assert.equal((await n.patch(`/api/cases/${c.id}/rows/${theirs.id}`).send({ expectedVersion: 1, row: { a: 9 } })).status, 403);
  assert.equal((await n.post(`/api/cases/${c.id}/rows/${theirs.id}/error`).send({ expectedVersion: 1, reason: 'wrong patient' })).status, 403);
  assert.equal((await n.patch(`/api/cases/${c.id}/rows/${mine.body.id}`).send({ expectedVersion: 1, row: { a: 3 } })).status, 200);
  assert.equal((await d.patch(`/api/cases/${c.id}/rows/${mine.body.id}`).send({ expectedVersion: 2, row: { a: 4 } })).status, 200, 'a doctor may amend any row');
  assert.equal((await n.patch(`/api/cases/${c.id}`).send({ expectedVersion: 1, narrative: 'x' })).status, 403);
  assert.equal((await n.patch(`/api/cases/${c.id}`).send({ expectedVersion: 1, applied: [] })).status, 403);
  const v = (await n.get('/api/cases/' + c.id)).body.version;
  assert.equal((await n.patch(`/api/cases/${c.id}`).send({ expectedVersion: v, pinned: [] })).status, 200);
  assert.equal((await n.patch(`/api/cases/${c.id}`).send({ expectedVersion: v + 1, narrative: 'a', pinned: [] })).status, 403, 'one forbidden field refuses the whole change');
  assert.equal((await n.post(`/api/cases/${c.id}/notes`).send({ type: 'narrative' })).status, 403);
  assert.equal((await n.put(`/api/cases/${c.id}/values`).send({ key: 'care.t/x', value: 1, expectedVersion: 0 })).status, 403);
});

test('rules: nurse and informatician cannot write or approve; doctor can; the approver is the session user; an edit resets approval', async () => {
  const body = { field: 'care.t/x', op: '>', threshold: 1 };
  for (const role of ['nurse', 'informatician', 'viewer']) assert.equal((await who[role].agent.put('/api/rules/care.t/r1').send({ body, expectedVersion: 0 })).status, 403, role);
  const d = who.doctor.agent;
  const r1 = await d.put('/api/rules/care.t/r1').send({ body, expectedVersion: 0 });
  assert.equal(r1.status, 200);
  for (const role of ['nurse', 'informatician', 'viewer']) assert.equal((await who[role].agent.post('/api/rules/care.t/r1/approve').send({ expectedVersion: 1 })).status, 403, role);
  const ok = await d.post('/api/rules/care.t/r1/approve').send({ expectedVersion: 1 });
  assert.equal(ok.status, 200); assert.equal(ok.body.enabled, true); assert.equal(ok.body.verifiedBy, who.doctor.id);
  const ed = await d.put('/api/rules/care.t/r1').send({ body: { ...body, threshold: 2 }, expectedVersion: 2 });
  assert.equal(ed.body.enabled, false); assert.equal(ed.body.verifiedBy, null);
  assert.equal((await who.nurse.agent.post('/api/protocols/care.t/approve').send({ expectedVersion: 1 })).status, 403);
});

test('informatician authors sets and codes but cannot chart; only admin imports; set read-only rules still apply to admin', async () => {
  const i = who.informatician.agent;
  assert.equal((await i.post('/api/element-sets').send({ setId: 'care.inf', kind: 'care', body: { title: 'T' } })).status, 201);
  assert.equal((await i.post('/api/codes').send({ system: 'loinc', code: '8310-5', display: 'Body temperature' })).status, 201);
  assert.equal((await i.post('/api/cases').send({})).status, 403);
  assert.equal((await who.nurse.agent.post('/api/element-sets').send({ setId: 'care.nn', kind: 'care', body: {} })).status, 403);
  assert.equal((await who.doctor.agent.post('/api/import/dry-run').send({})).status, 403);
  assert.equal((await who.admin.agent.post('/api/import/dry-run').send({})).status, 200);
});

// ---------------------------------------------------------------- chunk 32c: generated matrix, CSRF, forgery
const PARAMS = { id: '11111111-1111-4111-8111-111111111111', nid: '11111111-1111-4111-8111-111111111111', rowId: '11111111-1111-4111-8111-111111111111',
  setId: 'care.t', owner: 'care.t', ruleId: 'r9', system: 'loinc', code: '8310-5', fieldId: 'f', key: 'k', n: '1' };
const urlOf = (path) => '/api' + path.replace(/:(\w+)/g, (_, k) => PARAMS[k]);
const splitRoute = (k) => { const i = k.indexOf(' '); return [k.slice(0, i).toLowerCase(), k.slice(i + 1)]; };

test('MATRIX: every role against every route: allowed means not 401/403, otherwise 403 forbidden; logged out is always 401', async () => {
  const bad = [];
  for (const [route, action] of Object.entries(P.ROUTE_ACTIONS)) {
    const [m, path] = splitRoute(route);
    for (const role of P.ROLES) {
      const r = await who[role].agent[m](urlOf(path)).send({});
      const ok = P.ACTIONS[action].includes(role);
      if (ok ? (r.status === 401 || r.status === 403) : !(r.status === 403 && r.body.error && r.body.error.code === 'forbidden')) bad.push(`${role} ${route} (${action}) -> ${r.status} ${r.body.error ? r.body.error.code : ''}`);
    }
    const out = await request(app)[m](urlOf(path)).send({});
    if (out.status !== 401) bad.push(`logged out ${route} -> ${out.status}`);
  }
  assert.deepEqual(bad, [], 'unprotected or wrongly protected routes');
});

test('CSRF: GET /csrf needs a session; a state-changing request without, with a wrong, or with another session\'s token is 403 csrf on every route', async () => {
  assert.equal((await request(app).get('/api/csrf')).status, 401);
  const fresh = request.agent(app);
  await fresh.post('/api/login').send({ username: 'u_admin', password: PW });
  const tok = (await fresh.get('/api/csrf')).body.token;
  assert.match(tok, /^[0-9a-f]{64}$/);
  const other = request.agent(app); await other.post('/api/login').send({ username: 'u_admin', password: PW });
  const otherTok = (await other.get('/api/csrf')).body.token;
  assert.notEqual(tok, otherTok, 'the token belongs to one session');
  assert.equal((await fresh.get('/api/cases')).status, 200, 'GET needs no token');
  for (const route of Object.keys(P.ROUTE_ACTIONS).filter((k) => !k.startsWith('GET '))) {
    const [m, path] = splitRoute(route);
    for (const h of [null, 'wrong', otherTok]) {
      const q = fresh[m](urlOf(path)); if (h) q.set('x-csrf-token', h);
      const r = await q.send({});
      assert.equal(r.status, 403, route + ' with ' + (h || 'no header')); assert.equal(r.body.error.code, 'csrf', route);
    }
  }
  const ok = await fresh.post('/api/cases').set('x-csrf-token', tok).send({});
  assert.equal(ok.status, 201);
});

test('FORGERY: entered_by, created_by, verified_by, signed_by and added_by come from the session; the same key in a body is rejected', async () => {
  const d = who.doctor, n = who.nurse, other = who.admin.id;
  const c = (await d.agent.post('/api/cases').send({})).body;
  const note = (await d.agent.post(`/api/cases/${c.id}/notes`).send({ type: 'narrative', text: 'x' })).body;
  const cases = [
    ['POST', '/api/cases', {}, d, 'SELECT created_by v FROM cases ORDER BY created_at DESC LIMIT 1'],
    ['POST', `/api/cases/${c.id}/rows`, { setId: 'care.t', groupId: 'g', row: { a: 1 } }, n, `SELECT entered_by v FROM case_rows WHERE case_id='${c.id}' ORDER BY entered_at DESC LIMIT 1`],
    ['POST', `/api/cases/${c.id}/notes`, { type: 'narrative' }, d, `SELECT created_by v FROM case_notes WHERE case_id='${c.id}' ORDER BY created_at DESC LIMIT 1`],
    ['POST', `/api/cases/${c.id}/notes/${note.id}/sign`, { expectedVersion: 1 }, d, `SELECT signed_by v FROM case_notes WHERE id='${note.id}'`],
    ['PUT', '/api/rules/care.t/rf', { body: { field: 'care.t/x', op: '>', threshold: 1 }, expectedVersion: 0 }, d, "SELECT created_by v FROM cds_rules WHERE rule_id='rf'"],
    ['POST', '/api/rules/care.t/rf/approve', { expectedVersion: 1 }, d, "SELECT verified_by_user v FROM cds_rules WHERE rule_id='rf'"],
    ['PUT', '/api/protocols/care.t', { body: { bands: [{ min: '', max: '', instruction: 'typed text' }] }, expectedVersion: 0 }, d, null],
    ['POST', '/api/protocols/care.t/approve', { expectedVersion: 1 }, d, "SELECT verified_by_user v FROM protocols WHERE set_id='care.t'"],
    ['POST', '/api/codes', { system: 'loinc', code: '8867-4', display: 'Heart rate' }, d, "SELECT added_by v FROM verified_codes WHERE code='8867-4'"],
    ['POST', '/api/element-sets', { setId: 'care.forge', kind: 'care', body: {} }, d, "SELECT created_by v FROM element_sets WHERE set_id='care.forge'"],
  ];
  for (const [m, url, body, who_, sql] of cases) {
    for (const key of ['enteredBy', 'entered_by', 'createdBy', 'created_by', 'verifiedBy', 'verified_by', 'signedBy', 'addedBy', 'checkedBy']) {
      const r = await who_.agent[m.toLowerCase()](url).send({ ...body, [key]: other });
      assert.equal(r.status, 400, `${m} ${url} accepted a body key ${key}`);
    }
    const r = await who_.agent[m.toLowerCase()](url).send(body);
    assert.ok(r.status >= 200 && r.status < 300, `${m} ${url} -> ${r.status} ${JSON.stringify(r.body.error || '')}`);
    if (sql) assert.equal((await db.query(sql)).rows[0].v, who_.id, `${m} ${url}: author is the session user`);
  }
});

// ---------------------------------------------------------------- chunk 32d2: /me lists the allowed actions; hiding is never relied on
test('32d2: GET /me, /session and login return the allowed actions of the role, matching the table exactly', async () => {
  for (const role of P.ROLES) {
    const a = who[role].agent, expected = Object.keys(P.ACTIONS).filter((x) => P.ACTIONS[x].includes(role));
    assert.deepEqual((await a.get('/api/me')).body.allowed, expected, role + ' /me');
    assert.deepEqual((await a.get('/api/session')).body.allowed, expected, role + ' /session');
  }
  const nurse = (await who.nurse.agent.get('/api/me')).body.allowed, doctor = (await who.doctor.agent.get('/api/me')).body.allowed;
  for (const a of ['rule.approve', 'rule.write', 'protocol.approve', 'protocol.write', 'note.sign', 'note.write']) { assert.ok(!nurse.includes(a), 'nurse sees no ' + a); assert.ok(doctor.includes(a), 'doctor has ' + a); }
  const r = await request(app).post('/api/login').send({ username: 'u_nurse', password: PW });
  assert.deepEqual(r.body.allowed, nurse, 'login returns the same list');
});

test('32d2: hiding is not relied on: a nurse calling approve, sign, note and rule routes directly gets 403 with a plain sentence naming the action', async () => {
  const n = who.nurse.agent, id = '00000000-0000-4000-8000-000000000001';
  const cases = [
    ['post', '/api/rules/care.t/r1/approve', 'rule.approve', /may not approve alert rules\.$/],
    ['post', '/api/protocols/disease.t/approve', 'protocol.approve', /may not verify protocols\.$/],
    ['put', '/api/rules/care.t/r1', 'rule.write', /may not edit alert rules\.$/],
    ['post', `/api/cases/${id}/notes/${id}/sign`, 'note.sign', /may not sign notes\.$/],
    ['post', `/api/cases/${id}/notes`, 'note.write', /may not write notes\.$/],
  ];
  for (const [m, p, action, re] of cases) {
    const r = await n[m](p).send({});
    assert.equal(r.status, 403, p); assert.equal(r.body.error.code, 'forbidden'); assert.equal(r.body.error.action, action);
    assert.match(r.body.error.message, /^Your role \(nurse\) /); assert.match(r.body.error.message, re);
  }
  const d = await who.doctor.agent.post(`/api/cases/${id}/notes/${id}/sign`).send({});
  assert.notEqual(d.status, 403, 'a doctor passes the permission check (it then fails on the missing case, not on the role)');
});

test('32d2: a typed name in a request body is ignored: the server stamps the approver from the session', async () => {
  const d = who.doctor.agent;
  assert.equal((await d.put('/api/rules/care.t/rx').send({ body: { ruleId: 'rx', fieldRef: 'care.t/f', op: '>', threshold: 1, indicator: 'info', summary: 's', provenance: { source: 'manual', verifiedBy: 'Dr Forged' } }, expectedVersion: 0 })).status, 200);
  const ap = await d.post('/api/rules/care.t/rx/approve').send({ expectedVersion: 1 }); assert.equal(ap.status, 200);
  const got = (await d.get('/api/rules')).body['care.t'].find((x) => x.ruleId === 'rx');
  assert.equal(got.verifiedBy, who.doctor.id); assert.equal(got.verifiedByName, 'User doctor'); assert.ok(!JSON.stringify(got).includes('Dr Forged'), 'the typed name is not stored anywhere');
});

test('32d2: a typed verifier in a protocol body is not stored; approval is stamped from the session', async () => {
  const d = who.doctor.agent;
  const put = await d.put('/api/protocols/disease.t').send({ body: { bands: [{ min: '1', max: '2', instruction: 'x' }], verifiedBy: 'Dr Forged' }, expectedVersion: 0 }); assert.equal(put.status, 200);
  const g1 = (await d.get('/api/protocols')).body['disease.t']; assert.equal(g1.verifiedBy, null); assert.ok(!JSON.stringify(g1).includes('Dr Forged'));
  assert.equal((await d.post('/api/protocols/disease.t/approve').send({ expectedVersion: put.body.version })).status, 200);
  const g2 = (await d.get('/api/protocols')).body['disease.t']; assert.equal(g2.verifiedBy, who.doctor.id); assert.equal(g2.verifiedByName, 'User doctor');
});

// ---------- chunk 32e3: a temporary password blocks every route except the password change ----------
const TEMP_PW = 'a brand new passphrase';
const PW_BLOCK = 'Change your temporary password before continuing.';
let tempN = 0;
async function tempUser(role = 'admin', mustChange = true) {                       // a real user and a real session, like the other tests here
  const username = `tmp_${role}_${++tempN}`;
  const id = (await db.query('INSERT INTO users (username,name,role,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING id', [username, 'Temp ' + role, role, await hashPassword(PW), mustChange])).rows[0].id;
  const agent = request.agent(app);
  const li = await agent.post('/api/login').send({ username, password: PW }); assert.equal(li.status, 200); assert.equal(li.body.mustChangePassword, mustChange);
  agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
  return { id, username, agent };
}
const blocked = (r, what) => { assert.equal(r.status, 403, what); assert.equal(r.body.error.code, 'password_change_required', what); assert.equal(r.body.error.message, PW_BLOCK, what); };

test('32e3: a user with a temporary password gets 403 password_change_required on cases and users, but 200 on /me and 204 on POST /password', async () => {
  const t = await tempUser('admin');
  blocked(await t.agent.get('/api/cases'), 'GET /cases');
  blocked(await t.agent.post('/api/cases').send({}), 'POST /cases');
  blocked(await t.agent.get('/api/users'), 'GET /users');
  const me = await t.agent.get('/api/me'); assert.equal(me.status, 200); assert.equal(me.body.mustChangePassword, true);
  const se = await t.agent.get('/api/session'); assert.equal(se.status, 200); assert.equal(se.body.mustChangePassword, true);
  assert.equal((await t.agent.get('/api/csrf')).status, 200);
  assert.equal((await t.agent.post('/api/password').send({ currentPassword: PW, newPassword: TEMP_PW })).status, 204);
});

test('32e3: after the change the same session works at once and /me reports mustChangePassword false', async () => {
  const t = await tempUser('doctor');
  blocked(await t.agent.get('/api/cases'), 'before the change');
  assert.equal((await t.agent.post('/api/password').send({ currentPassword: PW, newPassword: TEMP_PW })).status, 204);
  assert.equal((await t.agent.get('/api/cases')).status, 200, 'same session, no new login');
  assert.equal((await t.agent.get('/api/me')).body.mustChangePassword, false);
  assert.equal((await t.agent.get('/api/session')).body.mustChangePassword, false);
});

test('32e3: a failed change (wrong current password, too short) does not lift the block', async () => {
  const t = await tempUser('nurse');
  assert.equal((await t.agent.post('/api/password').send({ currentPassword: 'wrong wrong wrong', newPassword: TEMP_PW })).status, 422);
  assert.equal((await t.agent.post('/api/password').send({ currentPassword: PW, newPassword: 'short' })).status, 400);
  blocked(await t.agent.get('/api/cases'), 'still blocked');
  assert.equal((await db.query('SELECT must_change_password FROM users WHERE id=$1', [t.id])).rows[0].must_change_password, true);
});

test('32e3: every route in the table except GET /me and POST /password is refused with password_change_required, for every role, before the role check', async () => {
  const keep = new Set(['GET /me', 'POST /password']), bad = [];
  for (const role of P.ROLES) {
    const t = await tempUser(role);
    for (const route of Object.keys(P.ROUTE_ACTIONS)) {
      if (keep.has(route)) continue;
      const [m, path] = splitRoute(route), r = await t.agent[m](urlOf(path)).send({});
      if (r.status !== 403 || !r.body.error || r.body.error.code !== 'password_change_required') bad.push(`${role} ${route} -> ${r.status} ${r.body.error ? r.body.error.code : ''}`);
    }
    blocked(await t.agent.get('/api/not-a-route'), 'unknown routes are refused too (deny by default)');
  }
  assert.deepEqual(bad, []);
});

test('32e3: the flag is read from the database on every request: setting it blocks an already signed-in session on the very next request, clearing it lifts the block', async () => {
  const t = await tempUser('doctor', false);
  assert.equal((await t.agent.get('/api/cases')).status, 200);
  await db.query('UPDATE users SET must_change_password=true WHERE id=$1', [t.id]);
  blocked(await t.agent.get('/api/cases'), 'next request after the flag was set');
  await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [t.id]);
  assert.equal((await t.agent.get('/api/cases')).status, 200, 'and lifted at once');
});

test('32e3: an admin reset stops a signed-in user on the very next request, and the new temporary password is blocked until it is changed', async () => {
  const t = await tempUser('nurse', false);
  assert.equal((await t.agent.get('/api/cases')).status, 200);
  const rs = await who.admin.agent.post(`/api/users/${t.id}/reset-password`).send({ password: 'reset by the admin 1' });
  assert.equal(rs.status, 200);
  assert.equal((await t.agent.get('/api/cases')).status, 401, 'the reset also ends the old sessions: not served either way');
  const again = request.agent(app), li = await again.post('/api/login').send({ username: t.username, password: 'reset by the admin 1' });
  assert.equal(li.status, 200); assert.equal(li.body.mustChangePassword, true);
  again.set('x-csrf-token', (await again.get('/api/csrf')).body.token);
  blocked(await again.get('/api/cases'), 'new session with the temporary password');
  assert.equal((await again.post('/api/password').send({ currentPassword: 'reset by the admin 1', newPassword: TEMP_PW })).status, 204);
  assert.equal((await again.get('/api/cases')).status, 200);
});

test('32e3: logout still works while the password change is pending, and the block is not shown to users without the flag', async () => {
  const t = await tempUser('viewer');
  assert.equal((await t.agent.post('/api/logout')).status, 204);
  assert.equal((await t.agent.get('/api/me')).status, 401);
  const ok = await tempUser('viewer', false);
  assert.equal((await ok.agent.get('/api/cases')).status, 200);
});
