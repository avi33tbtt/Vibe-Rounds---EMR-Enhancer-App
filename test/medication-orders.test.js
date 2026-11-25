'use strict';
// Task R4b: medication orders on the server (order, change with reason, stop, entered in error) and the "drug" term category.
// Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Order Patient ' + (++seq), mrn: 'ORD-' + seq, dob: '1970-01-01', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const B = (o = {}) => ({ medication: 'Order drug', doseText: 'as typed dose', routeText: 'as typed route', frequencyText: 'as typed frequency', ...o });
const order = (c, pid, body) => c.post(`/api/patients/${pid}/medication-orders`, body);
// A published drug term made on the owner connection (the review workflow itself is tested in local-terms.test.js).
async function term(code, category, status, display) {
  const u = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  return (await env.pool.query(`INSERT INTO local_terms(code, version, display, category, status, created_by) VALUES ($1,1,$2,$3,$4,$5) RETURNING id`, [code, display, category, status, u])).rows[0].id;
}

test('the drug category exists for local terms; an unknown category is still refused', async () => {
  const d = await as('doctor1');
  const ok = await d.post('/api/local-terms', { code: 'ord.cat.drug', display: 'Category drug', category: 'drug' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.term.category, 'drug');
  assert.equal((await d.post('/api/local-terms', { code: 'ord.cat.bad', display: 'x', category: 'medicine' })).status, 400);
});

test('order: doctor can; the orderer is the signed-in user; nurse and viewer cannot order but can read', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(d);
  const a = await order(d, pid, B({ indicationText: 'a reason' }));
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const o = a.body.order;
  assert.deepEqual([o.ordered_by, o.status, o.row_version, o.term_id, o.medication, o.dose_text, o.route_text, o.frequency_text, o.indication_text], ['doctor1', 'active', 1, null, 'Order drug', 'as typed dose', 'as typed route', 'as typed frequency', 'a reason']);
  assert.deepEqual(o.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'doctor1']]);
  assert.equal((await order(n, pid, B())).status, 403); assert.equal((await order(v, pid, B())).status, 403);
  assert.equal((await n.get(`/api/patients/${pid}/medication-orders`)).body.orders.length, 1);
  assert.equal((await v.get(`/api/medication-orders/${o.id}`)).status, 200);
});

test('order: a body that names an orderer or status is refused; dose, route and frequency are required; name is a term or text, not both, not neither', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  for (const extra of [{ orderedBy: 1 }, { ordered_by: 'nurse1' }, { status: 'stopped' }, { endedBy: 1 }, { replacesOrderId: 1 }]) {
    const r = await order(d, pid, B(extra)); assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.error, 'unknown_field');
  }
  for (const k of ['doseText', 'routeText', 'frequencyText']) { const b = B(); delete b[k]; assert.equal((await order(d, pid, b)).status, 400, k); assert.equal((await order(d, pid, B({ [k]: '   ' }))).status, 400, k); }
  const t = await term('ord.both.drug', 'drug', 'published', 'Both drug');
  const none = B(); delete none.medication;
  assert.equal((await order(d, pid, none)).status, 400);
  assert.equal((await order(d, pid, B({ termId: t }))).status, 400);
  assert.equal((await order(d, pid, B({ medication: 'x'.repeat(201) }))).status, 400);
  assert.equal((await order(d, pid, B({ medication: 'bad\u0000' }))).status, 400);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM medication_orders WHERE patient_id = $1', [pid])).rows[0].n, 0);
});

test('order from a term: only a published drug term; the term display is copied; free text stays unlinked', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const good = await term('ord.good.drug', 'drug', 'published', 'Good drug'), draft = await term('ord.draft.drug', 'drug', 'draft', 'Draft drug'), wrong = await term('ord.test.term', 'test', 'published', 'A test');
  const none = B(); delete none.medication;
  const a = await order(d, pid, { ...none, termId: good });
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.order.term_id, good); assert.equal(a.body.order.medication, 'Good drug');
  for (const id of [draft, wrong, 999999]) { const r = await order(d, pid, { ...none, termId: id }); assert.equal(r.status, 400); assert.equal(r.body.error, 'term_not_usable'); }
  // the database refuses the same things on its own
  const u = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  const ins = (tid, name) => env.pool.query(`INSERT INTO medication_orders(patient_id, term_id, medication, dose_text, route_text, frequency_text, ordered_by) VALUES ($1,$2,$3,'d','r','f',$4)`, [pid, tid, name, u]);
  await assert.rejects(ins(draft, 'Draft drug'), /published local drug term/); await assert.rejects(ins(wrong, 'A test'), /published local drug term/);
  await assert.rejects(ins(good, 'Other name'), /display of its local term/);
});

