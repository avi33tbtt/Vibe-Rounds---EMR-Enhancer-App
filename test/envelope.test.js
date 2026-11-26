'use strict';
// Task B5a-1: envelope.js against the vendored CCIS schema (contracts/). Pure: no database, no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { buildEnvelope, EnvelopeError } = require('../envelope');

const C = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', f), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(C('manifest.schema.json'));
const validate = ajv.compile(C('context-envelope.schema.json'));
const ok = env => { assert.equal(validate(env), true, JSON.stringify(validate.errors, null, 1)); };

const SECRET = 'test-secret-test-secret-test-secret-1234';
const NAME = 'Zelda Hargrove', MRN = 'CTX-90817', NARR = 'Narrative about the snakebite at the paddy field', FREE = 'Her sister Quentin brought her in', USER = 'doctor_zelda';
const DEF = { title: 'Vitals', fields: [
  { id: 'hr', type: 'number', unit: 'bpm' }, { id: 'rr', type: 'integer' }, { id: 'count', type: 'number' }, { id: 'alert', type: 'boolean' },
  { id: 'avpu', type: 'select' }, { id: 'comment', type: 'text' }, { id: 'when', type: 'datetime' }, { id: 'adm_cc', type: 'number', unit: 'mmol/L' } ] };
const caseRow = { id: 41, patient_name: NAME, mrn: MRN, title: 'Hargrove case', narrative: NARR };   // extra fields must never reach the output
const sets = [{ id: 7, slug: 'vitals_set', version: 2, definition_json: DEF, state: 'active' }, { id: 6, slug: 'vitals_set', version: 1, definition_json: DEF, state: 'superseded' }];
const pathways = [{ id: 3, slug: 'opd-basic', version: 1 }];
let n = 0;
const row = o => ({ id: ++n, applied_set_id: 7, field_key: 'hr', value_type: 'number', value_json: 88, unit_display: 'bpm', effective_at: '2026-11-23T07:30:00.000Z', recorded_at: '2026-11-23T07:31:00.000Z',
  source_type: 'clinician', status: 'final', corrects_id: null, recorded_role: 'doctor', ...o });
function input(extra = {}) {
  n = 0;
  const obs = [
    row({}),                                                                                       // 1 hr 88 (later corrected)
    row({ field_key: 'rr', value_type: 'integer', value_json: 18, unit_display: '/min' }),         // 2
    row({ field_key: 'count', value_json: 3, unit_display: null }),                                // 3 unitless: withheld
    row({ field_key: 'alert', value_type: 'boolean', value_json: false, unit_display: null }),     // 4 false stays false
    row({ field_key: 'avpu', value_type: 'unknown', value_json: null, unit_display: null }),       // 5 unknown
    row({ field_key: 'comment', value_type: 'text', value_json: FREE, unit_display: null }),       // 6 free text: withheld
    row({ field_key: 'hr', value_json: 777, status: 'entered_in_error' }),                         // 7 excluded
    row({ field_key: 'hr', value_json: 86, status: 'amended', corrects_id: 1 }),                   // 8 corrects 1
    row({ field_key: 'hr', value_json: 90, source_type: 'ai_proposed', status: 'preliminary' }),   // 9
    row({ field_key: 'rr', value_type: 'integer', value_json: 20, source_type: 'derived', unit_display: '/min' }),   // 10 derived: withheld
    row({ field_key: 'when', value_type: 'datetime', value_json: '2026-11-23T05:00', unit_display: null }),          // 11 zone unknown
    row({ field_key: 'adm_cc', value_json: 4.5, unit_display: 'mmol/L' }),                         // 12
    ...(extra.obs || []),
  ];
  return { caseRow, pins: { sets, pathways }, observations: obs, events: [{ id: 1, event_type: 'set_applied', detail: { x: NAME } }, { id: 2, event_type: 'observation_recorded' }],
    exportedAt: new Date('2026-11-23T08:00:00.000Z'), producerVersion: '0.1.0', refSecret: SECRET };
}
const rule = (items, id) => items.find(i => i.id === id);

