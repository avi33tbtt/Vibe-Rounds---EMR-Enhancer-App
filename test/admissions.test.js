'use strict';
// Task R5a-1: admissions on the server (admit, cancel, entered in error). Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Admission Patient ' + (++seq), mrn: 'ADM-' + seq, dob: '1980-03-03', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const admit = (c, pid, body) => c.post(`/api/patients/${pid}/admissions`, body);
const A = { ward: 'Medical ward 2', reason: 'Fever and confusion', admittedAt: '2026-11-20T09:30:00+05:45' };

test('admit: doctor can; the admitter is the signed-in user; nurse and viewer cannot admit but can read', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(d);
  const a = await admit(d, pid, { ward: ' Medical ward 2 ', reason: ' Fever and confusion ', admittedAt: A.admittedAt });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const o = a.body.admission;
  assert.deepEqual([o.recorded_by, o.status, o.row_version, o.ward_text, o.reason_text], ['doctor1', 'active', 1, 'Medical ward 2', 'Fever and confusion']);
  assert.equal(new Date(o.admitted_at).toISOString(), '2026-11-20T03:45:00.000Z');
  assert.deepEqual(o.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'doctor1']]);
  const pid2 = await newPatient(d);
  assert.equal((await admit(n, pid2, A)).status, 403); assert.equal((await admit(v, pid2, A)).status, 403);
  assert.equal((await n.get(`/api/patients/${pid}/admissions`)).body.admissions.length, 1);
  assert.equal((await v.get(`/api/admissions/${o.id}`)).status, 200);
});

