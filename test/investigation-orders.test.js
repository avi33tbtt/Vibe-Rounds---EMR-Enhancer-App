'use strict';
// Task R4e: investigation orders on the server (order, cancel, entered in error). Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Investigation Patient ' + (++seq), mrn: 'INV-' + seq, dob: '1980-03-03', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const order = (c, pid, body) => c.post(`/api/patients/${pid}/investigation-orders`, body);
async function term(code, category, status, display) {   // made on the owner connection; the review workflow itself is tested in local-terms.test.js
  const u = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  return (await env.pool.query(`INSERT INTO local_terms(code, version, display, category, status, created_by) VALUES ($1,1,$2,$3,$4,$5) RETURNING id`, [code, display, category, status, u])).rows[0].id;
}

test('order: doctor can; the orderer is the signed-in user; priority defaults to routine; nurse and viewer cannot order but can read', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(d);
  const a = await order(d, pid, { testName: 'Some test', clinicalInfo: 'because' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const o = a.body.order;
  assert.deepEqual([o.ordered_by, o.status, o.row_version, o.term_id, o.test_name, o.priority, o.clinical_info], ['doctor1', 'active', 1, null, 'Some test', 'routine', 'because']);
  assert.deepEqual(o.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'doctor1']]);
  assert.equal((await order(d, pid, { testName: 'Rush', priority: 'urgent' })).body.order.priority, 'urgent');
  assert.equal((await order(n, pid, { testName: 'x' })).status, 403); assert.equal((await order(v, pid, { testName: 'x' })).status, 403);
  assert.equal((await n.get(`/api/patients/${pid}/investigation-orders`)).body.orders.length, 2);
  assert.equal((await v.get(`/api/investigation-orders/${o.id}`)).status, 200);
});

test('order: unknown fields, bad shapes and name rules are refused and nothing is saved', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), t = await term('inv.both.test', 'test', 'published', 'Both test');
  for (const extra of [{ orderedBy: 1 }, { ordered_by: 'nurse1' }, { status: 'cancelled' }, { cancelledBy: 1 }]) { const r = await order(d, pid, { testName: 'x', ...extra }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  for (const body of [{}, { termId: t, testName: 'x' }, { testName: '  ' }, { testName: 'x'.repeat(201) }, { testName: 'bad\u0000' }, { testName: 'x', priority: 'stat' }, { testName: 'x', clinicalInfo: 'y'.repeat(501) }, { testName: 'x', originCaseId: 'a' }, { termId: 'a' }])
    assert.equal((await order(d, pid, body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM investigation_orders WHERE patient_id = $1', [pid])).rows[0].n, 0);
});

test('order from a term: only a published test term; the display is copied; the database refuses the same on its own', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const good = await term('inv.good.test', 'test', 'published', 'Good test'), draft = await term('inv.draft.test', 'test', 'draft', 'Draft test'), drug = await term('inv.drug.term', 'drug', 'published', 'A drug');
  const a = await order(d, pid, { termId: good });
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.order.term_id, good); assert.equal(a.body.order.test_name, 'Good test');
  for (const id of [draft, drug, 999999]) { const r = await order(d, pid, { termId: id }); assert.equal(r.status, 400); assert.equal(r.body.error, 'term_not_usable'); }
  const u = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  const ins = (tid, name) => env.pool.query(`INSERT INTO investigation_orders(patient_id, term_id, test_name, ordered_by) VALUES ($1,$2,$3,$4)`, [pid, tid, name, u]);
  await assert.rejects(ins(draft, 'Draft test'), /published local test term/); await assert.rejects(ins(drug, 'A drug'), /published local test term/); await assert.rejects(ins(good, 'Other'), /display of its local term/);
});

test('order: a case of another patient and an archived patient are refused', async () => {
  const d = await as('doctor1'), p1 = await newPatient(d), p2 = await newPatient(d);
  const k = await d.post(`/api/patients/${p2}/cases`, { title: 'Other case' }); assert.equal(k.status, 201);
  const r = await order(d, p1, { testName: 'x', originCaseId: k.body.case.id }); assert.equal(r.status, 400); assert.equal(r.body.error, 'case_not_of_patient');
  assert.equal((await order(d, p2, { testName: 'x', originCaseId: k.body.case.id })).body.order.origin_case_id, k.body.case.id);
  assert.equal((await d.patch(`/api/patients/${p1}/archive`, { archived: true })).status, 200);
  assert.equal((await order(d, p1, { testName: 'x' })).status, 409);
});

test('cancel and entered in error: reason and loaded version needed; only an active order can be cancelled; entered in error is final and hidden unless include=all', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), pid = await newPatient(d), a = (await order(d, pid, { testName: 'x' })).body.order, u = `/api/investigation-orders/${a.id}`;
  assert.equal((await n.post(u + '/cancel', { reason: 'x', rowVersion: 1 })).status, 403);
  assert.equal((await d.post(u + '/cancel', { rowVersion: 1 })).status, 400); assert.equal((await d.post(u + '/cancel', { reason: 'x' })).status, 400);
  assert.equal((await d.post(u + '/cancel', { reason: 'x', rowVersion: 1, cancelledBy: 1 })).status, 400);
  const st = await d.post(u + '/cancel', { reason: 'x', rowVersion: 5 }); assert.equal(st.status, 409); assert.equal(st.body.error, 'version_conflict');
  const c = await d.post(u + '/cancel', { reason: ' not needed ', rowVersion: 1 });
  assert.equal(c.status, 200); assert.deepEqual([c.body.order.status, c.body.order.cancelled_by, c.body.order.cancel_reason, c.body.order.row_version], ['cancelled', 'doctor1', 'not needed', 2]);
  assert.equal((await d.post(u + '/cancel', { reason: 'x', rowVersion: 2 })).body.error, 'not_active');
  const e = await d.post(u + '/entered-in-error', { reason: 'wrong patient', rowVersion: 2 });
  assert.equal(e.status, 200); assert.deepEqual([e.body.order.status, e.body.order.cancel_reason, e.body.order.events.length], ['entered_in_error', 'not needed', 3]);
  assert.equal((await d.post(u + '/entered-in-error', { reason: 'x', rowVersion: 3 })).body.error, 'order_final');
  assert.equal((await d.get(`/api/patients/${pid}/investigation-orders`)).body.orders.length, 0);
  assert.equal((await d.get(`/api/patients/${pid}/investigation-orders?include=all`)).body.orders.length, 1);
  assert.equal((await d.get('/api/investigation-orders/999999')).status, 404); assert.equal((await d.get('/api/investigation-orders/abc')).status, 404);
});

