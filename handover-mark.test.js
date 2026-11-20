'use strict';
// node --test handover-mark.test.js  (needs DATABASE_URL; creates and drops its own database)
// 37d4: "last handover" time per user and case, set with the server's clock, kept in user_prefs. Same set-up as permissions.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_ho_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let db, app, caseA, caseB;
const who = {};

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
  caseA = (await who.doctor.agent.post('/api/cases').send({})).body.id;
  caseB = (await who.doctor.agent.post('/api/cases').send({})).body.id;
  assert.ok(caseA && caseB);
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

const get = (role, id) => who[role].agent.get(`/api/cases/${id}/handover`);
const mark = (role, id, body = {}) => who[role].agent.post(`/api/cases/${id}/handover`).send(body);
const marks = async () => (await db.query(`SELECT * FROM audit_log WHERE action='handover.mark' AND case_id=$1 ORDER BY 1`, [caseA])).rows;

test('before any mark the time is null', async () => {
  const r = await get('doctor', caseA);
  assert.equal(r.status, 200);
  assert.equal(r.body.lastHandoverAt, null);
});
test('marking uses the server clock, whatever the browser sends; GET returns the same time', async () => {
  const t0 = Date.now();
  const r = await mark('doctor', caseA, { at: '2001-01-01T00:00:00Z', lastHandoverAt: '2001-01-01T00:00:00Z' });
  assert.equal(r.status, 200);
  const at = new Date(r.body.lastHandoverAt).getTime();
  assert.ok(Math.abs(at - t0) < 60000, 'time is now, not the one sent');
  assert.equal((await get('doctor', caseA)).body.lastHandoverAt, r.body.lastHandoverAt);
});
test('the time is per user: another user still sees null on the same case', async () => {
  assert.equal((await get('nurse', caseA)).body.lastHandoverAt, null);
  assert.equal((await mark('nurse', caseA)).status, 200);
  assert.notEqual((await get('nurse', caseA)).body.lastHandoverAt, null);
});
test('the time is per case: the same user has no time on another case', async () => {
  assert.equal((await get('doctor', caseB)).body.lastHandoverAt, null);
});
test('a viewer may read but not mark; an unknown case is 404', async () => {
  assert.equal((await get('viewer', caseA)).status, 200);
  assert.equal((await mark('viewer', caseA)).status, 403);
  const none = '22222222-2222-4222-8222-222222222222';
  assert.equal((await get('doctor', none)).status, 404);
  assert.equal((await mark('doctor', none)).status, 404);
});
test('the preference route cannot set it', async () => {
  const r = await who.doctor.agent.put(`/api/prefs/handover.${caseA}`).send({ value: { at: '2001-01-01T00:00:00Z' } });
  assert.equal(r.status, 400);
});
test('each mark writes one audit row; a second mark records the earlier time as before', async () => {
  const before = (await marks()).length;
  await mark('doctor', caseA);
  const rows = await marks();
  assert.equal(rows.length, before + 1);
  const last = JSON.stringify(rows[rows.length - 1]);
  assert.match(last, /"before":\{"at":"/);
});
