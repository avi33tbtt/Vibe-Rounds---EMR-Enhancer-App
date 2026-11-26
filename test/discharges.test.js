'use strict';
// Task R5f-1: discharge on the server. Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Discharge Patient ' + (++seq), mrn: 'DIS-' + seq, dob: '1975-05-05', sex: 'M' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const admit = async (c, pid) => { const r = await c.post(`/api/patients/${pid}/admissions`, { ward: 'Ward 1', reason: 'Chest pain', admittedAt: '2026-11-20T09:30:00+05:45' }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.admission; };
const D = { dischargedAt: '2026-11-22T10:00:00+05:45', summary: 'Recovered, walking.', condition: 'Stable', rowVersion: 1 };
const discharge = (c, id, body) => c.post(`/api/admissions/${id}/discharge`, body);

test('discharge: doctor can; the admission becomes discharged with the recorder from the session; the discharge is shown on get and list; nurse and viewer cannot', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(d), a = await admit(d, pid);
  assert.equal((await discharge(n, a.id, D)).status, 403); assert.equal((await discharge(v, a.id, D)).status, 403);
  const r = await discharge(d, a.id, { ...D, summary: ' Recovered, walking. ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = r.body.admission;
  assert.deepEqual([o.status, o.row_version, o.discharged_by, o.discharge_summary, o.discharge_condition], ['discharged', 2, 'doctor1', 'Recovered, walking.', 'Stable']);
  assert.equal(new Date(o.discharged_at).toISOString(), '2026-11-22T04:15:00.000Z');
  assert.deepEqual(o.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'doctor1'], [2, 'active', 'discharged', 'doctor1']]);
  assert.equal((await v.get(`/api/admissions/${a.id}`)).body.admission.discharge_summary, 'Recovered, walking.');
  assert.equal((await n.get(`/api/patients/${pid}/admissions`)).body.admissions[0].status, 'discharged');
});

test('discharge: unknown fields and bad shapes are refused and nothing is saved', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = await admit(d, pid);
  for (const extra of [{ recordedBy: 1 }, { discharged_by: 'x' }, { status: 'active' }]) { const r = await discharge(d, a.id, { ...D, ...extra }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  const future = new Date(Date.now() + 3600e3).toISOString();
  for (const body of [{}, { ...D, summary: undefined }, { ...D, summary: '  ' }, { ...D, summary: 'x'.repeat(2001) }, { ...D, summary: 'bad\u0000' }, { ...D, condition: '  ' }, { ...D, condition: 'y'.repeat(501) }, { ...D, condition: 5 },
    { ...D, dischargedAt: '2026-11-22T10:00:00' }, { ...D, dischargedAt: 'tomorrow' }, { ...D, dischargedAt: future }, { ...D, rowVersion: undefined }, { ...D, rowVersion: 'x' }])
    assert.equal((await discharge(d, a.id, body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await discharge(d, 999999, D)).status, 404);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM admission_discharges WHERE patient_id = $1', [pid])).rows[0].n, 0);
  assert.equal((await d.get(`/api/admissions/${a.id}`)).body.admission.status, 'active');
});

test('discharge: not before the admission, stale version gives 409, only an active admission; the condition is optional', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = await admit(d, pid);
  const early = await discharge(d, a.id, { ...D, dischargedAt: '2026-11-19T09:30:00+05:45' }); assert.equal(early.status, 409); assert.equal(early.body.error, 'before_admission');
  const stale = await discharge(d, a.id, { ...D, rowVersion: 7 }); assert.equal(stale.status, 409); assert.equal(stale.body.error, 'version_conflict'); assert.equal(stale.body.currentRowVersion, 1);
  const ok = await discharge(d, a.id, { dischargedAt: D.dischargedAt, summary: 'Home.', rowVersion: 1 }); assert.equal(ok.status, 200); assert.equal(ok.body.admission.discharge_condition, null);
  const again = await discharge(d, a.id, { ...D, rowVersion: 2 }); assert.equal(again.status, 409); assert.equal(again.body.error, 'not_active');
  const pid2 = await newPatient(d), b = await admit(d, pid2);
  assert.equal((await d.post(`/api/admissions/${b.id}/cancel`, { reason: 'wrong', rowVersion: 1 })).status, 200);
  assert.equal((await discharge(d, b.id, { ...D, rowVersion: 2 })).body.error, 'not_active');
});

test('after a discharge the patient can be admitted again; a discharged admission cannot be cancelled but can be marked entered in error (final, discharge text kept)', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = await admit(d, pid);
  assert.equal((await discharge(d, a.id, D)).status, 200);
  const b = await admit(d, pid); assert.notEqual(b.id, a.id);
  const c = await d.post(`/api/admissions/${a.id}/cancel`, { reason: 'no', rowVersion: 2 }); assert.equal(c.status, 409); assert.equal(c.body.error, 'not_active');
  const e = await d.post(`/api/admissions/${a.id}/entered-in-error`, { reason: 'wrong patient', rowVersion: 2 });
  assert.equal(e.status, 200, JSON.stringify(e.body)); assert.equal(e.body.admission.status, 'entered_in_error'); assert.equal(e.body.admission.discharge_summary, 'Recovered, walking.');
  assert.equal((await discharge(d, a.id, { ...D, rowVersion: 3 })).body.error, 'admission_final');
});

