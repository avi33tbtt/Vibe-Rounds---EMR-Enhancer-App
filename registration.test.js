'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const P = (o = {}) => ({ name: 'Test Patient', mrn: 'MRN001', dob: '1980-05-17', sex: 'F', ...o });
const as = async u => { const c = client(env.base); const r = await c.login(u); assert.equal(r.status, 200); return c; };
const actions = async () => (await env.pool.query('SELECT action FROM audit_log ORDER BY id')).rows.map(r => r.action);

test('login: bad password rejected and audited; no session', async () => {
  const c = client(env.base);
  assert.equal((await c.login('nurse1', 'wrong')).status, 401);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.ok((await actions()).includes('login.failed'));
});

test('nurse can register; viewer cannot (server-enforced, denial audited)', async () => {
  const nurse = await as('nurse1'), viewer = await as('viewer1');
  const ok = await nurse.post('/api/patients', P());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.patient.mrn, 'MRN001');
  assert.equal(typeof ok.body.patient.age, 'number');
  const no = await viewer.post('/api/patients', P({ mrn: 'MRN002' }));
  assert.equal(no.status, 403);
  const n = (await env.pool.query(`SELECT count(*)::int n FROM patients WHERE mrn='MRN002'`)).rows[0].n;
  assert.equal(n, 0);
  assert.ok((await actions()).includes('permission.denied'));
  assert.equal((await client(env.base).post('/api/patients', P({ mrn: 'X' }))).status, 401);
});