test('a rich case validates against the vendored CCIS schema', () => { ok(buildEnvelope(input())); });

test('identity, narrative, free text, usernames and case title are absent from the bytes', () => {
  const bytes = JSON.stringify(buildEnvelope(input()));
  for (const s of [NAME, 'Hargrove', MRN, NARR, FREE, 'Quentin', USER, 'Hargrove case', 'paddy']) assert.equal(bytes.includes(s), false, s);
  assert.equal(/"patient_name"|"mrn"|"title"|"body"/.test(bytes), false);
  const e = buildEnvelope(input());
  assert.deepEqual(e.inclusions, { identity: false, narrative: false, enteredInError: false });
  assert.equal(e['x-emr'].withheld.narrativeObservations, 1);
  assert.match(e.case.ref, /^cx_[0-9a-f]{32}$/); assert.notEqual(e.case.ref, 'cx_41');
});

test('same input gives identical bytes, whatever order the rows arrive in; the ref changes with the secret', () => {
  const a = input(), b = input();
  b.observations.reverse(); b.pins = { sets: sets.slice().reverse(), pathways };
  assert.equal(JSON.stringify(buildEnvelope(a)), JSON.stringify(buildEnvelope(input())));
  assert.equal(JSON.stringify(buildEnvelope(b)), JSON.stringify(buildEnvelope(a)));
  const c = input(); c.refSecret = 'another-secret-another-secret-another-1';
  assert.notEqual(buildEnvelope(c).case.ref, buildEnvelope(a).case.ref);
  assert.throws(() => buildEnvelope({ ...a, refSecret: 'short' }), EnvelopeError);
});

test('the data states stay distinct: unknown has no value and is never false; false stays false; absent is no row', () => {
  const e = buildEnvelope(input()), o = e.observations;
  const unk = o.find(x => x.concept.id === 'vitals-set.avpu');
  assert.equal(unk.state, 'unknown'); assert.equal('value' in unk, false); assert.equal(unk.kind, 'string');
  const f = o.find(x => x.concept.id === 'vitals-set.alert');
  assert.equal(f.value, false); assert.equal('state' in f, false);
  assert.equal(o.some(x => x.concept.id === 'vitals-set.comment'), false);
  assert.equal(o.some(x => x.value === 777), false);                           // entered in error: excluded, not relabelled
  assert.equal(JSON.stringify(e).includes('entered-in-error'), false);
  assert.equal(e['x-emr'].withheld.enteredInErrorObservations, 1);
  ok(e);
});

test('numbers keep their unit; a unitless number is withheld and declared, never given a made-up unit', () => {
  const e = buildEnvelope(input()), o = e.observations;
  const hr = o.find(x => x.value === 88); assert.equal(hr.kind, 'quantity'); assert.equal(hr.unit, 'bpm');
  assert.equal(o.find(x => x.value === 18).kind, 'integer');
  assert.equal(o.some(x => x.concept.id === 'vitals-set.count'), false);
  assert.equal(e['x-emr'].withheld.unitlessNumbers, 1);
  assert.equal(o.find(x => x.concept.id === 'vitals-set.adm-cc').unit, 'mmol/L');   // underscore id maps to a canonical id
});

test('times state their zone; a datetime value without an offset says its zone is unknown; recorded is its own time', () => {
  const o = buildEnvelope(input()).observations;
  const hr = o.find(x => x.value === 88);
  assert.deepEqual(hr.effective, { value: '2026-11-23T07:30:00.000Z', zone: 'stated' });
  assert.deepEqual(hr.recorded, { value: '2026-11-23T07:31:00.000Z', zone: 'stated' });
  assert.deepEqual(o.find(x => x.concept.id === 'vitals-set.when').value, { value: '2026-11-23T05:00', zone: 'unknown' });
});

