'use strict';
// Task R6f-2c: accept ONE ready Condition or AllergyIntolerance proposal into a patient a person chooses. Matrix and audit scenarios are in safety-routes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const num = async (sql, args = []) => Number((await env.pool.query(sql, args)).rows[0].n);
const SECRET = 'Zebra secret label';
async function patient(c) {
  const p = await c.post('/api/patients', { name: 'Pat Patient ' + (++seq), mrn: 'PAT-' + seq, dob: '1980-01-01', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
async function caseOf(c, pid) { const k = await c.post(`/api/patients/${pid}/cases`, { title: 'Case ' + (++seq) }); assert.equal(k.status, 201); return k.body.case.id; }
const cond = (o = {}) => ({ resource: { resourceType: 'Condition', code: { text: SECRET + ' problem ' + (++seq) }, clinicalStatus: { coding: [{ code: 'active' }] }, ...o } });
const alg = (o = {}) => ({ resource: { resourceType: 'AllergyIntolerance', code: { text: SECRET + ' substance ' + (++seq) }, clinicalStatus: { coding: [{ code: 'active' }] }, ...o } });
const medreq = () => ({ resource: { resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: 'Drug' }, dosageInstruction: [{ text: 'as typed' }] } });
const observ = () => ({ resource: { resourceType: 'Observation', status: 'final', code: { text: 'Pulse' }, valueInteger: 7, effectiveDateTime: '2026-11-20T09:30:00Z' } });
async function stage(c, ...entries) {
  const r = await c.post('/api/import/bundles', { resourceType: 'Bundle', type: 'collection', entry: entries });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.bundle.proposals;
}
const toPatient = (c, p, pid, extra = {}) => c.post(`/api/import/proposals/${p.id}/accept-to-patient`, { rowVersion: p.row_version, patientId: pid, ...extra });

test('accept a Condition: the problem is made for the chosen patient; recorder is the session user; starts active; the proposal is marked accepted', async () => {
  const d = await as('doctor1'), pid = await patient(d);
  const [p] = await stage(d, cond({ onsetDateTime: '2020-05-01' }));
  const r = await toPatient(d, p, pid);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const q = r.body.problem;
  assert.deepEqual([q.patient_id, q.label, q.onset_date, q.status, q.recorded_by, q.origin_case_id], [pid, p.fields.label, '2020-05-01', 'active', 'doctor1', null]);
  const pr = r.body.proposal;
  assert.deepEqual([pr.status, pr.row_version, pr.accepted_patient_id, pr.accepted_record_type, pr.accepted_record_id], ['accepted', 2, pid, 'problem', q.id]);
  assert.equal(await num('SELECT count(*) n FROM patient_problem_events e JOIN users u ON u.id = e.by_user WHERE e.problem_id = $1 AND e.seq = 1 AND e.to_status = $2 AND u.username = $3', [q.id, 'active', 'doctor1']), 1);
  assert.equal((await env.pool.query('SELECT u.username FROM patient_problems r JOIN users u ON u.id = r.recorded_by WHERE r.id = $1', [q.id])).rows[0].username, 'doctor1', 'the stored recorder is the session user');
  const aud = (await env.pool.query(`SELECT action, detail FROM audit_log WHERE action IN ('import.proposal_accept','problem.add') ORDER BY id DESC LIMIT 2`)).rows;
  assert.deepEqual(aud.map(a => a.action).sort(), ['import.proposal_accept', 'problem.add']);
  assert.ok(!JSON.stringify(aud).includes(SECRET), 'audit rows hold ids and lengths, never labels');
  const got = await d.get(`/api/patients/${pid}/problems`); assert.equal(got.body.problems.length, 1, 'the normal list shows it');
});

test('accept an AllergyIntolerance: reaction and severity are carried; an origin case of the same patient is allowed', async () => {
  const d = await as('doctor1'), pid = await patient(d), kid = await caseOf(d, pid);
  const [p] = await stage(d, alg({ reaction: [{ manifestation: [{ text: 'Rash' }], severity: 'moderate' }] }));
  const r = await toPatient(d, p, pid, { originCaseId: kid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.allergy;
  assert.deepEqual([a.patient_id, a.substance, a.reaction, a.severity, a.status, a.recorded_by, a.origin_case_id], [pid, p.fields.substance, 'Rash', 'moderate', 'active', 'doctor1', kid]);
  assert.deepEqual([r.body.proposal.accepted_record_type, r.body.proposal.accepted_record_id], ['allergy', a.id]);
  assert.equal(await num('SELECT count(*) n FROM patient_allergy_events WHERE allergy_id = $1 AND seq = 1', [a.id]), 1);
  assert.equal((await env.pool.query('SELECT u.username FROM patient_allergies r JOIN users u ON u.id = r.recorded_by WHERE r.id = $1', [a.id])).rows[0].username, 'doctor1', 'the stored recorder is the session user');
});

test('accept: who may; the body cannot name an actor or content; the patient must be named by the person', async () => {
  const d = await as('doctor1'), pid = await patient(d);
  const [a, b] = await stage(d, cond(), alg());
  for (const u of ['nurse1', 'viewer1', 'informatician1']) { const r = await toPatient(await as(u), a, pid); assert.equal(r.status, 403, u); assert.equal(r.body.perm, 'import:write'); }
  assert.equal((await toPatient(client(env.base), a, pid)).status, 401);
  for (const extra of [{ recordedBy: 'mallory' }, { userId: 1 }, { label: 'x' }, { substance: 'x' }, { status: 'resolved' }, { onsetDate: '2020-01-01' }]) {
    const r = await toPatient(d, a, pid, extra); assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.error, 'unknown_field');
  }
  for (const body of [{ rowVersion: 1 }, { patientId: pid }, { rowVersion: 1, patientId: 'x' }, { rowVersion: 1, patientId: pid, originCaseId: 'x' }]) assert.equal((await d.post(`/api/import/proposals/${a.id}/accept-to-patient`, body)).status, 400, JSON.stringify(body));
  assert.equal(await num('SELECT count(*) n FROM patient_problems WHERE patient_id = $1', [pid]) + await num('SELECT count(*) n FROM patient_allergies WHERE patient_id = $1', [pid]), 0, 'refused callers record nothing');
  assert.equal((await toPatient(await as('admin1'), b, pid)).status, 200, 'admin may');
});

test('accept: a MedicationRequest is never accepted, by either route; an Observation or a problem goes only to its own route', async () => {
  const d = await as('doctor1'), pid = await patient(d), cid = await caseOf(d, pid);
  const [med, obs, con] = await stage(d, medreq(), observ(), cond());
  let r = await toPatient(d, med, pid); assert.deepEqual([r.status, r.body.error], [409, 'never_acceptable']);
  r = await d.post(`/api/import/proposals/${med.id}/accept`, { rowVersion: 1, caseId: cid, appliedSetId: 1, fieldKey: 'hr' }); assert.deepEqual([r.status, r.body.error], [409, 'never_acceptable']);
  r = await toPatient(d, obs, pid); assert.deepEqual([r.status, r.body.error], [409, 'not_accepted_here']);
  r = await d.post(`/api/import/proposals/${con.id}/accept`, { rowVersion: 1, caseId: cid, appliedSetId: 1, fieldKey: 'hr' }); assert.deepEqual([r.status, r.body.error], [409, 'not_accepted_here']);
  assert.equal(await num(`SELECT count(*) n FROM import_proposals WHERE id = ANY($1) AND status = 'accepted'`, [[med.id, obs.id, con.id]]), 0);
  assert.equal(await num('SELECT count(*) n FROM medication_orders'), 0, 'no order exists');
});

test('accept: blockers, rejected, stale and unknown proposals are refused; a bad patient or case is refused; nothing is recorded', async () => {
  const d = await as('doctor1'), pid = await patient(d), other = await patient(d), othersCase = await caseOf(d, other), gone = await patient(d);
  const [blocked, rej, stale, ok, fut, longAl] = await stage(d, { resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] } } }, cond(), cond(), cond(), cond({ onsetDateTime: '2999-01-01' }), alg());
  let r = await toPatient(d, blocked, pid); assert.deepEqual([r.status, r.body.error], [409, 'blocked']); assert.ok(r.body.blockers.length >= 1);
  assert.equal((await d.post(`/api/import/proposals/${rej.id}/reject`, { reason: 'No', rowVersion: 1 })).status, 200);
  r = await toPatient(d, rej, pid, { rowVersion: 2 }); assert.deepEqual([r.status, r.body.error], [409, 'proposal_final']);
  r = await toPatient(d, stale, pid, { rowVersion: 9 }); assert.deepEqual([r.status, r.body.error, r.body.currentRowVersion], [409, 'version_conflict', 1]);
  assert.equal((await d.post('/api/import/proposals/999999/accept-to-patient', { rowVersion: 1, patientId: pid })).status, 404);
  r = await toPatient(d, ok, 999999); assert.deepEqual([r.status, r.body.error], [404, 'patient_not_found']);
  r = await toPatient(d, ok, pid, { originCaseId: othersCase }); assert.deepEqual([r.status, r.body.error], [400, 'case_not_of_patient']);
  assert.equal((await d.patch(`/api/patients/${gone}/archive`, { archived: true })).status, 200);
  r = await toPatient(d, ok, gone); assert.deepEqual([r.status, r.body.error], [409, 'patient_archived']);
  r = await toPatient(d, fut, pid); assert.deepEqual([r.status, r.body.error], [400, 'invalid'], 'a future onset date is refused like normal entry');
  assert.equal(await num('SELECT count(*) n FROM patient_problems WHERE patient_id = ANY($1)', [[pid, other, gone]]), 0);
  assert.equal(await num(`SELECT count(*) n FROM import_proposals WHERE status = 'staged' AND id = ANY($1)`, [[blocked.id, stale.id, ok.id, fut.id, longAl.id]]), 5, 'every refusal leaves the proposal staged');
});

