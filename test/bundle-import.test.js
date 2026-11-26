'use strict';
// Task R6f-1: Bundle -> reviewable proposals (bundle-import.js). Pure: no database, no server. Nothing is written by the module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseBundle, bundleHash, BundleImportError, LIMITS } = require('../bundle-import');
const { buildFhirObservations } = require('../fhir-observation');
const { buildFhirConditions } = require('../fhir-condition');
const { buildFhirAllergies } = require('../fhir-allergy');
const { buildFhirMedicationRequests } = require('../fhir-medication-request');

const PT = 'urn:uuid:p1';
const patient = (fullUrl = PT, extra = {}) => ({ fullUrl, resource: { resourceType: 'Patient', identifier: [{ system: 'urn:x', value: 'MRN-1' }], name: [{ text: 'Secret Name' }], ...extra }, request: { method: 'POST', url: 'Patient' } });
const entry = (resource, i) => ({ fullUrl: 'urn:uuid:e' + i, resource, request: { method: 'POST', url: resource.resourceType } });
const bundle = (resources, type = 'transaction') => ({ resourceType: 'Bundle', type, entry: [patient(), ...resources.map(entry)] });
const obs = o => ({ resourceType: 'Observation', status: 'final', code: { text: 'Heart rate' }, subject: { reference: PT }, effectiveDateTime: '2026-11-23T07:30:00Z', issued: '2026-11-23T07:31:00Z', valueQuantity: { value: 88, unit: 'bpm' }, ...o });
const P1 = r => parseBundle(bundle([r])).proposals[0];

test('an observation becomes a DRAFT proposal: preliminary, imported, source status kept, effective and recorded time apart', () => {
  const p = P1(obs());
  assert.equal(p.draft, true); assert.equal(p.startsAs, 'preliminary'); assert.equal(p.source, 'imported'); assert.equal(p.sourceStatus, 'final'); assert.equal(p.ready, true);
  assert.deepEqual(p.fields, { label: 'Heart rate', valueType: 'number', value: 88, unit: 'bpm', effectiveAt: '2026-11-23T07:30:00.000Z', sourceRecordedAt: '2026-11-23T07:31:00Z' });
});

test('values are never coerced: 0, false and empty text stay; a string is not turned into a number; unknown needs the exact reason; other value types are blocked', () => {
  assert.equal(P1(obs({ valueQuantity: { value: 0, unit: 'bpm' } })).fields.value, 0);
  const b = P1(obs({ valueQuantity: undefined, valueBoolean: false })).fields; assert.equal(b.value, false); assert.equal(b.valueType, 'boolean');
  assert.equal(P1(obs({ valueQuantity: undefined, valueString: '' })).fields.value, '');
  const s = P1(obs({ valueQuantity: { value: '88' } })); assert.equal(s.ready, false); assert.match(s.blockers[0], /cannot be carried over/);
  const u = P1(obs({ valueQuantity: undefined, dataAbsentReason: { coding: [{ code: 'unknown' }] } })); assert.equal(u.fields.valueType, 'unknown'); assert.equal(u.fields.value, null); assert.equal(u.ready, true);
  assert.equal(P1(obs({ valueQuantity: undefined, dataAbsentReason: { coding: [{ code: 'masked' }] } })).ready, false);
  assert.equal(P1(obs({ valueQuantity: undefined, valueCodeableConcept: { text: 'x' } })).ready, false);
  assert.equal(P1(obs({ valueQuantity: undefined })).ready, false);
  assert.equal(P1(obs({ valueString: 'also' })).ready, false, 'two values');
});

test('time is never invented: a date-only or missing effective time is a blocker, a naive date-time is not accepted', () => {
  assert.match(P1(obs({ effectiveDateTime: '2026-11-23' })).blockers[0], /no time of day/); assert.equal(P1(obs({ effectiveDateTime: '2026-11-23' })).fields.effectiveAt, null);
  assert.match(P1(obs({ effectiveDateTime: undefined })).blockers[0], /no usable effective time/);
  assert.equal(P1(obs({ effectiveDateTime: '2026-11-23T07:30:00' })).ready, false);
  assert.equal(P1(obs({ effectiveDateTime: undefined, effectiveInstant: '2026-11-23T07:30:00+05:45' })).ready, true);
  assert.equal(P1(obs({ valueQuantity: undefined, valueDateTime: '2026-11-20T08:00' })).ready, false);
});

test('NO codes are imported: codings are dropped and counted; a display may serve as the name; nothing coded reaches a proposal', () => {
  const r = parseBundle(bundle([obs({ code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] } }), obs({ code: { text: 'HR', coding: [{ system: 's', code: 'c' }, { system: 's', code: 'd' }] } })]));
  assert.equal(r.summary.codingsDropped, 3); assert.equal(r.proposals[0].fields.label, 'Heart rate'); assert.ok(!JSON.stringify(r.proposals).includes('8867-4'));
});

