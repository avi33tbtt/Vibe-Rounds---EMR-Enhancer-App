'use strict';
// Task R6f-2b: accept ONE ready Observation proposal into a chart a person chooses. Matrix and audit scenarios are in safety-routes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, seq = 0;
test.before(async () => { env = await setup(); R = await reviewers(env.base); admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const num = async (sql, args = []) => Number((await env.pool.query(sql, args)).rows[0].n);
const SECRET_LABEL = 'Zebra pulse secret label';
const DEF = { title: 'Accept set', fields: [
  { id: 'hr', label: 'Heart rate', type: 'number', unit: 'bpm' }, { id: 'rr', label: 'Resp rate', type: 'integer', unit: '/min' },
  { id: 'alert', label: 'Alert', type: 'boolean' }, { id: 'avpu', label: 'AVPU', type: 'select', options: ['Alert', 'Voice'] },
  { id: 'comment', label: 'Comment', type: 'text' }, { id: 'seen', label: 'Seen at', type: 'datetime' }, { id: 'plain', label: 'Plain number', type: 'number' }] };

async function publishedSet() {
  const made = await R.doctor.post('/api/element-sets', { slug: 'acc-set-' + (++seq), kind: 'custom', definition: DEF });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return made.body.set.id;
}
// A patient with a case and the set applied; returns the ids a person would choose.
async function chart(c, setId) {
  const p = await c.post('/api/patients', { name: 'Accept Patient ' + (++seq), mrn: 'ACC-' + seq, dob: '1980-01-01', sex: 'F' });
  assert.equal(p.status, 201);
  const k = await c.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Accept case' });
  const a = await c.post(`/api/cases/${k.body.case.id}/applied-sets`, { setId, version: 1 });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  return { patientId: p.body.patient.id, caseId: k.body.case.id, asid: a.body.appliedSet.id };
}
const obs = (value, o = {}) => ({ resource: { resourceType: 'Observation', status: 'final', code: { text: SECRET_LABEL + ' ' + (++seq) }, ...(value === undefined ? {} : value), effectiveDateTime: '2026-11-20T09:30:00Z', ...o } });
// Stage a bundle of the given entries; returns the proposals in order.
async function stage(c, ...entries) {
  const r = await c.post('/api/import/bundles', { resourceType: 'Bundle', type: 'collection', entry: entries });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.bundle.proposals;
}
const accept = (c, p, ch, key, extra = {}) => c.post(`/api/import/proposals/${p.id}/accept`, { rowVersion: p.row_version, caseId: ch.caseId, appliedSetId: ch.asid, fieldKey: key, ...extra });

test('accept: the record is made in the chosen chart; recorder is the session user; preliminary; imported; one proposal is marked accepted', async () => {
  const d = await as('doctor1'), set = await publishedSet(), ch = await chart(d, set);
  const [p] = await stage(d, obs({ valueQuantity: { value: 88, unit: 'bpm' } }));
  assert.equal(p.ready, true);
  const r = await accept(d, p, ch, 'hr');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = r.body.observation;
  assert.deepEqual([o.case_id, o.applied_set_id, o.field_key, o.value_type, o.value, o.unit_display, o.status, o.source_type, o.recorded_by], [ch.caseId, ch.asid, 'hr', 'number', 88, 'bpm', 'preliminary', 'imported', 'doctor1']);
  assert.equal(new Date(o.effective_at).toISOString(), '2026-11-20T09:30:00.000Z');
  assert.match(o.source_ref, /^import:\d+\/Observation#\d+$/);
  assert.ok(!JSON.stringify(o).includes(SECRET_LABEL), 'the imported label is not copied into the record');
  const pr = r.body.proposal;
  assert.deepEqual([pr.status, pr.row_version, pr.accepted_patient_id, pr.accepted_record_type, pr.accepted_record_id], ['accepted', 2, ch.patientId, 'observation', o.id]);
  const row = (await env.pool.query(`SELECT accepted_by, (SELECT username FROM users WHERE id = accepted_by) u FROM import_proposals WHERE id = $1`, [p.id])).rows[0];
  assert.equal(row.u, 'doctor1');
  assert.equal(await num(`SELECT count(*) n FROM clinical_events WHERE case_id = $1 AND event_type = 'observation_recorded'`, [ch.caseId]), 1);
  const aud = (await env.pool.query(`SELECT action, detail FROM audit_log WHERE action IN ('import.proposal_accept','observation.record') ORDER BY id DESC LIMIT 2`)).rows;
  assert.deepEqual(aud.map(a => a.action).sort(), ['import.proposal_accept', 'observation.record']);
  assert.ok(!JSON.stringify(aud).includes(SECRET_LABEL) && !JSON.stringify(aud).includes('88'), 'audit rows hold ids and counts, never labels or values');
});

test('accept: each value type is checked like normal entry; unknown fits any field; a whole number fits a number field; a quantity fits an integer field only if whole', async () => {
  const d = await as('doctor1'), set = await publishedSet(), ch = await chart(d, set);
  const ps = await stage(d, obs({ valueQuantity: { value: 18, unit: '/min' } }), obs({ valueBoolean: true }), obs({ valueString: 'Voice' }), obs({ valueString: 'free text' }), obs({ valueDateTime: '2026-11-20T08:00:00+05:45' }), obs({ dataAbsentReason: { coding: [{ code: 'unknown' }] } }), obs({ valueInteger: 5 }));
  const t = [['rr', 18, '/min'], ['alert', true, null], ['avpu', 'Voice', null], ['comment', 'free text', null], ['seen', '2026-11-20T08:00:00+05:45', null], ['hr', null, null], ['plain', 5, null]];
  for (let i = 0; i < ps.length; i++) {
    const r = await accept(d, ps[i], ch, t[i][0]);
    assert.equal(r.status, 200, t[i][0] + ' ' + JSON.stringify(r.body));
    assert.deepEqual([r.body.observation.value, r.body.observation.unit_display], [t[i][1], t[i][2]], t[i][0]);
  }
  assert.equal(await num(`SELECT count(*) n FROM observations WHERE case_id = $1 AND value_type = 'unknown'`, [ch.caseId]), 1);
});

test('accept: who may; the body cannot name an actor; the chart, set and field must be named by the person', async () => {
  const d = await as('doctor1'), set = await publishedSet(), ch = await chart(d, set);
  const ps = await stage(d, obs({ valueQuantity: { value: 70, unit: 'bpm' } }), obs({ valueQuantity: { value: 71, unit: 'bpm' } }));
  for (const u of ['nurse1', 'viewer1', 'informatician1']) { const r = await accept(await as(u), ps[0], ch, 'hr'); assert.equal(r.status, 403, u); assert.equal(r.body.perm, 'import:write'); }
  assert.equal((await accept(client(env.base), ps[0], ch, 'hr')).status, 401);
  assert.equal(await num('SELECT count(*) n FROM observations WHERE case_id = $1', [ch.caseId]), 0, 'refused callers record nothing');
  for (const extra of [{ recordedBy: 'mallory' }, { userId: 1 }, { status: 'final' }, { sourceType: 'clinician' }, { value: 1 }, { effectiveAt: '2026-01-01T00:00:00Z' }, { patientId: 1 }]) {
    const r = await accept(d, ps[0], ch, 'hr', extra); assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.error, 'unknown_field');
  }
  for (const [k, v] of [['caseId', undefined], ['appliedSetId', undefined], ['fieldKey', undefined], ['rowVersion', undefined], ['caseId', 'x'], ['fieldKey', 'bad key!']]) {
    const body = { rowVersion: 1, caseId: ch.caseId, appliedSetId: ch.asid, fieldKey: 'hr' }; if (v === undefined) delete body[k]; else body[k] = v;
    assert.equal((await d.post(`/api/import/proposals/${ps[0].id}/accept`, body)).status, 400, k + ' ' + v);
  }
  assert.equal((await accept(await as('admin1'), ps[1], ch, 'hr')).status, 200, 'admin may');
  assert.equal(await num('SELECT count(*) n FROM observations WHERE case_id = $1', [ch.caseId]), 1);
});

test('accept: blockers, medication requests and other kinds are refused; rejected and stale proposals too; nothing is recorded', async () => {
  const d = await as('doctor1'), set = await publishedSet(), ch = await chart(d, set);
  const ps = await stage(d,
    obs({ valueQuantity: { value: 1, unit: 'bpm' } }, { effectiveDateTime: '2026-11-20' }),
    { resource: { resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: 'Drug' }, dosageInstruction: [{ text: 'as typed' }] } },
    { resource: { resourceType: 'Condition', code: { text: 'Cond' }, clinicalStatus: { coding: [{ code: 'active' }] } } },
    obs({ valueQuantity: { value: 2, unit: 'bpm' } }), obs({ valueQuantity: { value: 3, unit: 'bpm' } }));
  const [blocked, med, cond, rej, stale] = ps;
  let r = await accept(d, blocked, ch, 'hr'); assert.deepEqual([r.status, r.body.error], [409, 'blocked']); assert.ok(r.body.blockers.length >= 1);
  r = await accept(d, med, ch, 'hr'); assert.deepEqual([r.status, r.body.error], [409, 'never_acceptable']);
  r = await accept(d, cond, ch, 'hr'); assert.deepEqual([r.status, r.body.error], [409, 'not_accepted_here']);
  assert.equal((await d.post(`/api/import/proposals/${rej.id}/reject`, { reason: 'No', rowVersion: 1 })).status, 200);
  r = await accept(d, rej, ch, 'hr', { rowVersion: 2 }); assert.deepEqual([r.status, r.body.error], [409, 'proposal_final']);
  r = await accept(d, stale, ch, 'hr', { rowVersion: 9 }); assert.deepEqual([r.status, r.body.error, r.body.currentRowVersion], [409, 'version_conflict', 1]);
  assert.equal((await d.post('/api/import/proposals/999999/accept', { rowVersion: 1, caseId: ch.caseId, appliedSetId: ch.asid, fieldKey: 'hr' })).status, 404);
  assert.equal(await num('SELECT count(*) n FROM observations WHERE case_id = $1', [ch.caseId]), 0);
  assert.equal(await num(`SELECT count(*) n FROM import_proposals WHERE id = ANY($1) AND status = 'accepted'`, [[blocked.id, med.id, cond.id, rej.id, stale.id]]), 0);
});

test('accept: twice is refused (one proposal, one record), also when two requests arrive together', async () => {
  const d = await as('doctor1'), d2 = await as('doctor1'), set = await publishedSet(), ch = await chart(d, set);
  const [a, b] = await stage(d, obs({ valueQuantity: { value: 60, unit: 'bpm' } }), obs({ valueQuantity: { value: 61, unit: 'bpm' } }));
  assert.equal((await accept(d, a, ch, 'hr')).status, 200);
  const again = await accept(d, a, ch, 'hr', { rowVersion: 2 }); assert.deepEqual([again.status, again.body.error], [409, 'proposal_final']);
  const both = await Promise.all([accept(d, b, ch, 'hr'), accept(d2, b, ch, 'hr')]);
  assert.deepEqual(both.map(x => x.status).sort(), [200, 409], JSON.stringify(both.map(x => x.body)));
  assert.equal(await num('SELECT count(*) n FROM observations WHERE case_id = $1', [ch.caseId]), 2, 'exactly one record per proposal');
});

test('accept: the chart rules hold: unknown or archived case, set of another chart, withdrawn set, unknown field', async () => {
  const d = await as('doctor1'), set = await publishedSet(), ch = await chart(d, set), other = await chart(d, set);
  const ps = await stage(d, ...[1, 2, 3, 4, 5, 6].map(n => obs({ valueQuantity: { value: n, unit: 'bpm' } })));
  let r = await accept(d, ps[0], ch, 'hr', { caseId: 999999 }); assert.deepEqual([r.status, r.body.error], [404, 'case_not_found']);
  r = await accept(d, ps[0], ch, 'hr', { appliedSetId: other.asid }); assert.deepEqual([r.status, r.body.error], [404, 'applied_set_not_found']);
  r = await accept(d, ps[0], ch, 'nope'); assert.deepEqual([r.status, r.body.error], [400, 'unknown_field_key']);
  assert.equal((await d.post(`/api/cases/${ch.caseId}/applied-sets/${ch.asid}/withdraw`, {})).status, 200);
  r = await accept(d, ps[0], ch, 'hr'); assert.deepEqual([r.status, r.body.error], [409, 'set_not_active']);
  assert.equal((await d.patch(`/api/cases/${other.caseId}/archive`, { archived: true, rowVersion: 1 })).status, 200);
  r = await accept(d, ps[0], other, 'hr'); assert.deepEqual([r.status, r.body.error], [409, 'case_archived']);
  assert.equal(await num('SELECT count(*) n FROM observations WHERE case_id = ANY($1)', [[ch.caseId, other.caseId]]), 0);
  assert.equal(await num(`SELECT count(*) n FROM import_proposals WHERE status <> 'staged' AND id = ANY($1)`, [ps.map(p => p.id)]), 0, 'every refusal leaves the proposal staged');
});

test('accept: values never fit by guessing: wrong type, other or missing unit, unit on a unitless field, future time', async () => {
  const d = await as('doctor1'), set = await publishedSet(), ch = await chart(d, set), future = new Date(Date.now() + 86400000).toISOString();
  const ps = await stage(d, obs({ valueString: '88' }), obs({ valueQuantity: { value: 88, unit: 'mmol/L' } }), obs({ valueQuantity: { value: 88 } }), obs({ valueQuantity: { value: 5, unit: 'kg' } }),
    obs({ valueQuantity: { value: 88, unit: 'bpm' } }, { effectiveDateTime: future }), obs({ valueBoolean: true }));
  let r = await accept(d, ps[0], ch, 'hr'); assert.deepEqual([r.status, r.body.error], [400, 'value_does_not_fit']);
  r = await accept(d, ps[1], ch, 'hr'); assert.deepEqual([r.status, r.body.error], [400, 'invalid_unit']);
  r = await accept(d, ps[2], ch, 'hr'); assert.deepEqual([r.status, r.body.error], [400, 'invalid_unit']);
  r = await accept(d, ps[3], ch, 'plain'); assert.deepEqual([r.status, r.body.error], [400, 'invalid_unit']);
  r = await accept(d, ps[4], ch, 'hr'); assert.deepEqual([r.status, r.body.error], [409, 'effective_in_future']);
  r = await accept(d, ps[5], ch, 'comment'); assert.deepEqual([r.status, r.body.error], [400, 'value_does_not_fit']);
  const [frac] = await stage(d, obs({ valueQuantity: { value: 18.5, unit: '/min' } }));
  r = await accept(d, frac, ch, 'rr'); assert.deepEqual([r.status, r.body.error], [400, 'invalid_value'], 'a fraction is not cut to fit an integer field');
  assert.equal(await num('SELECT count(*) n FROM observations WHERE case_id = $1', [ch.caseId]), 0);
});

test('accept: the chart is the only link; another chart is untouched; the proposal keeps no patient until accepted; the staged data is unchanged', async () => {
  const d = await as('doctor1'), set = await publishedSet(), a = await chart(d, set), b = await chart(d, set);
  const [p] = await stage(d, obs({ valueQuantity: { value: 99, unit: 'bpm' } }));
  assert.equal((await env.pool.query('SELECT accepted_patient_id FROM import_proposals WHERE id = $1', [p.id])).rows[0].accepted_patient_id, null);
  const before = (await env.pool.query('SELECT fields, blockers, key, kind FROM import_proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal((await accept(d, p, a, 'hr')).status, 200);
  assert.equal(await num('SELECT count(*) n FROM observations WHERE case_id = $1', [b.caseId]), 0);
  assert.deepEqual((await env.pool.query('SELECT fields, blockers, key, kind FROM import_proposals WHERE id = $1', [p.id])).rows[0], before, 'what was staged is never rewritten');
  assert.equal((await env.pool.query('SELECT accepted_patient_id FROM import_proposals WHERE id = $1', [p.id])).rows[0].accepted_patient_id, a.patientId);
});