test('the audit log records ids and lengths of a discharge, never its text', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = await admit(d, pid);
  assert.equal((await discharge(d, a.id, { ...D, summary: 'SECRET-SUMMARY-TEXT', condition: 'SECRET-CONDITION' })).status, 200);
  const rows = (await env.pool.query(`SELECT action, detail FROM audit_log WHERE action = 'admission.discharge' ORDER BY id DESC LIMIT 1`)).rows;
  assert.equal(rows.length, 1); const t = JSON.stringify(rows[0].detail);
  assert.ok(!t.includes('SECRET'), t); assert.equal(rows[0].detail.summaryLength, 19); assert.equal(rows[0].detail.conditionLength, 16);
});

test('the database itself refuses to change or delete a discharge, to discharge without a discharge row, or to discharge a non-active admission', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = await admit(d, pid);
  const q = (sql, p) => env.appPool.query(sql, p);
  await assert.rejects(q(`UPDATE patient_admissions SET status = 'discharged', row_version = row_version + 1 WHERE id = $1`, [a.id]), /recording its discharge/);
  assert.equal((await discharge(d, a.id, D)).status, 200);
  await assert.rejects(q(`UPDATE admission_discharges SET summary_text = 'changed' WHERE admission_id = $1`, [a.id]), /permission denied|append-only|not allowed/);
  await assert.rejects(q('DELETE FROM admission_discharges WHERE admission_id = $1', [a.id]), /permission denied|append-only|not allowed/);
  await assert.rejects(q('TRUNCATE admission_discharges'), /permission denied|append-only|not allowed/);
  await assert.rejects(env.pool.query(`INSERT INTO admission_discharges(admission_id, patient_id, discharged_at, summary_text, recorded_by) SELECT $1, $2, now(), 's', id FROM users LIMIT 1`, [a.id, pid]), /unique|only an active admission/);
  const c = await as('doctor1'), pid2 = await newPatient(c), b = await admit(c, pid2);
  await assert.rejects(env.pool.query(`INSERT INTO admission_discharges(admission_id, patient_id, discharged_at, summary_text, recorded_by) SELECT $1, $2, '2026-11-19T00:00:00Z', 's', id FROM users LIMIT 1`, [b.id, pid2]), /before the admission/);
  await assert.rejects(env.pool.query(`INSERT INTO admission_discharges(admission_id, patient_id, discharged_at, summary_text, recorded_by) SELECT $1, $2, now() + interval '1 day', 's', id FROM users LIMIT 1`, [b.id, pid2]), /future/);
});
