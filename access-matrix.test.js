'use strict';
// node --test access-matrix.test.js  (needs DATABASE_URL; creates and drops its own database)
// R6: every seed element x every element action x every role, generated from the data (nothing is listed by hand).
//  1. canElement must equal "the element lists the role AND the role table allows the base action" (narrow, never widen).
//  2. Where a route enforces the action (enter = add a row, amend = patch a row), the route must answer 403 exactly when the rule says no.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const { readSeedSets, seedSets } = require('./seed.js');
const { ACCESS_ACTIONS } = require('./views.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_mx_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let db, app, caseId;
const who = {};                                   // role -> {id, agent}
const sets = readSeedSets();
const rowOf = {};                                 // setId -> row entered by the admin, to amend

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name)); await migrate(db, __dirname);
  app = createApp({ db });
  const h = await hashPassword(PW);
  for (const role of P.ROLES) {
    const id = (await db.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', ['u_' + role, 'User ' + role, role, h])).rows[0].id;
    const agent = request.agent(app);
    assert.equal((await agent.post('/api/login').send({ username: 'u_' + role, password: PW })).status, 200);
    agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
    who[role] = { id, agent };
  }
  await seedSets(db, sets);
  const c = await who.admin.agent.post('/api/cases').send({});
  assert.equal(c.status, 201); caseId = c.body.id;
  for (const s of sets) {                          // one admin row per set, for the amend checks
    const r = await who.admin.agent.post(`/api/cases/${caseId}/rows`).send({ setId: s.setId, groupId: 'g', row: { x: '1' } });
    assert.equal(r.status, 201, 'admin could not add a row to ' + s.setId);
    rowOf[s.setId] = r.body;
  }
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('MATRIX: canElement for every seed element, action and role is the element list narrowed by the role table', () => {
  let n = 0; const bad = [];
  for (const s of sets) for (const action of ACCESS_ACTIONS) for (const role of P.ROLES) {
    const expected = Array.isArray(s.access[action]) && s.access[action].includes(role) && P.can({ id: 'u', role }, P.ELEMENT_BASE_ACTION[action]);
    if (P.canElement({ id: 'u', role }, s, action) !== expected) bad.push(`${s.setId} ${action} ${role}`);
    n++;
  }
  assert.deepEqual(bad, []);
  console.log('access matrix: canElement cases =', n);
});

test('MATRIX: the row routes answer 403 exactly when the rule says no (enter = add a row, amend = patch a row)', async () => {
  let n = 0; const bad = [];
  for (const s of sets) for (const role of P.ROLES) {
    const user = { id: who[role].id, role };
    // enter: refused when the role rule (care sets only for a nurse) or the element's list says no
    const addOk = P.canAddRow(user, s.kind) && P.canElement(user, s, 'enter');
    const add = await who[role].agent.post(`/api/cases/${caseId}/rows`).send({ setId: s.setId, groupId: 'g', row: { x: '1' } });
    if (addOk ? add.status === 403 : add.status !== 403) bad.push(`enter ${s.setId} ${role} -> ${add.status}`);
    // amend: a deliberately stale version, so an allowed request ends in 409 and changes nothing; a refused one is 403 before the version is read
    const rowBy = { entered_by: who.admin.id };
    const amendOk = P.canAmendRow(user, rowBy, s.kind) && P.canElement(user, s, 'amend');
    const am = await who[role].agent.patch(`/api/cases/${caseId}/rows/${rowOf[s.setId].id}`).send({ expectedVersion: 999, row: { x: '2' }, reason: 'matrix check' });
    if (amendOk ? am.status !== 409 : am.status !== 403) bad.push(`amend ${s.setId} ${role} -> ${am.status}`);
    n += 2;
  }
  assert.deepEqual(bad, []);
  console.log('access matrix: route cases =', n);
});