test('order: a case of another patient is refused; an archived patient is refused', async () => {
  const d = await as('doctor1'), p1 = await newPatient(d), p2 = await newPatient(d);
  const k = await d.post(`/api/patients/${p2}/cases`, { title: 'Other case' }); assert.equal(k.status, 201);
  const r = await order(d, p1, B({ originCaseId: k.body.case.id })); assert.equal(r.status, 400); assert.equal(r.body.error, 'case_not_of_patient');
  const own = await order(d, p2, B({ originCaseId: k.body.case.id })); assert.equal(own.status, 201); assert.equal(own.body.order.origin_case_id, k.body.case.id);
  assert.equal((await d.patch(`/api/patients/${p1}/archive`, { archived: true })).status, 200);
  assert.equal((await order(d, p1, B())).status, 409);
});

test('change: needs a reason and the loaded version; the old order is kept as changed and a new order replaces it', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const a = (await order(d, pid, B())).body.order, url = `/api/medication-orders/${a.id}/change`;
  const nb = B({ medication: 'New drug', doseText: 'new dose' });
  assert.equal((await d.post(url, { ...nb, rowVersion: 1 })).status, 400);                         // no reason
  assert.equal((await d.post(url, { ...nb, reason: 'x' })).status, 400);                            // no rowVersion
  assert.equal((await d.post(url, { ...nb, reason: 'x', rowVersion: 1, orderedBy: 1 })).status, 400);
  assert.equal((await d.post(url, { reason: 'x', rowVersion: 1 })).status, 400);                    // no new content
  const st = await d.post(url, { ...nb, reason: 'x', rowVersion: 9 }); assert.equal(st.status, 409); assert.equal(st.body.error, 'version_conflict'); assert.equal(st.body.currentRowVersion, 1);
  const ok = await d.post(url, { ...nb, reason: ' dose too low ', rowVersion: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.order.status, ok.body.order.row_version, ok.body.order.ended_by, ok.body.order.end_reason, ok.body.order.replaced_by_order_id], ['changed', 2, 'doctor1', 'dose too low', ok.body.newOrder.id]);
  assert.deepEqual([ok.body.newOrder.status, ok.body.newOrder.replaces_order_id, ok.body.newOrder.medication, ok.body.newOrder.dose_text, ok.body.newOrder.ordered_by], ['active', a.id, 'New drug', 'new dose', 'doctor1']);
  assert.deepEqual(ok.body.order.events.map(e => [e.seq, e.from_status, e.to_status]), [[1, null, 'active'], [2, 'active', 'changed']]);
  const again = await d.post(url, { ...nb, reason: 'x', rowVersion: 2 }); assert.equal(again.status, 409); assert.equal(again.body.error, 'not_active');
  assert.equal((await d.get(`/api/patients/${pid}/medication-orders`)).body.orders.length, 2);
  const stop = await d.post(`/api/medication-orders/${a.id}/stop`, { reason: 'x', rowVersion: 2 }); assert.equal(stop.status, 409);   // a changed order cannot be stopped
});

test('a refused change (bad term) leaves the old order active and creates nothing', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await order(d, pid, B())).body.order;
  const none = B(); delete none.medication;
  const r = await d.post(`/api/medication-orders/${a.id}/change`, { ...none, termId: 999999, reason: 'x', rowVersion: 1 });
  assert.equal(r.status, 400);
  const g = (await d.get(`/api/medication-orders/${a.id}`)).body.order;
  assert.deepEqual([g.status, g.row_version, g.events.length], ['active', 1, 1]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM medication_orders WHERE patient_id = $1', [pid])).rows[0].n, 1);
});

