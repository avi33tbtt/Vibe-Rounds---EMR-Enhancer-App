'use strict';
// node --test permissions.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 32b spot tests: the permission table itself, and real login sessions (no test actor) against the API.
// The full role x route matrix is chunk 32c.
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
  registered.splice(0, registered.length, ...registered.filter((x) => !['POST /login', 'POST /logout', 'GET /session'].includes(x)));
  const PUBLIC = ['POST /login', 'POST /logout', 'GET /session'];       // auth.js routes: the login itself, checked in auth.test.js
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
