'use strict';
// Task R4h-1: referrals on the server (refer, cancel, entered in error). Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Referral Patient ' + (++seq), mrn: 'REF-' + seq, dob: '1980-03-03', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const refer = (c, pid, body) => c.post(`/api/patients/${pid}/referrals`, body);
const R = { destination: 'Cardiology clinic', reason: 'Needs review' };

test('refer: doctor can; the referrer is the signed-in user; priority defaults to routine; nurse and viewer cannot refer but can read', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(d);
  const a = await refer(d, pid, { destination: ' Cardiology clinic ', reason: ' Needs review ' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const o = a.body.referral;
  assert.deepEqual([o.referred_by, o.status, o.row_version, o.destination_text, o.reason_text, o.priority], ['doctor1', 'active', 1, 'Cardiology clinic', 'Needs review', 'routine']);
  assert.deepEqual(o.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'doctor1']]);
  assert.equal((await refer(d, pid, { ...R, priority: 'urgent' })).body.referral.priority, 'urgent');
  assert.equal((await refer(n, pid, R)).status, 403); assert.equal((await refer(v, pid, R)).status, 403);
  assert.equal((await n.get(`/api/patients/${pid}/referrals`)).body.referrals.length, 2);
  assert.equal((await v.get(`/api/referrals/${o.id}`)).status, 200);
});

test('refer: unknown fields and bad shapes are refused and nothing is saved', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  for (const extra of [{ referredBy: 1 }, { referred_by: 'nurse1' }, { status: 'cancelled' }, { cancelledBy: 1 }]) { const r = await refer(d, pid, { ...R, ...extra }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  for (const body of [{}, { destination: 'x' }, { reason: 'x' }, { ...R, destination: '  ' }, { ...R, reason: '  ' }, { ...R, destination: 'x'.repeat(201) }, { ...R, reason: 'y'.repeat(501) },
    { ...R, destination: 'bad\u0000' }, { ...R, priority: 'stat' }, { ...R, originCaseId: 'abc' }, { ...R, destination: 5 }])
    assert.equal((await refer(d, pid, body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await refer(d, 999999, R)).status, 404);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_referrals WHERE patient_id = $1', [pid])).rows[0].n, 0);
});

test('refer: a case of another patient and an archived patient are refused', async () => {
  const d = await as('doctor1'), p1 = await newPatient(d), p2 = await newPatient(d);
  const k = await d.post(`/api/patients/${p2}/cases`, { title: 'Other case' }); assert.equal(k.status, 201);
  const r = await refer(d, p1, { ...R, originCaseId: k.body.case.id }); assert.equal(r.status, 400); assert.equal(r.body.error, 'case_not_of_patient');
  assert.equal((await refer(d, p2, { ...R, originCaseId: k.body.case.id })).body.referral.origin_case_id, k.body.case.id);
  assert.equal((await d.patch(`/api/patients/${p1}/archive`, { archived: true })).status, 200);
  assert.equal((await refer(d, p1, R)).status, 409);
});

test('cancel and entered in error: reason and loaded version needed; only an active referral can be cancelled; entered in error is final and hidden unless include=all', async () => {
  const d = await as('doctor1'), n = await as('nurse1'), pid = await newPatient(d), a = (await refer(d, pid, R)).body.referral, u = `/api/referrals/${a.id}`;
  assert.equal((await n.post(u + '/cancel', { reason: 'x', rowVersion: 1 })).status, 403);
  assert.equal((await d.post(u + '/cancel', { rowVersion: 1 })).status, 400); assert.equal((await d.post(u + '/cancel', { reason: 'x' })).status, 400);
  assert.equal((await d.post(u + '/cancel', { reason: 'x', rowVersion: 1, cancelledBy: 1 })).status, 400);
  const st = await d.post(u + '/cancel', { reason: 'x', rowVersion: 5 }); assert.equal(st.status, 409); assert.equal(st.body.error, 'version_conflict');
  const c = await d.post(u + '/cancel', { reason: ' not needed ', rowVersion: 1 });
  assert.equal(c.status, 200); assert.deepEqual([c.body.referral.status, c.body.referral.cancelled_by, c.body.referral.cancel_reason, c.body.referral.row_version], ['cancelled', 'doctor1', 'not needed', 2]);
  assert.equal((await d.post(u + '/cancel', { reason: 'x', rowVersion: 2 })).body.error, 'not_active');
  const e = await d.post(u + '/entered-in-error', { reason: 'wrong patient', rowVersion: 2 });
  assert.equal(e.status, 200); assert.deepEqual([e.body.referral.status, e.body.referral.cancel_reason, e.body.referral.events.length], ['entered_in_error', 'not needed', 3]);
  assert.equal((await d.post(u + '/entered-in-error', { reason: 'x', rowVersion: 3 })).body.error, 'referral_final');
  assert.equal((await d.get(`/api/patients/${pid}/referrals`)).body.referrals.length, 0);
  assert.equal((await d.get(`/api/patients/${pid}/referrals?include=all`)).body.referrals.length, 1);
  assert.equal((await d.get('/api/referrals/999999')).status, 404); assert.equal((await d.get('/api/referrals/abc')).status, 404);
});

test('two cancels at once: one wins, the other gets 409', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await refer(d, pid, R)).body.referral;
  const r = await Promise.all([1, 2].map(() => d.post(`/api/referrals/${a.id}/cancel`, { reason: 'race', rowVersion: 1 })));
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_referral_events WHERE referral_id = $1', [a.id])).rows[0].n, 2);
});