test('stop and entered in error: reason and loaded version needed; entered in error is final and hidden unless include=all', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), pid = await newPatient(d), a = (await order(d, pid, B())).body.order;
  assert.equal((await n.post(`/api/medication-orders/${a.id}/stop`, { reason: 'x', rowVersion: 1 })).status, 403);
  assert.equal((await d.post(`/api/medication-orders/${a.id}/stop`, { rowVersion: 1 })).status, 400);
  assert.equal((await d.post(`/api/medication-orders/${a.id}/stop`, { reason: 'x' })).status, 400);
  assert.equal((await d.post(`/api/medication-orders/${a.id}/stop`, { reason: 'x', rowVersion: 5 })).status, 409);
  const s = await d.post(`/api/medication-orders/${a.id}/stop`, { reason: ' done ', rowVersion: 1 });
  assert.equal(s.status, 200); assert.deepEqual([s.body.order.status, s.body.order.ended_by, s.body.order.end_reason, s.body.order.row_version], ['stopped', 'doctor1', 'done', 2]);
  assert.equal((await d.post(`/api/medication-orders/${a.id}/stop`, { reason: 'x', rowVersion: 2 })).body.error, 'not_active');
  const e = await d.post(`/api/medication-orders/${a.id}/entered-in-error`, { reason: 'wrong patient', rowVersion: 2 });
  assert.equal(e.status, 200); assert.equal(e.body.order.status, 'entered_in_error'); assert.equal(e.body.order.end_reason, 'done');
  const f = await d.post(`/api/medication-orders/${a.id}/entered-in-error`, { reason: 'x', rowVersion: 3 }); assert.equal(f.status, 409); assert.equal(f.body.error, 'order_final');
  assert.equal((await d.get(`/api/patients/${pid}/medication-orders`)).body.orders.length, 0);
  assert.equal((await d.get(`/api/patients/${pid}/medication-orders?include=all`)).body.orders.length, 1);
  assert.equal((await d.get('/api/medication-orders/999999')).status, 404); assert.equal((await d.get('/api/medication-orders/abc')).status, 404);
});

test('two stops at once: one wins, the other gets 409', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await order(d, pid, B())).body.order;
  const r = await Promise.all([1, 2].map(() => d.post(`/api/medication-orders/${a.id}/stop`, { reason: 'race', rowVersion: 1 })));
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM medication_order_events WHERE order_id = $1', [a.id])).rows[0].n, 2);
});

test('the database refuses what the routes would: no delete or truncate, no content edit, no change from the app role, no replacement of an active order', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await order(d, pid, B())).body.order;
  await assert.rejects(env.pool.query('DELETE FROM medication_orders'));
  await assert.rejects(env.pool.query('TRUNCATE medication_orders'));
  await assert.rejects(env.pool.query('DELETE FROM medication_order_events'));
  await assert.rejects(env.pool.query(`UPDATE medication_order_events SET reason = 'x'`));
  await assert.rejects(env.appPool.query(`UPDATE medication_orders SET dose_text = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE medication_orders SET medication = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM medication_orders'), /permission denied/);
  await assert.rejects(env.pool.query(`UPDATE medication_orders SET dose_text = 'x' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.pool.query(`UPDATE medication_orders SET status = 'stopped', row_version = 2 WHERE id = $1`, [a.id]));          // a stop needs who, when and a reason
  await assert.rejects(env.pool.query(`UPDATE medication_orders SET status = 'active' WHERE id = $1`, [a.id]));
  const u = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  await assert.rejects(env.pool.query(`INSERT INTO medication_orders(patient_id, medication, dose_text, route_text, frequency_text, ordered_by, replaces_order_id) VALUES ($1,'m','d','r','f',$2,$3)`, [pid, u, a.id]), /replace a changed order/);
});

test('the audit log keeps ids and lengths only: no medication, dose, route, frequency, indication or reason text', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const a = await order(d, pid, B({ medication: 'SECRETDRUGNAME', doseText: 'SECRETDOSE', routeText: 'SECRETROUTE', frequencyText: 'SECRETFREQ', indicationText: 'SECRETWHY' }));
  assert.equal(a.status, 201);
  await d.post(`/api/medication-orders/${a.body.order.id}/stop`, { reason: 'SECRETREASON', rowVersion: 1 });
  const rows = (await env.pool.query(`SELECT detail::text AS t FROM audit_log WHERE action LIKE 'medication_order.%' AND entity_id = $1`, [String(pid)])).rows;
  assert.ok(rows.length >= 2); for (const r of rows) assert.doesNotMatch(r.t, /SECRET/);
});