test('corrections, source classes, derived rows and ai-proposed rows', () => {
  const e = buildEnvelope(input()), o = e.observations;
  const fixed = o.find(x => x.value === 86), orig = o.find(x => x.value === 88);
  assert.equal(fixed.status, 'corrected'); assert.equal(fixed.correctionOf, orig.id); assert.equal(orig.provenance.corrected, true);
  const ai = o.find(x => x.value === 90); assert.equal(ai.sourceClass, 'ai-proposed'); assert.equal(ai.status, 'preliminary'); assert.equal(ai.provenance.verified, false);
  assert.equal(o.some(x => x.sourceClass === 'derived'), false); assert.equal(e['x-emr'].withheld.derivedObservations, 1);
  ok(e);
});

test('a correction whose original is withheld carries no dangling reference and is counted', () => {
  const i = input({ obs: [row({ field_key: 'rr', value_type: 'integer', value_json: 19, unit_display: '/min', status: 'amended', corrects_id: 3 })] });   // corrects the unitless row 3
  const e = buildEnvelope(i);
  const fixed = e.observations.find(x => x.value === 19);
  assert.equal('correctionOf' in fixed, false); assert.equal(e['x-emr'].withheld.correctionTargetsWithheld, 1); ok(e);
});

test('applied versions are listed exactly: active sets and pathways, versions as semver, no newest-version guess', () => {
  const e = buildEnvelope(input());
  assert.deepEqual(e.applied.elements, [{ id: 'vitals-set', type: 'contextual-element', version: '2.0.0' }]);
  assert.deepEqual(e.applied.pathways, [{ id: 'opd-basic', type: 'pathway', version: '1.0.0' }]);
  assert.deepEqual(e.events, []); assert.equal(e['x-emr'].withheld.events, 2);
  assert.equal(JSON.stringify(e).includes('set_applied'), false);
});

test('two keys that map to the same id are refused; a case with no observations still validates', () => {
  const i = input(); i.pins = { sets: [{ ...sets[0] }, { id: 9, slug: 'vitals-set', version: 1, definition_json: DEF, state: 'active' }], pathways };
  assert.throws(() => buildEnvelope(i), EnvelopeError);
  const empty = { ...input(), observations: [], events: [] };
  ok(buildEnvelope(empty));
});

test('the schema really is closed: an identity field added to a valid envelope is rejected', () => {
  const e = buildEnvelope(input()); e.case.name = NAME;
  assert.equal(validate(e), false);
});

// ---- R3i: problems and allergies (envelope 0.2.0) ----
const PL = 'Hypertension in Zelda Hargrove', SUB = 'Penicillin for Zelda', REACT = 'Rash and Quentin saw it';
const prob = o => ({ id: 1, status: 'active', onset_date: '2019-05-04', recorded_at: '2026-11-20T09:00:00.000Z', recorded_role: 'doctor', label: PL, ...o });
const alg = o => ({ id: 1, status: 'active', onset_date: null, recorded_at: '2026-11-21T09:00:00.000Z', recorded_role: 'nurse', substance: SUB, reaction: REACT, severity: 'severe', ...o });

test('R3i: problems and allergies validate against the 0.2.0 schema; no text travels; ids are stable ranks', () => {
  const e = buildEnvelope({ ...input(), problems: [prob({ id: 5 }), prob({ id: 3, status: 'resolved', onset_date: null })], allergies: [alg({})] }); ok(e);
  assert.equal(e.envelope.version, '0.2.0');
  assert.deepEqual(e.problems.map(p => [p.id, p.lifecycle]), [['pr-1', 'resolved'], ['pr-2', 'active']], 'sorted by row id, rank among all rows');
  assert.deepEqual(e.allergies.map(p => p.id), ['al-1']);
  const p2 = e.problems[1];
  assert.deepEqual(p2.concept, { id: 'unclassified', codes: [] });
  assert.deepEqual(p2.effective, { value: '2019-05-04T00:00', zone: 'unknown' }, 'a date has no zone: said so');
  assert.equal('effective' in e.problems[0], false, 'unknown onset is left out, not invented');
  assert.equal('period' in e.problems[0], false, 'the recording of a resolution is not the end of the condition');
  assert.deepEqual([p2.status, p2.sourceClass, p2.provenance], ['final', 'clinician-entered', { roleClass: 'doctor', origin: 'emr-enhancer/problem-list', verified: false, corrected: false }]);
  assert.equal(e.allergies[0].provenance.roleClass, 'nurse');
  const bytes = JSON.stringify(e);
  for (const t of [PL, SUB, REACT, 'severe', 'Hargrove', 'Quentin']) assert.equal(bytes.includes(t), false, t + ' must not travel');
});

