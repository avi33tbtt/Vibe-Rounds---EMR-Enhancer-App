'use strict';
// Task R4f: specimens and results for investigation orders (append-only; correction by a new row). Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newOrder(c) {
  const p = await c.post('/api/patients', { name: 'Result Patient ' + (++seq), mrn: 'RES-' + seq, dob: '1990-04-04', sex: 'M' });
  assert.equal(p.status, 201);
  const o = await c.post(`/api/patients/${p.body.patient.id}/investigation-orders`, { testName: 'A test' });
  assert.equal(o.status, 201); return { pid: p.body.patient.id, oid: o.body.order.id };
}
const R = { valueText: '5.2', unitText: 'units', referenceText: 'as the lab states', flag: 'normal' };
const addRes = (c, oid, body = R) => c.post(`/api/investigation-orders/${oid}/results`, body);

test('specimen: nurse and doctor can record; the recorder is the signed-in user; collection time defaults to now; a viewer cannot but can read', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), { oid } = await newOrder(d);
  const a = await n.post(`/api/investigation-orders/${oid}/specimens`, { specimenType: ' Venous blood ' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual([a.body.specimen.specimen_type, a.body.specimen.recorded_by, a.body.specimen.order_id], ['Venous blood', 'nurse1', oid]); assert.ok(a.body.specimen.collected_at);
  const b = await d.post(`/api/investigation-orders/${oid}/specimens`, { specimenType: 'Urine', collectedAt: '2026-11-20T08:30:00Z' });
  assert.equal(b.status, 201); assert.equal(new Date(b.body.specimen.collected_at).toISOString(), '2026-11-20T08:30:00.000Z');
  assert.equal((await v.post(`/api/investigation-orders/${oid}/specimens`, { specimenType: 'x' })).status, 403);
  const g = await v.get(`/api/investigation-orders/${oid}/results`); assert.equal(g.status, 200); assert.equal(g.body.specimens.length, 2); assert.deepEqual(g.body.results, []);
});

test('specimen: unknown fields and bad values are refused and nothing is saved', async () => {
  const d = await as('doctor1'), { oid } = await newOrder(d);
  for (const body of [{ specimenType: 'x', recordedBy: 1 }, { specimenType: 'x', orderId: 1 }, {}, { specimenType: '  ' }, { specimenType: 'x'.repeat(201) }, { specimenType: 'x', collectedAt: 'yesterday' }, { specimenType: 'x', collectedAt: '2099-01-01T00:00:00Z' }, { specimenType: 'x', collectedAt: '1800-01-01T00:00:00Z' }])
    assert.equal((await d.post(`/api/investigation-orders/${oid}/specimens`, body)).status, 400, JSON.stringify(body));
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM investigation_specimens WHERE order_id = $1', [oid])).rows[0].n, 0);
  assert.equal((await d.post('/api/investigation-orders/999999/specimens', { specimenType: 'x' })).status, 404);
});

test('result: as reported, never computed; the recorder is the session; flag defaults to not_stated; a specimen of the same order can be linked', async () => {
  const n = await as('nurse1'), { oid } = await newOrder(n);
  const sp = (await n.post(`/api/investigation-orders/${oid}/specimens`, { specimenType: 'Blood' })).body.specimen;
  const a = await addRes(n, oid, { ...R, specimenId: sp.id });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual([a.body.result.value_text, a.body.result.unit_text, a.body.result.reference_text, a.body.result.flag, a.body.result.recorded_by, a.body.result.specimen_id, a.body.result.replaced, a.body.result.replaces_result_id],
    ['5.2', 'units', 'as the lab states', 'normal', 'nurse1', sp.id, false, null]);
  const b = await addRes(n, oid, { valueText: ' positive ' });
  assert.deepEqual([b.body.result.value_text, b.body.result.unit_text, b.body.result.flag], ['positive', null, 'not_stated']);
  const other = (await newOrder(n)).oid, osp = (await n.post(`/api/investigation-orders/${other}/specimens`, { specimenType: 'x' })).body.specimen;
  const r = await addRes(n, oid, { ...R, specimenId: osp.id }); assert.equal(r.status, 400); assert.equal(r.body.error, 'specimen_not_of_order');
});