test('admit: unknown fields and bad shapes are refused and nothing is saved', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  for (const extra of [{ recordedBy: 1 }, { admitted_by: 'nurse1' }, { status: 'cancelled' }, { cancelledBy: 1 }]) { const r = await admit(d, pid, { ...A, ...extra }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  const future = new Date(Date.now() + 3600e3).toISOString();
  for (const body of [{}, { ward: 'x' }, { reason: 'x' }, { ward: 'x', reason: 'y' }, { ...A, ward: '  ' }, { ...A, reason: '  ' }, { ...A, ward: 'x'.repeat(201) }, { ...A, reason: 'y'.repeat(501) },
    { ...A, ward: 'bad\u0000' }, { ...A, ward: 5 }, { ...A, reason: 5 }, { ...A, originCaseId: 'abc' },
    { ...A, admittedAt: '2026-11-20T09:30:00' }, { ...A, admittedAt: '2026-11-20' }, { ...A, admittedAt: '2026-02-30T10:00:00Z' }, { ...A, admittedAt: 'yesterday' }, { ...A, admittedAt: future }, { ...A, admittedAt: 5 }])
    assert.equal((await admit(d, pid, body)).status, 400, JSON.stringify(body).slice(0, 70));
  assert.equal((await admit(d, 999999, A)).status, 404);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_admissions WHERE patient_id = $1', [pid])).rows[0].n, 0);
});

test('admit: a case of another patient and an archived patient are refused', async () => {
  const d = await as('doctor1'), p1 = await newPatient(d), p2 = await newPatient(d);
  const k = await d.post(`/api/patients/${p2}/cases`, { title: 'Other case' }); assert.equal(k.status, 201);
  const r = await admit(d, p1, { ...A, originCaseId: k.body.case.id }); assert.equal(r.status, 400); assert.equal(r.body.error, 'case_not_of_patient');
  assert.equal((await admit(d, p2, { ...A, originCaseId: k.body.case.id })).body.admission.origin_case_id, k.body.case.id);
  assert.equal((await d.patch(`/api/patients/${p1}/archive`, { archived: true })).status, 200);
  assert.equal((await admit(d, p1, A)).status, 409);
});

test('a patient has at most one active admission; after a cancel another can be recorded; another patient is not affected', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), other = await newPatient(d);
  const a = await admit(d, pid, A); assert.equal(a.status, 201);
  const again = await admit(d, pid, A); assert.equal(again.status, 409); assert.equal(again.body.error, 'already_admitted');
  assert.equal((await admit(d, other, A)).status, 201);
  assert.equal((await d.post(`/api/admissions/${a.body.admission.id}/cancel`, { reason: 'wrong ward', rowVersion: 1 })).status, 200);
  assert.equal((await admit(d, pid, A)).status, 201);
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM patient_admissions WHERE patient_id = $1 AND status = 'active'`, [pid])).rows[0].n, 1);
});

test('two admits at once for one patient: one wins, the other gets 409', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const r = await Promise.all([1, 2].map(() => admit(d, pid, A)));
  assert.deepEqual(r.map(x => x.status).sort(), [201, 409]);
});

test('cancel and entered in error: reason and loaded version needed; only an active admission can be cancelled; entered in error is final and hidden unless include=all', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), pid = await newPatient(d), a = (await admit(d, pid, A)).body.admission, u = `/api/admissions/${a.id}`;
  assert.equal((await n.post(u + '/cancel', { reason: 'x', rowVersion: 1 })).status, 403);
  assert.equal((await d.post(u + '/cancel', { rowVersion: 1 })).status, 400); assert.equal((await d.post(u + '/cancel', { reason: 'x' })).status, 400);
  assert.equal((await d.post(u + '/cancel', { reason: 'x', rowVersion: 1, cancelledBy: 1 })).status, 400);
  const st = await d.post(u + '/cancel', { reason: 'x', rowVersion: 5 }); assert.equal(st.status, 409); assert.equal(st.body.error, 'version_conflict');
  const c = await d.post(u + '/cancel', { reason: ' not admitted ', rowVersion: 1 });
  assert.equal(c.status, 200); assert.deepEqual([c.body.admission.status, c.body.admission.cancelled_by, c.body.admission.cancel_reason, c.body.admission.row_version], ['cancelled', 'doctor1', 'not admitted', 2]);
  assert.equal((await d.post(u + '/cancel', { reason: 'x', rowVersion: 2 })).body.error, 'not_active');
  const e = await d.post(u + '/entered-in-error', { reason: 'wrong patient', rowVersion: 2 });
  assert.equal(e.status, 200); assert.deepEqual([e.body.admission.status, e.body.admission.cancel_reason, e.body.admission.events.length], ['entered_in_error', 'not admitted', 3]);
  assert.equal((await d.post(u + '/entered-in-error', { reason: 'x', rowVersion: 3 })).body.error, 'admission_final');
  assert.equal((await d.get(`/api/patients/${pid}/admissions`)).body.admissions.length, 0);
  assert.equal((await d.get(`/api/patients/${pid}/admissions?include=all`)).body.admissions.length, 1);
  assert.equal((await d.get('/api/admissions/999999')).status, 404); assert.equal((await d.get('/api/admissions/abc')).status, 404);
});

test('two cancels at once: one wins, the other gets 409', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await admit(d, pid, A)).body.admission;
  const r = await Promise.all([1, 2].map(() => d.post(`/api/admissions/${a.id}/cancel`, { reason: 'race', rowVersion: 1 })));
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_admission_events WHERE admission_id = $1', [a.id])).rows[0].n, 2);
});

test('admissions of one patient never show under another patient', async () => {
  const d = await as('doctor1'), p1 = await newPatient(d), p2 = await newPatient(d);
  await admit(d, p1, A);
  assert.equal((await d.get(`/api/patients/${p2}/admissions?include=all`)).body.admissions.length, 0);
});

test('the database refuses what the routes would: no delete or truncate, no content edit, no change from the app role, no bad moves, no future admission, no second active admission', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await admit(d, pid, A)).body.admission;
  await assert.rejects(env.pool.query('DELETE FROM patient_admissions')); await assert.rejects(env.pool.query('TRUNCATE patient_admissions'));
  await assert.rejects(env.pool.query('DELETE FROM patient_admission_events')); await assert.rejects(env.pool.query(`UPDATE patient_admission_events SET reason = 'x'`));
  await assert.rejects(env.appPool.query(`UPDATE patient_admissions SET ward_text = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE patient_admissions SET reason_text = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE patient_admissions SET admitted_at = now()`), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM patient_admissions'), /permission denied/);
  await assert.rejects(env.pool.query(`UPDATE patient_admissions SET ward_text = 'x' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.pool.query(`UPDATE patient_admissions SET status = 'cancelled', row_version = 2 WHERE id = $1`, [a.id]));   // a cancel needs who, when and a reason
  await assert.rejects(env.pool.query(`UPDATE patient_admissions SET status = 'active' WHERE id = $1`, [a.id]));
  const ins = `INSERT INTO patient_admissions(patient_id, ward_text, reason_text, admitted_at, recorded_by) SELECT $1, 'x', 'y', $2::timestamptz, id FROM users LIMIT 1`;
  await assert.rejects(env.pool.query(ins, [pid, new Date(Date.now() + 86400e3).toISOString()]), /future/);
  await assert.rejects(env.pool.query(ins, [pid, '2026-11-01T00:00:00Z']), /one_active|duplicate key/);
});

test('the audit log keeps ids and lengths only: no ward, reason or move reason text', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const a = await admit(d, pid, { ward: 'SECRETWARD', reason: 'SECRETWHY', admittedAt: A.admittedAt }); assert.equal(a.status, 201);
  await d.post(`/api/admissions/${a.body.admission.id}/cancel`, { reason: 'SECRETREASON', rowVersion: 1 });
  await d.get(`/api/patients/${pid}/admissions`); await d.get(`/api/admissions/${a.body.admission.id}`);
  const rows = (await env.pool.query(`SELECT detail::text AS t FROM audit_log WHERE action LIKE 'admission.%' OR action = 'patient.admissions_view'`)).rows;
  assert.ok(rows.length >= 4); for (const r of rows) assert.doesNotMatch(r.t, /SECRET/);
});