test('R3i: entered-in-error rows are never sent, only counted; the version follows what is sent', () => {
  const e = buildEnvelope({ ...input(), problems: [prob({ id: 1, status: 'entered_in_error' }), prob({ id: 2 })], allergies: [alg({ id: 1, status: 'entered_in_error' })] }); ok(e);
  assert.deepEqual(e.problems.map(p => p.id), ['pr-2'], 'the id keeps its rank, so a withheld row leaves a gap, not a shift');
  assert.equal('allergies' in e, false, 'all allergies in error: no section at all');
  assert.equal(e.envelope.version, '0.2.0');
  assert.deepEqual([e['x-emr'].withheld.enteredInErrorProblems, e['x-emr'].withheld.unclassifiedProblems, e['x-emr'].withheld.enteredInErrorAllergies, e['x-emr'].withheld.unclassifiedAllergies], [1, 1, 1, 0]);
  const none = buildEnvelope({ ...input(), allergies: [alg({ status: 'entered_in_error' })] }); ok(none);
  assert.equal(none.envelope.version, '0.1.0', 'nothing sent: the envelope is a plain 0.1.0');
});

test('R3i: no rows means no section and nothing else changes (an empty list never says "no known allergies")', () => {
  const plain = buildEnvelope(input()), none = buildEnvelope({ ...input(), problems: [], allergies: [] }); ok(none);
  assert.deepEqual(none, plain);
  assert.equal(none.envelope.version, '0.1.0');
  for (const k of ['problems', 'allergies']) assert.equal(k in none, false);
  assert.equal('enteredInErrorProblems' in none['x-emr'].withheld, false, 'the existing withheld object keeps its exact shape');
});

test('R3i: unknown status or a non-date onset is refused, never guessed', () => {
  assert.throws(() => buildEnvelope({ ...input(), problems: [prob({ status: 'maybe' })] }), EnvelopeError);
  assert.throws(() => buildEnvelope({ ...input(), allergies: [alg({ onset_date: new Date('2019-05-04') })] }), EnvelopeError);
  assert.throws(() => buildEnvelope({ ...input(), problems: [prob({ onset_date: '04/05/2019' })] }), EnvelopeError);
});

test('R3i: the 0.2.0 schema refuses a text member on an item, and a section under version 0.1.0', () => {
  const e = buildEnvelope({ ...input(), problems: [prob({})] });
  const bad = structuredClone(e); bad.problems[0].label = PL; assert.equal(validate(bad), false);
  const old = structuredClone(e); old.envelope.version = '0.1.0'; assert.equal(validate(old), false);
});

// ---- R4j: orders and results (envelope 0.2.0) ----
const DRUG = 'Amoxicillin for Zelda Hargrove', DOSE = '500 mg twice daily for Quentin', TESTN = 'Serum potassium for Zelda', INFO = 'Query hyperkalaemia, Hargrove';
const ord = o => ({ id: 1, status: 'active', onset_date: null, recorded_at: '2026-11-22T09:00:00.000Z', recorded_role: 'doctor', medication: DRUG, dose_text: DOSE, test_name: TESTN, clinical_info: INFO, end_reason: 'rash on Zelda', ...o });
const res = o => ({ id: 1, replaces_result_id: null, value_text: '5.4', unit_text: 'mmol/L', collected_at: '2026-11-22T08:00:00.000Z', recorded_at: '2026-11-22T10:00:00.000Z', recorded_role: 'nurse', flag: 'abnormal', reference_text: '3.5-5.0', ...o });

