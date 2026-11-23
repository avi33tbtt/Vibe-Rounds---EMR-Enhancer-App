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