test('two cancels at once: one wins, the other gets 409', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await order(d, pid, { testName: 'x' })).body.order;
  const r = await Promise.all([1, 2].map(() => d.post(`/api/investigation-orders/${a.id}/cancel`, { reason: 'race', rowVersion: 1 })));
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM investigation_order_events WHERE order_id = $1', [a.id])).rows[0].n, 2);
});

test('the database refuses what the routes would: no delete or truncate, no content edit, no change from the app role, no bad moves', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await order(d, pid, { testName: 'x' })).body.order;
  await assert.rejects(env.pool.query('DELETE FROM investigation_orders')); await assert.rejects(env.pool.query('TRUNCATE investigation_orders'));
  await assert.rejects(env.pool.query('DELETE FROM investigation_order_events')); await assert.rejects(env.pool.query(`UPDATE investigation_order_events SET reason = 'x'`));
  await assert.rejects(env.appPool.query(`UPDATE investigation_orders SET test_name = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE investigation_orders SET priority = 'urgent'`), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM investigation_orders'), /permission denied/);
  await assert.rejects(env.pool.query(`UPDATE investigation_orders SET priority = 'urgent' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.pool.query(`UPDATE investigation_orders SET status = 'cancelled', row_version = 2 WHERE id = $1`, [a.id]));   // a cancel needs who, when and a reason
  await assert.rejects(env.pool.query(`UPDATE investigation_orders SET status = 'active' WHERE id = $1`, [a.id]));
});

test('the audit log keeps ids and lengths only: no test name, clinical info or reason text', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const a = await order(d, pid, { testName: 'SECRETTEST', clinicalInfo: 'SECRETINFO' }); assert.equal(a.status, 201);
  await d.post(`/api/investigation-orders/${a.body.order.id}/cancel`, { reason: 'SECRETREASON', rowVersion: 1 });
  const rows = (await env.pool.query(`SELECT detail::text AS t FROM audit_log WHERE action LIKE 'investigation_order.%' AND entity_id = $1`, [String(pid)])).rows;
  assert.ok(rows.length >= 2); for (const r of rows) assert.doesNotMatch(r.t, /SECRET/);
});