test('referrals of one patient never show under another patient', async () => {
  const d = await as('doctor1'), p1 = await newPatient(d), p2 = await newPatient(d);
  await refer(d, p1, R);
  assert.equal((await d.get(`/api/patients/${p2}/referrals?include=all`)).body.referrals.length, 0);
});

test('the database refuses what the routes would: no delete or truncate, no content edit, no change from the app role, no bad moves', async () => {
  const d = await as('doctor1'), pid = await newPatient(d), a = (await refer(d, pid, R)).body.referral;
  await assert.rejects(env.pool.query('DELETE FROM patient_referrals')); await assert.rejects(env.pool.query('TRUNCATE patient_referrals'));
  await assert.rejects(env.pool.query('DELETE FROM patient_referral_events')); await assert.rejects(env.pool.query(`UPDATE patient_referral_events SET reason = 'x'`));
  await assert.rejects(env.appPool.query(`UPDATE patient_referrals SET destination_text = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE patient_referrals SET priority = 'urgent'`), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM patient_referrals'), /permission denied/);
  await assert.rejects(env.pool.query(`UPDATE patient_referrals SET priority = 'urgent' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.pool.query(`UPDATE patient_referrals SET status = 'cancelled', row_version = 2 WHERE id = $1`, [a.id]));   // a cancel needs who, when and a reason
  await assert.rejects(env.pool.query(`UPDATE patient_referrals SET status = 'active' WHERE id = $1`, [a.id]));
});

test('the audit log keeps ids and lengths only: no destination, reason or move reason text', async () => {
  const d = await as('doctor1'), pid = await newPatient(d);
  const a = await refer(d, pid, { destination: 'SECRETDEST', reason: 'SECRETWHY' }); assert.equal(a.status, 201);
  await d.post(`/api/referrals/${a.body.referral.id}/cancel`, { reason: 'SECRETREASON', rowVersion: 1 });
  await d.get(`/api/patients/${pid}/referrals`);
  const rows = (await env.pool.query(`SELECT detail::text AS t FROM audit_log WHERE action LIKE 'referral.%' OR action = 'patient.referrals_view'`)).rows;
  assert.ok(rows.length >= 3); for (const r of rows) assert.doesNotMatch(r.t, /SECRET/);
});
