'use strict';
// Task R5f-2: follow-up after discharge on the server. Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Followup Patient ' + (++seq), mrn: 'FU-' + seq, dob: '1970-01-01', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
async function admit(c, pid, discharged = true) {
  const a = await c.post(`/api/patients/${pid}/admissions`, { ward: 'Ward 1', reason: 'Pneumonia', admittedAt: '2026-11-20T09:30:00+05:45' }); assert.equal(a.status, 201);
  if (discharged) assert.equal((await c.post(`/api/admissions/${a.body.admission.id}/discharge`, { dischargedAt: '2026-11-22T10:00:00+05:45', summary: 'Home.', rowVersion: 1 })).status, 200);
  return a.body.admission.id;
}
const F = { instruction: 'Review chest X-ray in clinic', where: 'Chest clinic', followUpOn: '2026-12-01' };
const add = (c, aid, body) => c.post(`/api/admissions/${aid}/followups`, body);

test('add: doctor can; the recorder is the signed-in user; text is trimmed; where and date are optional; nurse and viewer cannot add but can read', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(d), aid = await admit(d, pid);
  assert.equal((await add(n, aid, F)).status, 403); assert.equal((await add(v, aid, F)).status, 403);
  const r = await add(d, aid, { instruction: '  Review chest X-ray in clinic ', where: ' Chest clinic ', followUpOn: '2026-12-01' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = r.body.followup;
  assert.deepEqual([o.recorded_by, o.status, o.row_version, o.instruction_text, o.where_text, o.follow_up_on, o.admission_id, o.patient_id], ['doctor1', 'active', 1, 'Review chest X-ray in clinic', 'Chest clinic', '2026-12-01', aid, pid]);
  assert.deepEqual(o.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'doctor1']]);
  const bare = await add(d, aid, { instruction: 'Call the ward if fever returns' });
  assert.equal(bare.status, 201); assert.deepEqual([bare.body.followup.where_text, bare.body.followup.follow_up_on], [null, null]);
  assert.equal((await n.get(`/api/patients/${pid}/followups`)).body.followups.length, 2);
  assert.equal((await v.get(`/api/followups/${o.id}`)).status, 200);
});

test('add: unknown fields and bad shapes are refused and nothing is saved', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), aid = await admit(d, pid);
  for (const extra of [{ recordedBy: 1 }, { status: 'cancelled' }, { admissionId: 1 }, { patientId: 1 }]) { const r = await add(d, aid, { ...F, ...extra }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  for (const body of [{}, { where: 'x' }, { ...F, instruction: '  ' }, { ...F, instruction: 'x'.repeat(501) }, { ...F, instruction: 'bad\u0000' }, { ...F, instruction: 5 }, { ...F, where: '  ' }, { ...F, where: 'y'.repeat(201) }, { ...F, where: 5 },
    { ...F, followUpOn: '2026-02-30' }, { ...F, followUpOn: '2026-12-01T10:00:00Z' }, { ...F, followUpOn: 'next week' }, { ...F, followUpOn: '1999-12-31' }, { ...F, followUpOn: '2101-01-01' }, { ...F, followUpOn: 5 }])
    assert.equal((await add(d, aid, body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await add(d, 999999, F)).status, 404);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_followups WHERE patient_id = $1', [pid])).rows[0].n, 0);
});

test('add: only for a discharged admission; an archived patient is refused', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), active = await admit(d, pid, false);
  const r = await add(d, active, F); assert.equal(r.status, 409); assert.equal(r.body.error, 'not_discharged');
  assert.equal((await d.post(`/api/admissions/${active}/cancel`, { reason: 'wrong', rowVersion: 1 })).status, 200);
  assert.equal((await add(d, active, F)).body.error, 'not_discharged');
  const p2 = await newPatient(d), a2 = await admit(d, p2);
  assert.equal((await d.patch(`/api/patients/${p2}/archive`, { archived: true })).status, 200);
  assert.equal((await add(d, a2, F)).status, 409);
});