test('entered in error is skipped and counted, not imported; notes and names are not carried', () => {
  const r = parseBundle(bundle([obs({ status: 'entered-in-error' }), { resourceType: 'Condition', code: { text: 'Asthma' }, subject: { reference: PT }, verificationStatus: { coding: [{ code: 'entered-in-error' }] } }, obs({ note: [{ text: 'Mr Secret said' }] })]));
  assert.equal(r.proposals.length, 1); assert.equal(r.summary.skippedInError, 2); assert.equal(r.summary.notesDropped, 1);
  const s = JSON.stringify(r.proposals) + JSON.stringify(r.audit); assert.ok(!/Secret|said/.test(s));
});

test('a Condition and an AllergyIntolerance start as ACTIVE; a different source status is warned about, not carried; reaction and severity are kept', () => {
  const c = P1({ resourceType: 'Condition', code: { text: 'Asthma' }, subject: { reference: PT }, clinicalStatus: { coding: [{ code: 'resolved' }] }, onsetDateTime: '2020-03-01', recordedDate: '2026-11-20T08:00:00Z' });
  assert.equal(c.startsAs, 'active'); assert.equal(c.sourceStatus, 'resolved'); assert.match(c.warnings[0], /starts as active/); assert.equal(c.fields.onsetDate, '2020-03-01'); assert.equal(c.ready, true);
  const a = P1({ resourceType: 'AllergyIntolerance', code: { text: 'Penicillin' }, patient: { reference: PT }, clinicalStatus: { coding: [{ code: 'active' }] }, reaction: [{ manifestation: [{ text: 'Rash' }], severity: 'moderate' }, { manifestation: [{ text: 'x' }] }], onsetDateTime: '2015-06-01' });
  assert.deepEqual([a.fields.substance, a.fields.reaction, a.fields.severity, a.fields.onsetDate], ['Penicillin', 'Rash', 'moderate', '2015-06-01']); assert.match(a.warnings[0], /further reaction/); assert.equal(a.ready, true);
  assert.equal(P1({ resourceType: 'Condition', code: { text: 'A' }, subject: {}, clinicalStatus: { coding: [{ code: 'active' }] }, onsetDateTime: '2020-13-01' }).fields.onsetDate, null);
});

test('a MedicationRequest is ALWAYS blocked: text kept word for word, never split into dose, route and frequency, never an order', () => {
  const m = P1({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: PT }, medicationCodeableConcept: { text: 'Drug A' }, dosageInstruction: [{ text: 'Dose: 500 mg. Route: IV. Frequency: every 6 hours.', route: { text: 'IV' } }] });
  assert.equal(m.ready, false); assert.equal(m.startsAs, 'none'); assert.match(m.blockers.join(' '), /never creates an order/);
  assert.equal(m.fields.dosageText, 'Dose: 500 mg. Route: IV. Frequency: every 6 hours.'); assert.deepEqual(Object.keys(m.fields).sort(), ['dosageText', 'medication']);
});

test('limits block, never cut: over-long name, reaction, dosage text; the proposal keeps what it was given', () => {
  const long = n => 'x'.repeat(n + 1);
  assert.equal(P1(obs({ code: { text: long(LIMITS.label) } })).ready, false);
  assert.equal(P1({ resourceType: 'AllergyIntolerance', code: { text: 'P' }, patient: {}, clinicalStatus: { coding: [{ code: 'active' }] }, reaction: [{ manifestation: [{ text: long(LIMITS.reaction) }] }] }).ready, false);
  const m = P1({ resourceType: 'MedicationRequest', status: 'active', medicationCodeableConcept: { text: 'D' }, dosageInstruction: [{ text: long(LIMITS.dosage) }] });
  assert.ok(m.blockers.some(b => /dosage text is longer/.test(b))); assert.equal(m.fields.dosageText.length, LIMITS.dosage + 1);
});

test('the patient is never matched: only identifiers are reported; two patients block every proposal; no patient is a warning', () => {
  const one = parseBundle(bundle([obs()])); assert.deepEqual(one.patients, [{ fullUrl: PT, identifiers: [{ system: 'urn:x', value: 'MRN-1' }] }]); assert.ok(!JSON.stringify(one).includes('Secret Name'));
  const two = { ...bundle([obs()]) }; two.entry = [...two.entry, patient('urn:uuid:p2')];
  const r = parseBundle(two); assert.equal(r.proposals[0].ready, false); assert.match(r.warnings[0], /2 patients/);
  const none = parseBundle({ resourceType: 'Bundle', type: 'collection', entry: [{ resource: obs() }] }); assert.match(none.warnings[0], /no Patient entry/); assert.equal(none.proposals[0].ready, true);
});

test('only POST entries act in a transaction: PUT, DELETE and no method are rejected and listed; duplicates, unknown types and empty entries too', () => {
  const b = bundle([obs(), obs(), obs()]); b.entry[1].request.method = 'PUT'; b.entry[2].request = { method: 'DELETE', url: 'Observation/1' };
  b.entry.push({ fullUrl: 'urn:uuid:e1', resource: obs(), request: { method: 'POST' } }, entry({ resourceType: 'Encounter' }, 9), { request: { method: 'POST' } });
  const r = parseBundle(b);
  assert.equal(r.proposals.length, 1, 'only the one valid POST remains'); assert.ok(r.rejected.some(x => /asks for PUT/.test(x.reason))); assert.ok(r.rejected.some(x => /asks for DELETE/.test(x.reason)));
  assert.ok(r.rejected.some(x => /twice/.test(x.reason))); assert.ok(r.rejected.some(x => /Encounter/.test(x.reason))); assert.ok(r.rejected.some(x => /no resource/.test(x.reason)));
});

