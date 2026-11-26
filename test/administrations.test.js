'use strict';
// Task R5d: medication administration record on the server (record, entered in error). Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'MAR Patient ' + (++seq), mrn: 'MAR-' + seq, dob: '1980-03-03', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const order = async (c, pid) => { const r = await c.post(`/api/patients/${pid}/medication-orders`, { medication: 'Order drug', doseText: 'typed dose', routeText: 'typed route', frequencyText: 'typed freq' }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.order; };
const ago = ms => new Date(Date.now() - ms).toISOString();
const t = () => new Date(Date.now() - 1).toISOString();   // just now: an order made a moment ago must come before the dose
const give = (c, pid, body) => c.post(`/api/patients/${pid}/administrations`, body);
const G = (orderId, o = {}) => ({ orderId, outcome: 'given', administeredAt: t(), ...o });

test('record: a nurse can; the recorder is the signed-in user; nothing is copied from the order; a viewer reads but cannot record', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(d), o = await order(d, pid);
  const a = await give(n, pid, G(o.id, { dose: ' 2 tablets ', note: ' with water ' }));
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const x = a.body.administration;
  assert.deepEqual([x.recorded_by, x.status, x.row_version, x.outcome, x.dose_text, x.note_text, x.reason_text, x.medication], ['nurse1', 'recorded', 1, 'given', '2 tablets', 'with water', null, 'Order drug']);
  assert.deepEqual(x.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'recorded', 'nurse1']]);
  const noDose = await give(d, pid, G(o.id)); assert.equal(noDose.body.administration.dose_text, null, 'the order dose is not filled in');
  assert.equal((await give(v, pid, G(o.id))).status, 403);
  assert.equal((await v.get(`/api/patients/${pid}/administrations`)).body.administrations.length, 2);
  assert.equal((await v.get(`/api/patients/${pid}/administrations?orderId=${o.id}`)).body.administrations.length, 2);
  assert.equal((await v.get(`/api/administrations/${x.id}`)).status, 200);
});

test('held and refused need a reason and carry no dose; a bad outcome, unknown fields and bad shapes are refused and nothing is saved', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), o = await order(d, pid);
  assert.equal((await give(d, pid, G(o.id, { outcome: 'held', reason: ' Nil by mouth ' }))).body.administration.reason_text, 'Nil by mouth');
  assert.equal((await give(d, pid, G(o.id, { outcome: 'refused', reason: 'Patient declined' }))).status, 201);
  for (const extra of [{ recordedBy: 1 }, { recorded_by: 'nurse1' }, { status: 'entered_in_error' }, { errorBy: 1 }]) { const r = await give(d, pid, { ...G(o.id), ...extra }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  const future = new Date(Date.now() + 3600e3).toISOString();
  for (const body of [{}, { ...G(o.id), orderId: 'x' }, { ...G(o.id), orderId: 0 }, { ...G(o.id), outcome: 'GIVEN' }, { ...G(o.id), outcome: 'omitted' }, { ...G(o.id), outcome: undefined },
    G(o.id, { outcome: 'held' }), G(o.id, { outcome: 'refused', reason: '  ' }), G(o.id, { outcome: 'held', reason: 'r', dose: '1 tab' }),
    G(o.id, { dose: '  ' }), G(o.id, { dose: 'x'.repeat(201) }), G(o.id, { dose: 5 }), G(o.id, { note: 'y'.repeat(501) }), G(o.id, { note: 'bad\u0000' }), G(o.id, { reason: 5 }),
    G(o.id, { administeredAt: '2026-11-20T09:30:00' }), G(o.id, { administeredAt: '2026-02-30T10:00:00Z' }), G(o.id, { administeredAt: 'now' }), G(o.id, { administeredAt: future }), G(o.id, { administeredAt: 5 })])
    assert.equal((await give(d, pid, body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM medication_administrations WHERE patient_id = $1', [pid])).rows[0].n, 2);
});

test('the order must be an order of this patient, made before the dose, not entered in error, and an ended order takes only earlier doses; the same moment records once', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), other = await newPatient(d), o = await order(d, pid), o2 = await order(d, other);
  assert.equal((await give(d, pid, G(o2.id))).body.error, 'order_not_of_patient');
  assert.equal((await give(d, pid, G(999999))).body.error, 'order_not_of_patient');
  assert.equal((await give(d, pid, G(o.id, { administeredAt: '2020-01-01T00:00:00Z' }))).body.error, 'before_order');
  const at = t();
  assert.equal((await give(d, pid, G(o.id, { administeredAt: at }))).status, 201);
  const dup = await give(d, pid, G(o.id, { administeredAt: at })); assert.equal(dup.status, 409); assert.equal(dup.body.error, 'duplicate');
  await new Promise(r => setTimeout(r, 20));
  const mid = t();   // a moment while the order was still active
  await new Promise(r => setTimeout(r, 20));
  const stop = await d.post(`/api/medication-orders/${o.id}/stop`, { reason: 'Course finished', rowVersion: 1 }); assert.equal(stop.status, 200, JSON.stringify(stop.body));
  await new Promise(r => setTimeout(r, 10));
  assert.equal((await give(d, pid, G(o.id, { administeredAt: t() }))).body.error, 'order_ended');
  assert.equal((await give(d, pid, G(o.id, { administeredAt: mid }))).status, 201, 'a dose before the order ended can still be recorded');
  const o3 = await order(d, pid); assert.equal((await d.post(`/api/medication-orders/${o3.id}/entered-in-error`, { reason: 'Wrong patient', rowVersion: 1 })).status, 200);
  assert.equal((await give(d, pid, G(o3.id))).body.error, 'order_in_error');
});

test('entered in error: needs a reason and the loaded version; final; the row stays and is hidden unless asked for; a stale version gives 409', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), pid = await newPatient(d), o = await order(d, pid);
  const a = (await give(n, pid, G(o.id))).body.administration, url = `/api/administrations/${a.id}/entered-in-error`;
  for (const body of [{}, { rowVersion: 1 }, { reason: '  ', rowVersion: 1 }, { reason: 'x'.repeat(1001), rowVersion: 1 }, { reason: 'r' }, { reason: 'r', rowVersion: 'a' }]) assert.equal((await n.post(url, body)).status, 400, JSON.stringify(body));
  assert.equal((await n.post(url, { reason: 'r', rowVersion: 1, errorBy: 1 })).body.error, 'unknown_field');
  assert.equal((await n.post(url, { reason: 'r', rowVersion: 7 })).status, 409);
  const ok = await n.post(url, { reason: ' Wrong patient ', rowVersion: 1 }); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const x = ok.body.administration; assert.deepEqual([x.status, x.row_version, x.error_by, x.error_reason], ['entered_in_error', 2, 'nurse1', 'Wrong patient']);
  assert.deepEqual(x.events.map(e => [e.seq, e.from_status, e.to_status, e.reason]), [[1, null, 'recorded', null], [2, 'recorded', 'entered_in_error', 'Wrong patient']]);
  assert.equal((await d.post(url, { reason: 'again', rowVersion: 2 })).body.error, 'administration_final');
  assert.equal((await d.get(`/api/patients/${pid}/administrations`)).body.administrations.length, 0);
  assert.equal((await d.get(`/api/patients/${pid}/administrations?include=all`)).body.administrations.length, 1);
  assert.equal((await give(d, pid, G(o.id, { administeredAt: a.administered_at }))).status, 201, 'the moment is free again once the entry was in error');
  assert.equal((await d.post('/api/administrations/999999/entered-in-error', { reason: 'r', rowVersion: 1 })).status, 404);
  assert.equal((await d.get('/api/administrations/abc')).status, 404);
});

