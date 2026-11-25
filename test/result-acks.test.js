'use strict';
// Task R4g-1: acknowledgement of abnormal results on the server. Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newOrder(c) {
  const p = await c.post('/api/patients', { name: 'Ack Patient ' + (++seq), mrn: 'ACK-' + seq, dob: '1985-05-05', sex: 'F' });
  const o = await c.post(`/api/patients/${p.body.patient.id}/investigation-orders`, { testName: 'Ack test' });
  assert.equal(o.status, 201); return { pid: p.body.patient.id, oid: o.body.order.id };
}
const addRes = async (c, oid, flag, value = '9') => (await c.post(`/api/investigation-orders/${oid}/results`, { valueText: value, flag })).body.result;
const ack = (c, id, body = {}) => c.post(`/api/investigation-results/${id}/acknowledge`, body);

test('list: only the newest abnormal results, split into waiting and acknowledged; normal, not stated and replaced results are left out; all roles can read', async () => {
  const d = await as('doctor1'), v = await as('viewer1'), { pid, oid } = await newOrder(d);
  const ab = await addRes(d, oid, 'abnormal', 'A'), ab2 = await addRes(d, oid, 'abnormal', 'B');
  await addRes(d, oid, 'normal'); await addRes(d, oid, 'not_stated');
  const fix = await d.post(`/api/investigation-results/${ab2.id}/correct`, { valueText: 'B2', flag: 'abnormal', reason: 'typo' });
  assert.equal((await ack(d, ab.id, { note: 'seen' })).status, 201);
  const g = await v.get(`/api/patients/${pid}/abnormal-results`);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(g.body.pending.map(r => [r.id, r.value_text, r.test_name, r.acknowledged_by]), [[fix.body.result.id, 'B2', 'Ack test', null]]);
  assert.deepEqual(g.body.acknowledged.map(r => [r.id, r.acknowledged_by, r.ack_note]), [[ab.id, 'doctor1', 'seen']]);
  assert.ok(!('recorded_by_id' in g.body.pending[0]));
  assert.equal((await v.get('/api/patients/999999/abnormal-results')).status, 404);
});

test('acknowledge: doctor can; the acknowledger is the session; nurse and viewer cannot; unknown fields and bad notes are refused', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), { oid } = await newOrder(d), r = await addRes(d, oid, 'abnormal');
  assert.equal((await ack(n, r.id)).status, 403); assert.equal((await ack(v, r.id)).status, 403);
  for (const x of [{ acknowledgedBy: 1 }, { acknowledged_by: 'nurse1' }, { resultId: 2 }, { status: 'x' }]) { const e = await ack(d, r.id, x); assert.equal(e.status, 400); assert.equal(e.body.error, 'unknown_field'); }
  for (const note of ['  ', 'x'.repeat(1001), 'bad\u0000', 5]) assert.equal((await ack(d, r.id, { note })).status, 400, String(note).slice(0, 10));
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM investigation_result_acks WHERE result_id = $1', [r.id])).rows[0].n, 0);
  const ok = await ack(d, r.id); assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.acknowledgement.acknowledged_by, ok.body.acknowledgement.note, ok.body.acknowledgement.result_id], ['doctor1', null, r.id]);
  assert.equal((await ack(d, 999999)).status, 404); assert.equal((await ack(d, 'abc')).status, 404);
});

test('acknowledge: once only; only abnormal and not replaced results', async () => {
  const d = await as('doctor1'), { oid } = await newOrder(d), a = await addRes(d, oid, 'abnormal'), nm = await addRes(d, oid, 'normal'), ns = await addRes(d, oid, 'not_stated');
  assert.equal((await ack(d, a.id)).status, 201);
  const again = await ack(d, a.id); assert.equal(again.status, 409); assert.equal(again.body.error, 'already_acknowledged');
  for (const r of [nm, ns]) { const e = await ack(d, r.id); assert.equal(e.status, 409); assert.equal(e.body.error, 'not_flagged_abnormal'); }
  const b = await addRes(d, oid, 'abnormal'); await d.post(`/api/investigation-results/${b.id}/correct`, { valueText: 'v', flag: 'abnormal', reason: 'fix' });
  const rep = await ack(d, b.id); assert.equal(rep.status, 409); assert.equal(rep.body.error, 'result_replaced');
});

test('two acknowledgements at once: one wins, the other gets 409', async () => {
  const d = await as('doctor1'), { oid } = await newOrder(d), r = await addRes(d, oid, 'abnormal');
  const x = await Promise.all([1, 2].map(() => ack(d, r.id))); assert.deepEqual(x.map(y => y.status).sort(), [201, 409]);
});

test('the per-order results view shows who acknowledged', async () => {
  const d = await as('doctor1'), { oid } = await newOrder(d), r = await addRes(d, oid, 'abnormal'); await ack(d, r.id, { note: 'ok' });
  const g = (await d.get(`/api/investigation-orders/${oid}/results`)).body.results[0];
  assert.deepEqual([g.acknowledged_by, g.ack_note], ['doctor1', 'ok']);
});

test('the database refuses what the routes would: no change, delete or truncate, no normal or replaced result, no other patient', async () => {
  const d = await as('doctor1'), { pid, oid } = await newOrder(d), other = await newOrder(d), a = await addRes(d, oid, 'abnormal'), nm = await addRes(d, oid, 'normal');
  await ack(d, a.id);
  await assert.rejects(env.pool.query('DELETE FROM investigation_result_acks')); await assert.rejects(env.pool.query('TRUNCATE investigation_result_acks'));
  await assert.rejects(env.pool.query(`UPDATE investigation_result_acks SET note = 'x'`));
  await assert.rejects(env.appPool.query('DELETE FROM investigation_result_acks'), /permission denied/); await assert.rejects(env.appPool.query(`UPDATE investigation_result_acks SET note = 'x'`), /permission denied/);
  const u = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  const ins = (rid, pat) => env.pool.query('INSERT INTO investigation_result_acks(result_id, patient_id, acknowledged_by) VALUES ($1,$2,$3)', [rid, pat, u]);
  await assert.rejects(ins(nm.id, pid), /flagged abnormal/);
  const b = await addRes(d, oid, 'abnormal'); await d.post(`/api/investigation-results/${b.id}/correct`, { valueText: 'v', flag: 'abnormal', reason: 'fix' });
  await assert.rejects(ins(b.id, pid), /replaced result/);
  const c = await addRes(d, oid, 'abnormal'); await assert.rejects(ins(c.id, other.pid), /not of this patient/);
});

test('the audit log keeps ids and the note length only: no note text', async () => {
  const d = await as('doctor1'), { pid, oid } = await newOrder(d), r = await addRes(d, oid, 'abnormal', 'SECRETVALUE');
  assert.equal((await ack(d, r.id, { note: 'SECRETNOTE' })).status, 201);
  const rows = (await env.pool.query(`SELECT detail::text AS t FROM audit_log WHERE action = 'investigation_result.acknowledge' AND entity_id = $1`, [String(pid)])).rows;
  assert.equal(rows.length, 1); assert.doesNotMatch(rows[0].t, /SECRET/);
});