test('bad bundles are refused: not a Bundle, wrong type, no entries, too many entries', () => {
  assert.throws(() => parseBundle(null), BundleImportError); assert.throws(() => parseBundle({ resourceType: 'Patient' }), BundleImportError);
  assert.throws(() => parseBundle({ resourceType: 'Bundle', type: 'document', entry: [{}] }), /transaction and collection/);
  assert.throws(() => parseBundle({ resourceType: 'Bundle', type: 'collection' }), /no entries/);
  assert.throws(() => parseBundle({ resourceType: 'Bundle', type: 'collection', entry: Array.from({ length: LIMITS.entries + 1 }, () => ({})) }), /at most/);
});

test('ROUND TRIP: what R6a to R6d export is read back as the same facts', () => {
  const sets = [{ id: 7, slug: 's', version: 1, definition_json: { fields: [{ id: 'hr', label: 'Heart rate' }] } }];
  const orow = (id, o) => ({ id, applied_set_id: 7, field_key: 'hr', value_type: 'number', value_json: 88, unit_display: 'bpm', effective_at: '2026-11-23T07:30:00.000Z', recorded_at: '2026-11-23T07:31:00.000Z', source_type: 'clinician', status: 'final', corrects_id: null, change_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
  const O = buildFhirObservations({ patientRef: PT, sets, rows: [orow(1, {}), orow(2, { value_type: 'unknown', value_json: null, unit_display: null }), orow(3, { value_json: 0 }), orow(4, { status: 'entered_in_error', error_by: 'a', error_at: '2026-11-24T00:00:00Z', error_reason: 'r' })] }).resources;
  const C = buildFhirConditions({ patientRef: PT, rows: [{ id: 1, label: 'Asthma', onset_date: '2020-03-01', status: 'active', recorded_at: '2026-11-20T08:00:00Z' }] }).resources;
  const A = buildFhirAllergies({ patientRef: PT, rows: [{ id: 1, substance: 'Penicillin', reaction: 'Rash', severity: 'mild', onset_date: null, status: 'active', recorded_at: '2026-11-20T08:00:00Z' }] }).resources;
  const M = buildFhirMedicationRequests({ patientRef: PT, rows: [{ id: 1, medication: 'Drug A', dose_text: 'd', route_text: 'r', frequency_text: 'f', status: 'active', ordered_at: '2026-11-20T08:00:00Z' }] }).resources;
  const r = parseBundle(bundle([...O, ...C, ...A, ...M]));
  assert.equal(r.summary.skippedInError, 1);
  const ob = r.proposals.filter(p => p.kind === 'Observation').map(p => [p.fields.valueType, p.fields.value, p.ready]);
  assert.deepEqual(ob, [['number', 88, true], ['unknown', null, true], ['number', 0, true]]);
  assert.deepEqual(r.proposals.find(p => p.kind === 'Condition').fields.label, 'Asthma'); assert.equal(r.proposals.find(p => p.kind === 'AllergyIntolerance').fields.severity, 'mild');
  assert.equal(r.proposals.find(p => p.kind === 'MedicationRequest').ready, false);
  assert.equal(r.rejected.length, 0);
});

test('the audit summary is counts and a hash only: stable for the same bundle, different for a different one, no content, identifiers or names', () => {
  const b = bundle([obs(), obs({ valueQuantity: { value: 90, unit: 'bpm' } })]);
  const a1 = parseBundle(b).audit, a2 = parseBundle(JSON.parse(JSON.stringify(b))).audit;
  assert.deepEqual(a1, a2); assert.match(a1.hash, /^[0-9a-f]{64}$/); assert.equal(a1.byType.Observation, 2); assert.equal(a1.proposals, 2);
  assert.notEqual(parseBundle(bundle([obs()])).audit.hash, a1.hash);
  assert.ok(!/MRN-1|Secret|Heart rate|88/.test(JSON.stringify(a1)));
  assert.equal(bundleHash({ b: 1, a: 2 }), bundleHash({ a: 2, b: 1 }), 'key order does not matter');
});

test('the input is not changed; the module is pure (no database, file, network, clock or random)', () => {
  const b = bundle([obs()]), before = JSON.stringify(b); parseBundle(b); assert.equal(JSON.stringify(b), before);
  const src = fs.readFileSync(path.join(__dirname, '..', 'bundle-import.js'), 'utf8');
  assert.ok(!/Date\.now|new Date\(\)|Math\.random|process\.|fetch\(|randomUUID|require\('(fs|http|https|net|child_process|pg)'\)/.test(src));
});
