'use strict';
// Task R4i-1: procedures on the server (record, cancel, entered in error). Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Procedure Patient ' + (++seq), mrn: 'PRC-' + seq, dob: '1980-03-03', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const record = (c, pid, body) => c.post(`/api/patients/${pid}/procedures`, body);
const P = { procedure: 'Lumbar puncture', performedAt: '2026-11-20T09:30:00+05:45' };

test('record: doctor can; the recorder is the signed-in user; outcome is optional; nurse and viewer cannot record but can read', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(d);
  const a = await record(d, pid, { procedure: ' Lumbar puncture ', performedAt: P.performedAt, outcome: ' Clear fluid ' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const o = a.body.procedure;
  assert.deepEqual([o.recorded_by, o.status, o.row_version, o.procedure_text, o.outcome_text], ['doctor1', 'active', 1, 'Lumbar puncture', 'Clear fluid']);
  assert.equal(new Date(o.performed_at).toISOString(), '2026-11-20T03:45:00.000Z');
  assert.deepEqual(o.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'doctor1']]);
  assert.equal((await record(d, pid, P)).body.procedure.outcome_text, null);
  assert.equal((await record(n, pid, P)).status, 403); assert.equal((await record(v, pid, P)).status, 403);
  assert.equal((await n.get(`/api/patients/${pid}/procedures`)).body.procedures.length, 2);
  assert.equal((await v.get(`/api/procedures/${o.id}`)).status, 200);
});

test('record: unknown fields and bad shapes are refused and nothing is saved', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  for (const extra of [{ recordedBy: 1 }, { recorded_by: 'nurse1' }, { status: 'cancelled' }, { cancelledBy: 1 }]) { const r = await record(d, pid, { ...P, ...extra }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  const future = new Date(Date.now() + 3600e3).toISOString();
  for (const body of [{}, { procedure: 'x' }, { performedAt: P.performedAt }, { ...P, procedure: '  ' }, { ...P, procedure: 'x'.repeat(201) }, { ...P, procedure: 'bad\u0000' }, { ...P, procedure: 5 },
    { ...P, outcome: '  ' }, { ...P, outcome: 'y'.repeat(501) }, { ...P, outcome: 5 }, { ...P, originCaseId: 'abc' },
    { ...P, performedAt: '2026-11-20T09:30:00' }, { ...P, performedAt: '2026-11-20' }, { ...P, performedAt: '2026-02-30T10:00:00Z' }, { ...P, performedAt: 'yesterday' }, { ...P, performedAt: future }, { ...P, performedAt: 5 }])
    assert.equal((await record(d, pid, body)).status, 400, JSON.stringify(body).slice(0, 70));
  assert.equal((await record(d, 999999, P)).status, 404);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_procedures WHERE patient_id = $1', [pid])).rows[0].n, 0);
});

test('record: a case of another patient and an archived patient are refused', async () => {
  const d = await as('doctor1'), p1 = await newPatient(d), p2 = await newPatient(d);
  const k = await d.post(`/api/patients/${p2}/cases`, { title: 'Other case' }); assert.equal(k.status, 201);
  const r = await record(d, p1, { ...P, originCaseId: k.body.case.id }); assert.equal(r.status, 400); assert.equal(r.body.error, 'case_not_of_patient');
  assert.equal((await record(d, p2, { ...P, originCaseId: k.body.case.id })).body.procedure.origin_case_id, k.body.case.id);
  assert.equal((await d.patch(`/api/patients/${p1}/archive`, { archived: true })).status, 200);
  assert.equal((await record(d, p1, P)).status, 409);
});

test('cancel and entered in error: reason and loaded version needed; only an active procedure can be cancelled; entered in error is final and hidden unless include=all', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), pid = await newPatient(d), a = (await record(d, pid, P)).body.procedure, u = `/api/procedures/${a.id}`;
  assert.equal((await n.post(u + '/cancel', { reason: 'x', rowVersion: 1 })).status, 403);
  assert.equal((await d.post(u + '/cancel', { rowVersion: 1 })).status, 400); assert.equal((await d.post(u + '/cancel', { reason: 'x' })).status, 400);
  assert.equal((await d.post(u + '/cancel', { reason: 'x', rowVersion: 1, cancelledBy: 1 })).status, 400);
  const st = await d.post(u + '/cancel', { reason: 'x', rowVersion: 5 }); assert.equal(st.status, 409); assert.equal(st.body.error, 'version_conflict');
  const c = await d.post(u + '/cancel', { reason: ' not done ', rowVersion: 1 });
  assert.equal(c.status, 200); assert.deepEqual([c.body.procedure.status, c.body.procedure.cancelled_by, c.body.procedure.cancel_reason, c.body.procedure.row_version], ['cancelled', 'doctor1', 'not done', 2]);
  assert.equal((await d.post(u + '/cancel', { reason: 'x', rowVersion: 2 })).body.error, 'not_active');
  const e = await d.post(u + '/entered-in-error', { reason: 'wrong patient', rowVersion: 2 });
  assert.equal(e.status, 200); assert.deepEqual([e.body.procedure.status, e.body.procedure.cancel_reason, e.body.procedure.events.length], ['entered_in_error', 'not done', 3]);
  assert.equal((await d.post(u + '/entered-in-error', { reason: 'x', rowVersion: 3 })).body.error, 'procedure_final');
  assert.equal((await d.get(`/api/patients/${pid}/procedures`)).body.procedures.length, 0);
  assert.equal((await d.get(`/api/patients/${pid}/procedures?include=all`)).body.procedures.length, 1);
  assert.equal((await d.get('/api/procedures/999999')).status, 404); assert.equal((await d.get('/api/procedures/abc')).status, 404);
});