test('cancel and entered in error need a reason and the loaded version; stale gives 409; entered in error is final; cancel only for active; unknown fields refused', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), pid = await newPatient(d), aid = await admit(d, pid);
  const f = (await add(d, aid, F)).body.followup;
  assert.equal((await n.post(`/api/followups/${f.id}/cancel`, { reason: 'x', rowVersion: 1 })).status, 403);
  for (const body of [{ rowVersion: 1 }, { reason: '  ', rowVersion: 1 }, { reason: 'x'.repeat(1001), rowVersion: 1 }, { reason: 'x' }, { reason: 'x', rowVersion: 'a' }])
    assert.equal((await d.post(`/api/followups/${f.id}/cancel`, body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await d.post(`/api/followups/${f.id}/cancel`, { reason: 'x', rowVersion: 1, cancelledBy: 1 })).body.error, 'unknown_field');
  const stale = await d.post(`/api/followups/${f.id}/cancel`, { reason: 'x', rowVersion: 5 }); assert.equal(stale.status, 409); assert.equal(stale.body.error, 'version_conflict');
  const c = await d.post(`/api/followups/${f.id}/cancel`, { reason: 'patient declined', rowVersion: 1 });
  assert.equal(c.status, 200); assert.deepEqual([c.body.followup.status, c.body.followup.cancelled_by, c.body.followup.cancel_reason, c.body.followup.row_version], ['cancelled', 'doctor1', 'patient declined', 2]);
  assert.equal((await d.post(`/api/followups/${f.id}/cancel`, { reason: 'again', rowVersion: 2 })).body.error, 'not_active');
  const e = await d.post(`/api/followups/${f.id}/entered-in-error`, { reason: 'wrong patient', rowVersion: 2 });
  assert.equal(e.status, 200); assert.equal(e.body.followup.status, 'entered_in_error'); assert.equal(e.body.followup.events.length, 3);
  assert.equal((await d.post(`/api/followups/${f.id}/entered-in-error`, { reason: 'again', rowVersion: 3 })).body.error, 'followup_final');
  assert.equal((await d.get(`/api/patients/${pid}/followups`)).body.followups.length, 0);
  assert.equal((await d.get(`/api/patients/${pid}/followups?include=all`)).body.followups.length, 1);
  assert.equal((await d.get('/api/followups/999999')).status, 404);
});

test('the audit log records ids and lengths of follow-up writes, never their text', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), aid = await admit(d, pid);
  const f = (await add(d, aid, { instruction: 'SECRET-INSTRUCTION', where: 'SECRET-PLACE', followUpOn: '2026-12-01' })).body.followup;
  assert.equal((await d.post(`/api/followups/${f.id}/cancel`, { reason: 'SECRET-REASON', rowVersion: 1 })).status, 200);
  const rows = (await env.pool.query(`SELECT action, detail FROM audit_log WHERE action LIKE 'followup.%' ORDER BY id DESC LIMIT 2`)).rows;
  assert.equal(rows.length, 2); assert.ok(!JSON.stringify(rows).includes('SECRET'), JSON.stringify(rows));
  const add_ = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'followup.add' ORDER BY id DESC LIMIT 1`)).rows[0].detail;
  assert.deepEqual([add_.instructionLength, add_.whereLength, add_.hasDate], [18, 12, true]);
});

test('the database refuses to change or delete a follow-up, or to add one for an admission that is not discharged or belongs to another patient', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), aid = await admit(d, pid), f = (await add(d, aid, F)).body.followup;
  const q = (sql, p) => env.appPool.query(sql, p);
  await assert.rejects(q(`UPDATE patient_followups SET instruction_text = 'changed' WHERE id = $1`, [f.id]), /permission denied|cannot be changed/);
  await assert.rejects(q('DELETE FROM patient_followups WHERE id = $1', [f.id]), /permission denied|append-only|not allowed/);
  await assert.rejects(q('TRUNCATE patient_followups'), /permission denied|append-only|not allowed/);
  await assert.rejects(q(`UPDATE patient_followups SET status = 'entered_in_error', row_version = 9, error_by = 1, error_at = now(), error_reason = 'x' WHERE id = $1`, [f.id]), /row_version must advance|permission denied/);
  const ins = (admission, patient) => env.pool.query(`INSERT INTO patient_followups(patient_id, admission_id, instruction_text, recorded_by) SELECT $2, $1, 'x', id FROM users LIMIT 1`, [admission, patient]);
  const p2 = await newPatient(d), a2 = await admit(d, p2, false), p3 = await newPatient(d);
  await assert.rejects(ins(a2, p2), /discharged admission/);
  await assert.rejects(ins(aid, p3), /same patient/);
});
