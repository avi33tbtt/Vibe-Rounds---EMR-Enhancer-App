'use strict';
// Task R4d-1: medication reconciliation on the server (compare, record). Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Recon Patient ' + (++seq), mrn: 'REC-' + seq, dob: '1960-02-02', sex: 'M' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const addMed = async (c, pid, medication = 'History drug') => (await c.post(`/api/patients/${pid}/medications`, { medication })).body.medication;
const addOrder = async (c, pid) => (await c.post(`/api/patients/${pid}/medication-orders`, { medication: 'Order drug', doseText: 'd', routeText: 'r', frequencyText: 'f' })).body.order;
const rec = (c, pid, body) => c.post(`/api/patients/${pid}/medication-reconciliation`, body);
const get = (c, pid) => c.get(`/api/patients/${pid}/medication-reconciliation`);

test('compare: active history items next to active orders, nothing matched or suggested; stopped items and inactive orders are left out; a viewer can read', async () => {
  const d = await as('doctor1'), v = await as('viewer1'), pid = await newPatient(d);
  const m1 = await addMed(d, pid, 'Keep'), m2 = await addMed(d, pid, 'Stopped one');
  await d.post(`/api/medications/${m2.id}/stop`, { reason: 'x', rowVersion: 1 });
  const o1 = await addOrder(d, pid), o2 = await addOrder(d, pid);
  await d.post(`/api/medication-orders/${o2.id}/stop`, { reason: 'x', rowVersion: 1 });
  const g = await get(v, pid);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(g.body.history.map(h => [h.id, h.decision]), [[m1.id, null]]);
  assert.deepEqual(g.body.orders.map(o => o.id), [o1.id]);
  assert.equal((await get(d, 999999)).status, 404);
});

test('record: continue needs an active order of this patient; stop and not_taken take none; the decider is the session; the latest decision shows', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), m = await addMed(d, pid), o = await addOrder(d, pid);
  const a = await rec(d, pid, { medicationId: m.id, decision: 'continue', orderId: o.id, reason: ' covered ' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual([a.body.decision.decision, a.body.decision.order_id, a.body.decision.reason, a.body.decision.decided_by], ['continue', o.id, 'covered', 'doctor1']);
  assert.equal((await get(d, pid)).body.history[0].decision.decision, 'continue');
  const b = await rec(d, pid, { medicationId: m.id, decision: 'stop', reason: 'changed mind' });
  assert.equal(b.status, 201); assert.equal(b.body.decision.order_id, null);
  assert.equal((await get(d, pid)).body.history[0].decision.decision, 'stop', 'latest wins');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM medication_reconciliations WHERE patient_id = $1', [pid])).rows[0].n, 2, 'both kept');
  assert.equal((await rec(d, pid, { medicationId: m.id, decision: 'not_taken', reason: 'never took it' })).status, 201);
});

test('record: refusals (role, unknown fields, shape, reason, wrong patient, inactive items, archived patient); nothing is saved', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), pid = await newPatient(d), other = await newPatient(d);
  const m = await addMed(d, pid), o = await addOrder(d, pid), om = await addMed(d, other), oo = await addOrder(d, other);
  const ok = { medicationId: m.id, decision: 'continue', orderId: o.id, reason: 'r' };
  assert.equal((await rec(n, pid, ok)).status, 403);
  for (const x of [{ decidedBy: 1 }, { decided_by: 'nurse1' }, { id: 5 }]) { const r = await rec(d, pid, { ...ok, ...x }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  for (const x of [{ medicationId: 'a' }, { decision: 'accept' }, { orderId: undefined }, { decision: 'stop' }, { reason: '  ' }, { reason: undefined }, { reason: 'x'.repeat(1001) }]) assert.equal((await rec(d, pid, { ...ok, ...x })).status, 400, JSON.stringify(x));
  assert.equal((await rec(d, pid, { ...ok, medicationId: om.id })).body.error, 'medication_not_of_patient');
  assert.equal((await rec(d, pid, { ...ok, orderId: oo.id })).body.error, 'order_not_of_patient');
  await d.post(`/api/medication-orders/${o.id}/stop`, { reason: 'x', rowVersion: 1 });
  assert.equal((await rec(d, pid, ok)).body.error, 'order_not_active');
  await d.post(`/api/medications/${m.id}/stop`, { reason: 'x', rowVersion: 1 });
  assert.equal((await rec(d, pid, { medicationId: m.id, decision: 'stop', reason: 'r' })).body.error, 'not_active');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM medication_reconciliations WHERE patient_id = $1', [pid])).rows[0].n, 0);
  const m3 = await addMed(d, pid); assert.equal((await d.patch(`/api/patients/${pid}/archive`, { archived: true })).status, 200);
  assert.equal((await rec(d, pid, { medicationId: m3.id, decision: 'stop', reason: 'r' })).status, 409);
});

test('the database refuses what the routes would: no change or delete or truncate, no continue without an order, no other patient, no inactive item', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), other = await newPatient(d), m = await addMed(d, pid), o = await addOrder(d, pid), oo = await addOrder(d, other);
  const r = await rec(d, pid, { medicationId: m.id, decision: 'continue', orderId: o.id, reason: 'r' }); assert.equal(r.status, 201);
  await assert.rejects(env.pool.query('DELETE FROM medication_reconciliations'));
  await assert.rejects(env.pool.query('TRUNCATE medication_reconciliations'));
  await assert.rejects(env.pool.query(`UPDATE medication_reconciliations SET reason = 'x'`));
  await assert.rejects(env.appPool.query(`UPDATE medication_reconciliations SET reason = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM medication_reconciliations'), /permission denied/);
  const u = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  const ins = (decision, order, patient = pid) => env.pool.query(`INSERT INTO medication_reconciliations(patient_id, medication_id, order_id, decision, reason, decided_by) VALUES ($1,$2,$3,$4,'r',$5)`, [patient, m.id, order, decision, u]);
  await assert.rejects(ins('continue', null), /check/); await assert.rejects(ins('stop', o.id), /check/);
  await assert.rejects(ins('continue', oo.id), /active order of this patient/); await assert.rejects(ins('stop', null, other), /not of this patient/);
  await d.post(`/api/medications/${m.id}/stop`, { reason: 'x', rowVersion: 1 });
  await assert.rejects(ins('stop', null), /only an active medication/);
});

test('the audit log keeps ids, the decision and the reason length only: no reason text', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), m = await addMed(d, pid, 'SECRETDRUG');
  assert.equal((await rec(d, pid, { medicationId: m.id, decision: 'not_taken', reason: 'SECRETREASON' })).status, 201);
  const rows = (await env.pool.query(`SELECT detail::text AS t FROM audit_log WHERE action = 'medication_reconciliation.record' AND entity_id = $1`, [String(pid)])).rows;
  assert.equal(rows.length, 1); assert.doesNotMatch(rows[0].t, /SECRET/);
});