test('result: unknown fields, bad shapes and roles are refused', async () => {
  const d = await as('doctor1'), v = await as('viewer1'), { oid } = await newOrder(d);
  assert.equal((await addRes(v, oid)).status, 403);
  for (const body of [{ ...R, recordedBy: 1 }, { ...R, replacesResultId: 1 }, { ...R, orderId: 2 }, { unitText: 'x' }, { valueText: '  ' }, { valueText: 'x'.repeat(501) }, { ...R, unitText: 'x'.repeat(101) }, { ...R, referenceText: 'x'.repeat(201) }, { ...R, flag: 'critical' }, { ...R, specimenId: 'a' }, { valueText: 'bad\u0000' }])
    assert.equal((await addRes(d, oid, body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM investigation_results WHERE order_id = $1', [oid])).rows[0].n, 0);
  assert.equal((await addRes(d, 999999)).status, 404);
});

test('correct: a NEW result replaces the old one (reason needed); the old row stays and is shown as replaced; only the newest can be corrected', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), { oid } = await newOrder(d);
  const a = (await addRes(d, oid)).body.result, url = `/api/investigation-results/${a.id}/correct`;
  assert.equal((await d.post(url, { valueText: '6.1' })).status, 400);                                    // no reason
  assert.equal((await d.post(url, { reason: 'typo' })).status, 400);                                      // no value
  assert.equal((await d.post(url, { valueText: '6.1', reason: 'typo', recordedBy: 1 })).status, 400);
  assert.equal((await d.post(url, { valueText: '6.1', reason: 'typo', replacesResultId: 5 })).status, 400);
  const c = await n.post(url, { valueText: '6.1', unitText: 'units', flag: 'abnormal', reason: ' typo ' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([c.body.result.value_text, c.body.result.flag, c.body.result.replaces_result_id, c.body.result.correction_reason, c.body.result.recorded_by, c.body.result.replaced], ['6.1', 'abnormal', a.id, 'typo', 'nurse1', false]);
  assert.equal(c.body.replaced.replaced, true); assert.equal(c.body.replaced.value_text, '5.2', 'the old row is untouched');
  const again = await d.post(url, { valueText: '7', reason: 'x' }); assert.equal(again.status, 409); assert.equal(again.body.error, 'already_corrected');
  assert.equal((await d.post(`/api/investigation-results/${c.body.result.id}/correct`, { valueText: '6.2', reason: 'again' })).status, 201);
  const g = (await d.get(`/api/investigation-orders/${oid}/results`)).body.results;
  assert.deepEqual(g.map(x => [x.value_text, x.replaced]), [['5.2', true], ['6.1', true], ['6.2', false]]);
  assert.equal((await d.post('/api/investigation-results/999999/correct', { valueText: 'x', reason: 'y' })).status, 404);
});

test('two corrections at once: one wins, the other gets 409', async () => {
  const d = await as('doctor1'), { oid } = await newOrder(d), a = (await addRes(d, oid)).body.result;
  const r = await Promise.all([1, 2].map(i => d.post(`/api/investigation-results/${a.id}/correct`, { valueText: 'v' + i, reason: 'race' })));
  assert.deepEqual(r.map(x => x.status).sort(), [201, 409]);
});

test('a cancelled order takes no specimens, results or corrections', async () => {
  const d = await as('doctor1'), { oid } = await newOrder(d), a = (await addRes(d, oid)).body.result;
  assert.equal((await d.post(`/api/investigation-orders/${oid}/cancel`, { reason: 'x', rowVersion: 1 })).status, 200);
  for (const r of [await d.post(`/api/investigation-orders/${oid}/specimens`, { specimenType: 'x' }), await addRes(d, oid), await d.post(`/api/investigation-results/${a.id}/correct`, { valueText: 'v', reason: 'x' })]) { assert.equal(r.status, 409); assert.equal(r.body.error, 'order_not_active'); }
  assert.equal((await d.get(`/api/investigation-orders/${oid}/results`)).body.results.length, 1, 'existing rows stay visible');
});

test('the database refuses what the routes would: no change, delete or truncate, no other patient, no cancelled order, no cross-order links', async () => {
  const d = await as('doctor1'), { pid, oid } = await newOrder(d), other = await newOrder(d);
  const a = (await addRes(d, oid)).body.result, sp = (await d.post(`/api/investigation-orders/${oid}/specimens`, { specimenType: 'x' })).body.specimen;
  for (const tbl of ['investigation_results', 'investigation_specimens']) {
    await assert.rejects(env.pool.query(`DELETE FROM ${tbl}`)); await assert.rejects(env.pool.query(`TRUNCATE ${tbl}`));
    await assert.rejects(env.appPool.query(`DELETE FROM ${tbl}`), /permission denied/); await assert.rejects(env.appPool.query(`UPDATE ${tbl} SET recorded_by = 1`), /permission denied/);
  }
  await assert.rejects(env.pool.query(`UPDATE investigation_results SET value_text = 'x' WHERE id = $1`, [a.id])); await assert.rejects(env.pool.query(`UPDATE investigation_specimens SET specimen_type = 'x' WHERE id = $1`, [sp.id]));
  const u = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  const ins = (o, p, extra = 'NULL') => env.pool.query(`INSERT INTO investigation_results(order_id, patient_id, value_text, recorded_by, specimen_id) VALUES ($1,$2,'v',$3,${extra})`, [o, p, u]);
  await assert.rejects(ins(oid, other.pid), /not of this patient/);
  await assert.rejects(ins(oid, pid, String(sp.id + 1000)));                                                           // no such specimen
  const osp = (await d.post(`/api/investigation-orders/${other.oid}/specimens`, { specimenType: 'y' })).body.specimen;
  await assert.rejects(ins(oid, pid, String(osp.id)));                                                                  // specimen of another order
  await assert.rejects(env.pool.query(`INSERT INTO investigation_results(order_id, patient_id, value_text, recorded_by, replaces_result_id, correction_reason) VALUES ($1,$2,'v',$3,$4,'r')`, [other.oid, other.pid, u, a.id]), /same order/);
  await assert.rejects(env.pool.query(`INSERT INTO investigation_results(order_id, patient_id, value_text, recorded_by, replaces_result_id) VALUES ($1,$2,'v',$3,$4)`, [oid, pid, u, a.id]));   // a correction needs a reason
  await d.post(`/api/investigation-orders/${oid}/cancel`, { reason: 'x', rowVersion: 1 });
  await assert.rejects(ins(oid, pid), /active order/);
});

test('the audit log keeps ids, flag and lengths only: no value, unit, reference, specimen type or reason text', async () => {
  const d = await as('doctor1'), { pid, oid } = await newOrder(d);
  await d.post(`/api/investigation-orders/${oid}/specimens`, { specimenType: 'SECRETSPECIMEN' });
  const a = (await addRes(d, oid, { valueText: 'SECRETVALUE', unitText: 'SECRETUNIT', referenceText: 'SECRETREF', flag: 'abnormal' })).body.result;
  await d.post(`/api/investigation-results/${a.id}/correct`, { valueText: 'SECRETVALUE2', reason: 'SECRETREASON' });
  const rows = (await env.pool.query(`SELECT detail::text AS t FROM audit_log WHERE action LIKE 'investigation_%' AND entity_id = $1`, [String(pid)])).rows;
  assert.ok(rows.length >= 4); for (const r of rows) assert.doesNotMatch(r.t, /SECRET/);
});