test('the audit log keeps ids, outcome and lengths, never the dose, reason or note; the database refuses edits, deletes, truncates and bad rows (owner and app role)', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), o = await order(d, pid);
  const a = (await give(d, pid, G(o.id, { dose: 'SECRET-DOSE', note: 'SECRET-NOTE' }))).body.administration;
  await give(d, pid, G(o.id, { outcome: 'held', reason: 'SECRET-REASON' }));
  const log = (await env.pool.query(`SELECT action, detail FROM audit_log WHERE action LIKE 'administration.%'`)).rows;
  assert.ok(log.length >= 2 && !JSON.stringify(log).match(/SECRET/), 'no text in the audit log'); assert.ok(log.some(r => r.detail.outcome === 'held'));
  const q = (sql, p) => env.pool.query(sql, p), app = (sql, p) => env.appPool.query(sql, p);
  await assert.rejects(q(`UPDATE medication_administrations SET dose_text = 'x', row_version = 2 WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(q(`UPDATE medication_administrations SET status = 'recorded', row_version = 2 WHERE id = $1`, [a.id]), /only move to entered in error/);
  await assert.rejects(app(`UPDATE medication_administrations SET dose_text = 'x' WHERE id = $1`, [a.id]), /permission denied/);
  await assert.rejects(q('DELETE FROM medication_administrations WHERE id = $1', [a.id]), /append-only|not allowed/); await assert.rejects(app('DELETE FROM medication_administrations WHERE id = $1', [a.id]), /permission denied|append-only/);
  await assert.rejects(q('TRUNCATE medication_administrations'), /append-only|cannot truncate/);
  await assert.rejects(q('UPDATE medication_administration_events SET reason = $1 WHERE administration_id = $2', ['x', a.id]), /append-only|not allowed/);
  await assert.rejects(q(`INSERT INTO medication_administrations(patient_id, order_id, outcome, administered_at, recorded_by) VALUES ($1,$2,'held',(SELECT ordered_at FROM medication_orders WHERE id = $2), 1)`, [pid, o.id]), /check|reason_text/i);
  await assert.rejects(q(`INSERT INTO medication_administrations(patient_id, order_id, outcome, administered_at, recorded_by) VALUES ($1,$2,'given',now() + interval '1 hour', 1)`, [pid, o.id]), /future/);
  await assert.rejects(q(`INSERT INTO medication_administrations(patient_id, order_id, outcome, administered_at, recorded_by) VALUES ($1,$2,'given',(SELECT ordered_at FROM medication_orders WHERE id = $2), 1)`, [pid + 9999, o.id]), /foreign key|not an order of this patient/);
});