test('accept: twice is refused (one proposal, one record), also when two requests arrive together; another patient is untouched', async () => {
  const d = await as('doctor1'), d2 = await as('doctor1'), pid = await patient(d), other = await patient(d);
  const [a, b] = await stage(d, cond(), alg());
  assert.equal((await toPatient(d, a, pid)).status, 200);
  const again = await toPatient(d, a, pid, { rowVersion: 2 }); assert.deepEqual([again.status, again.body.error], [409, 'proposal_final']);
  assert.equal((await toPatient(d, a, other, { rowVersion: 2 })).status, 409, 'not into a second chart either');
  const both = await Promise.all([toPatient(d, b, pid), toPatient(d2, b, pid)]);
  assert.deepEqual(both.map(x => x.status).sort(), [200, 409], JSON.stringify(both.map(x => x.body)));
  assert.equal(await num('SELECT count(*) n FROM patient_problems WHERE patient_id = $1', [pid]), 1);
  assert.equal(await num('SELECT count(*) n FROM patient_allergies WHERE patient_id = $1', [pid]), 1, 'exactly one record per proposal');
  assert.equal(await num('SELECT (SELECT count(*) FROM patient_problems WHERE patient_id = $1) + (SELECT count(*) FROM patient_allergies WHERE patient_id = $1) n', [other]), 0);
});