test('R4j: orders and results validate against 0.2.0; no drug, dose, test name, flag or reason travels', () => {
  const e = buildEnvelope({ ...input(), medicationOrders: [ord({ id: 4, status: 'changed' }), ord({ id: 2, status: 'stopped' }), ord({ id: 6 })], investigationOrders: [ord({ id: 3, status: 'cancelled' })], results: [res({ id: 8 }), res({ id: 9, replaces_result_id: 8, value_text: '5.1' })] }); ok(e);
  assert.equal(e.envelope.version, '0.2.0');
  assert.deepEqual(e.orders.map(o => [o.id, o.lifecycle]), [['om-1', 'stopped'], ['om-2', 'replaced'], ['om-3', 'active'], ['oi-1', 'cancelled']], 'ranks by row id; a change is "replaced", not a correction');
  assert.ok(e.orders.every(o => o.concept.id === 'unclassified' && !('effective' in o) && !('period' in o) && !('correctionOf' in o) && o.status === 'final'));
  assert.deepEqual(e.results.map(r => [r.id, r.value, r.unit, r.status, r.correctionOf, r.provenance.corrected]), [['rs-1', 5.4, 'mmol/L', 'final', undefined, true], ['rs-2', 5.1, 'mmol/L', 'corrected', 'rs-1', false]]);
  assert.deepEqual([e.results[0].kind, e.results[0].effective, e.results[0].recorded.zone, e.results[0].sourceClass], ['quantity', { value: '2026-11-22T08:00:00.000Z', zone: 'stated' }, 'stated', 'clinician-entered']);
  const bytes = JSON.stringify(e);
  for (const t of [DRUG, DOSE, TESTN, INFO, 'rash', 'abnormal', '3.5-5.0', 'Hargrove', 'Zelda']) assert.equal(bytes.includes(t), false, t + ' must not travel');
});

test('R4j: a result is withheld and counted unless it is a plain number with a one-token unit and a specimen time', () => {
  const e = buildEnvelope({ ...input(), results: [res({ id: 1, value_text: 'Positive for Hargrove' }), res({ id: 2, value_text: '>5.0' }), res({ id: 3, value_text: '5,4' }), res({ id: 4, unit_text: null }),
    res({ id: 5, unit_text: 'mmol per L' }), res({ id: 6, collected_at: null }), res({ id: 7, value_text: ' -12.50 ' })] }); ok(e);
  assert.deepEqual(e.results.map(r => [r.id, r.value]), [['rs-7', -12.5]]);
  const w = e['x-emr'].withheld; assert.deepEqual([w.resultsNotNumeric, w.resultsWithoutUnit, w.resultsWithoutSpecimen, w.unclassifiedResults], [3, 2, 1, 1]);
  assert.equal(JSON.stringify(e).includes('Hargrove'), false);
});

test('R4j: entered-in-error orders are only counted; a withheld original leaves the link out, counted', () => {
  const e = buildEnvelope({ ...input(), medicationOrders: [ord({ id: 1, status: 'entered_in_error' })], investigationOrders: [ord({ id: 1, status: 'entered_in_error' })],
    results: [res({ id: 1, value_text: 'high' }), res({ id: 2, replaces_result_id: 1, value_text: '5.0' })] }); ok(e);
  assert.equal('orders' in e, false);
  assert.deepEqual([e['x-emr'].withheld.enteredInErrorOrders, e['x-emr'].withheld.unclassifiedOrders, e['x-emr'].withheld.resultCorrectionTargetsWithheld], [2, 0, 1]);
  assert.equal('correctionOf' in e.results[0], false);
});

test('R4j: no rows means no sections and the exact old envelope; an unknown order status is refused', () => {
  const plain = buildEnvelope(input()), none = buildEnvelope({ ...input(), medicationOrders: [], investigationOrders: [], results: [] }); ok(none);
  assert.deepEqual(none, plain);
  assert.throws(() => buildEnvelope({ ...input(), investigationOrders: [ord({ status: 'changed' })] }), EnvelopeError, 'a status of the other table is not guessed');
  assert.equal(buildEnvelope({ ...input(), results: [res({ value_text: 'x' })] }).envelope.version, '0.1.0', 'nothing sent: plain 0.1.0');
});
