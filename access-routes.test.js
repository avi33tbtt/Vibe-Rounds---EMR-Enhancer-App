'use strict';
// node --test access-routes.test.js  (needs DATABASE_URL; creates and drops its own database)
// R4: a set's access block narrows who may enter or amend rows and values. Made-up sets only. Same set-up as permissions.test.js.
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
const name = 'emr_acc_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let db, app, caseId;
const who = {};                                   // role -> {id, agent}

// made-up sets: who may enter and amend is the only thing that differs
const SETS = {
  'made.acc_doctor_only': { kind: 'care', access: { view: P.ROLES, enter: ['doctor'], amend: ['doctor'] } },
  'made.acc_nurse_enter': { kind: 'care', access: { view: P.ROLES, enter: ['nurse', 'doctor'], amend: ['doctor'] } },
  'made.acc_amend_nurse': { kind: 'care', access: { view: P.ROLES, enter: ['doctor'], amend: ['nurse'] } },
  'made.acc_no_block': { kind: 'care' },          // legacy: no access block, today's rules apply until R5
};

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
  for (const [id, s] of Object.entries(SETS)) {
    await db.query(`INSERT INTO element_sets (set_id,version,kind,body,source) VALUES ($1,1,$2,$3,'user')`, [id, s.kind, JSON.stringify(s.access ? { access: s.access } : {})]);
  }
  const c = await who.doctor.agent.post('/api/cases').send({});
  assert.equal(c.status, 201); caseId = c.body.id; assert.ok(caseId);
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

const addRow = (role, setId) => who[role].agent.post(`/api/cases/${caseId}/rows`).send({ setId, groupId: 'g', row: { x: '1' } });
const auditCount = async (action) => (await db.query('SELECT count(*)::int n FROM audit_log WHERE action=$1 AND case_id=$2', [action, caseId])).rows[0].n;

test('enter: a nurse is refused where the set does not list nurse, and no audit row is written', async () => {
  const before = await auditCount('row.add');
  const r = await addRow('nurse', 'made.acc_doctor_only');
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /element action: enter/);
  assert.equal(await auditCount('row.add'), before);
});
test('enter: a doctor listed for the set is allowed, with one audit row', async () => {
  const before = await auditCount('row.add');
  assert.equal((await addRow('doctor', 'made.acc_doctor_only')).status, 201);
  assert.equal(await auditCount('row.add'), before + 1);
});
test('enter: a nurse listed for the set (and allowed by the role table) is allowed', async () => {
  assert.equal((await addRow('nurse', 'made.acc_nurse_enter')).status, 201);
});
test('enter: a viewer listed for enter still cannot (the set never widens the role table)', async () => {
  await db.query(`INSERT INTO element_sets (set_id,version,kind,body,source) VALUES ('made.acc_viewer_listed',1,'care',$1,'user')`, [JSON.stringify({ access: { enter: ['viewer', 'nurse'] } })]);
  assert.equal((await addRow('viewer', 'made.acc_viewer_listed')).status, 403);
});
test('amend: the set\'s amend list is refused to a nurse who entered the row herself', async () => {
  const row = (await addRow('nurse', 'made.acc_nurse_enter')).body;
  const r = await who.nurse.agent.patch(`/api/cases/${caseId}/rows/${row.id}`).send({ expectedVersion: row.version, row: { x: '2' }, reason: 'fix typo' });
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /element action: amend/);
});
test('amend: a doctor listed for amend is allowed; a doctor not listed is refused', async () => {
  const ok = (await addRow('doctor', 'made.acc_nurse_enter')).body;
  assert.equal((await who.doctor.agent.patch(`/api/cases/${caseId}/rows/${ok.id}`).send({ expectedVersion: ok.version, row: { x: '2' }, reason: 'fix typo' })).status, 200);
  const no = (await addRow('doctor', 'made.acc_amend_nurse')).body;
  const r = await who.doctor.agent.patch(`/api/cases/${caseId}/rows/${no.id}`).send({ expectedVersion: no.version, row: { x: '2' }, reason: 'fix typo' });
  assert.equal(r.status, 403);
  const e = await who.doctor.agent.post(`/api/cases/${caseId}/rows/${no.id}/error`).send({ expectedVersion: no.version, reason: 'wrong patient' });
  assert.equal(e.status, 403);
});
test('values: a new value needs enter, a replacement needs amend', async () => {
  const put = (setId, expectedVersion) => who.doctor.agent.put(`/api/cases/${caseId}/values`).send({ key: setId + '/f1', value: 'a', expectedVersion, reason: 'update' });
  assert.equal((await put('made.acc_amend_nurse', 0)).status, 200);          // enter lists doctor
  const r = await put('made.acc_amend_nurse', 1);                            // amend lists nurse only
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /element action: amend/);
  assert.equal((await who.nurse.agent.put(`/api/cases/${caseId}/values`).send({ key: 'made.acc_doctor_only/f1', value: 'a', expectedVersion: 0 })).status, 403);   // the role table refuses a nurse first
});
test('transitional: a set with no access block keeps today\'s rules', async () => {
  assert.equal((await addRow('nurse', 'made.acc_no_block')).status, 201);
  assert.equal((await addRow('doctor', 'made.acc_no_block')).status, 201);
  assert.equal((await addRow('viewer', 'made.acc_no_block')).status, 403);
});