test('two cancels at once: one wins, the other gets 409', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await record(d, pid, P)).body.procedure;
  const r = await Promise.all([1, 2].map(() => d.post(`/api/procedures/${a.id}/cancel`, { reason: 'race', rowVersion: 1 })));
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_procedure_events WHERE procedure_id = $1', [a.id])).rows[0].n, 2);
});

test('procedures of one patient never show under another patient', async () => {
  const d = await as('doctor1'), p1 = await newPatient(d), p2 = await newPatient(d);
  await record(d, p1, P);
  assert.equal((await d.get(`/api/patients/${p2}/procedures?include=all`)).body.procedures.length, 0);
});

test('the database refuses what the routes would: no delete or truncate, no content edit, no change from the app role, no bad moves, no future procedure', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await record(d, pid, P)).body.procedure;
  await assert.rejects(env.pool.query('DELETE FROM patient_procedures')); await assert.rejects(env.pool.query('TRUNCATE patient_procedures'));
  await assert.rejects(env.pool.query('DELETE FROM patient_procedure_events')); await assert.rejects(env.pool.query(`UPDATE patient_procedure_events SET reason = 'x'`));
  await assert.rejects(env.appPool.query(`UPDATE patient_procedures SET procedure_text = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE patient_procedures SET outcome_text = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE patient_procedures SET performed_at = now()`), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM patient_procedures'), /permission denied/);
  await assert.rejects(env.pool.query(`UPDATE patient_procedures SET procedure_text = 'x' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.pool.query(`UPDATE patient_procedures SET status = 'cancelled', row_version = 2 WHERE id = $1`, [a.id]));   // a cancel needs who, when and a reason
  await assert.rejects(env.pool.query(`UPDATE patient_procedures SET status = 'active' WHERE id = $1`, [a.id]));
  await assert.rejects(env.pool.query(`INSERT INTO patient_procedures(patient_id, procedure_text, performed_at, recorded_by) SELECT $1, 'x', now() + interval '1 day', id FROM users LIMIT 1`, [pid]), /future/);
});

test('the audit log keeps ids and lengths only: no procedure name, outcome or move reason text', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const a = await record(d, pid, { procedure: 'SECRETPROC', performedAt: P.performedAt, outcome: 'SECRETOUT' }); assert.equal(a.status, 201);
  await d.post(`/api/procedures/${a.body.procedure.id}/cancel`, { reason: 'SECRETREASON', rowVersion: 1 });
  await d.get(`/api/patients/${pid}/procedures`); await d.get(`/api/procedures/${a.body.procedure.id}`);
  const rows = (await env.pool.query(`SELECT detail::text AS t FROM audit_log WHERE action LIKE 'procedure.%' OR action = 'patient.procedures_view'`)).rows;
  assert.ok(rows.length >= 4); for (const r of rows) assert.doesNotMatch(r.t, /SECRET/);
});