test('creator comes from the session, a body createdBy is ignored', async () => {
  const nurse = await as('nurse1');
  const r = await nurse.post('/api/patients', P({ mrn: 'MRN003', name: 'Someone Else', createdBy: 1, created_by: 1 }));
  assert.equal(r.status, 201);
  const row = (await env.pool.query(`SELECT u.username FROM patients p JOIN users u ON u.id=p.created_by WHERE p.mrn='MRN003'`)).rows[0];
  assert.equal(row.username, 'nurse1');
  const a = (await env.pool.query(`SELECT username FROM audit_log WHERE action='patient.register' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(a.username, 'nurse1');
});

test('duplicate warning from the server; override needs explicit confirm; MRN is unique', async () => {
  const nurse = await as('nurse1');
  const w = await nurse.post('/api/patients', P({ mrn: 'MRN100', name: '  test   PATIENT ' }));
  assert.equal(w.status, 409);
  assert.equal(w.body.error, 'possible_duplicate');
  assert.ok(w.body.duplicates.length >= 1);
  const ok = await nurse.post('/api/patients', P({ mrn: 'MRN100', name: 'Test Patient', confirmDuplicate: true }));
  assert.equal(ok.status, 201);
  assert.ok((await actions()).includes('patient.duplicate_warning'));
  const m = await nurse.post('/api/patients', P({ mrn: 'mrn100', name: 'Other Name' }));
  assert.equal(m.status, 409);
  assert.equal(m.body.error, 'mrn_taken');
});

test('validation', async () => {
  const nurse = await as('nurse1');
  for (const bad of [{ name: '' }, { mrn: 'a b' }, { dob: '2030-01-01' }, { dob: '1999-02-31' }, { sex: 'X' }]) {
    assert.equal((await nurse.post('/api/patients', P({ mrn: 'V1', name: 'V Name', ...bad }))).status, 400, JSON.stringify(bad));
  }
});

test('search by name/MRN, wildcard characters are literal, archived filter', async () => {
  const doc = await as('doctor1'), viewer = await as('viewer1');
  await doc.post('/api/patients', P({ mrn: 'ARCH1', name: 'Archive Me', dob: '1970-01-01' }));
  const list = (await viewer.get('/api/patients?q=archive')).body.patients;
  assert.equal(list.length, 1);
  const id = list[0].id;
  assert.equal((await viewer.patch(`/api/patients/${id}/archive`, { archived: true })).status, 403);
  assert.equal((await doc.patch(`/api/patients/${id}/archive`, { archived: true })).status, 200);
  assert.equal((await viewer.get('/api/patients?q=archive')).body.patients.length, 0);
  assert.equal((await viewer.get('/api/patients?q=archive&archived=1')).body.patients.length, 1);
  assert.equal((await viewer.get('/api/patients?q=mrn001')).body.patients.length, 1);
  assert.equal((await viewer.get('/api/patients?q=%25')).body.patients.length, 0);
  assert.equal((await doc.patch(`/api/patients/${id}/archive`, { archived: false })).status, 200);
});

test('encounters: open/close, one open per bed shown as an error, one per patient, archived blocked', async () => {
  const nurse = await as('nurse1'), viewer = await as('viewer1');
  const a = (await nurse.post('/api/patients', P({ mrn: 'E1', name: 'Enc One', dob: '1960-03-03' }))).body.patient;
  const b = (await nurse.post('/api/patients', P({ mrn: 'E2', name: 'Enc Two', dob: '1961-04-04' }))).body.patient;
  assert.equal((await viewer.post(`/api/patients/${a.id}/encounters`, { bed: 'ICU-1' })).status, 403);
  const open = await nurse.post(`/api/patients/${a.id}/encounters`, { bed: 'ICU-1' });
  assert.equal(open.status, 201);
  const occ = await nurse.post(`/api/patients/${b.id}/encounters`, { bed: 'icu-1' });
  assert.equal(occ.status, 409);
  assert.equal(occ.body.error, 'bed_occupied');
  const again = await nurse.post(`/api/patients/${a.id}/encounters`, { bed: 'ICU-2' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'patient_has_open_encounter');
  assert.equal((await nurse.get(`/api/patients/${a.id}`)).body.patient.open_bed, 'ICU-1');
  const doc = await as('doctor1');
  assert.equal((await doc.patch(`/api/patients/${a.id}/archive`, { archived: true })).body.error, 'open_encounter');
  assert.equal((await viewer.post(`/api/encounters/${open.body.encounter.id}/close`)).status, 403);
  assert.equal((await nurse.post(`/api/encounters/${open.body.encounter.id}/close`)).status, 200);
  assert.equal((await nurse.post(`/api/encounters/${open.body.encounter.id}/close`)).body.error, 'already_closed');
  assert.equal((await nurse.post(`/api/patients/${b.id}/encounters`, { bed: 'ICU-1' })).status, 201);
  await doc.patch(`/api/patients/${a.id}/archive`, { archived: true });
  assert.equal((await nurse.post(`/api/patients/${a.id}/encounters`, { bed: 'ICU-3' })).body.error, 'patient_archived');
});

test('audit log records each action, is admin-only and cannot be altered', async () => {
  const acts = await actions();
  for (const a of ['login', 'patient.register', 'patient.search', 'patient.archive', 'encounter.open', 'encounter.close', 'encounter.open_rejected'])
    assert.ok(acts.includes(a), 'missing audit action ' + a);
  assert.equal((await (await as('nurse1')).get('/api/audit')).status, 403);
  assert.equal((await (await as('admin1')).get('/api/audit')).status, 200);
  await assert.rejects(env.pool.query(`UPDATE audit_log SET action='x'`), /append-only/);
  await assert.rejects(env.pool.query('DELETE FROM audit_log'), /append-only/);
  await assert.rejects(env.pool.query('TRUNCATE audit_log'), /append-only/);
});

test('patients and encounters cannot be hard-deleted', async () => {
  await assert.rejects(env.pool.query('DELETE FROM patients'), /append-only/);
  await assert.rejects(env.pool.query('DELETE FROM encounters'), /append-only/);
});

test('mutations without the x-emr header are refused; logout ends the session', async () => {
  const c = await as('nurse1');
  assert.equal((await c.raw('POST', '/api/patients', P({ mrn: 'H1', name: 'No Header' }), { 'x-emr': '0' })).status, 400);
  assert.equal((await c.post('/api/logout')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});
