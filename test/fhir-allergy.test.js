'use strict';
// Task R6c: FHIR AllergyIntolerance export (fhir-allergy.js). Pure: no database, no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFhirAllergies, checkAllergy, FhirExportError } = require('../fhir-allergy');

const PT = 'urn:uuid:11111111-1111-4111-8111-111111111111';
let n = 0;
const row = o => ({ id: ++n, substance: 'Penicillin', reaction: 'Rash', severity: 'moderate', onset_date: '2015-06-01', status: 'active', recorded_at: '2026-11-20T08:00:00.000Z',
  resolved_by: null, resolved_at: null, resolution_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const build = (rows, extra = {}) => { n = 0; return buildFhirAllergies({ patientRef: PT, rows: typeof rows === 'function' ? rows() : rows, ...extra }); };

test('an active allergy: patient (not subject), text code, reaction with manifestation and severity, onset as a date, recorded time apart', () => {
  const { resources: [r], counts } = build([row()]);
  assert.equal(r.patient.reference, PT); assert.equal(r.subject, undefined); assert.deepEqual(r.code, { text: 'Penicillin' });
  assert.equal(r.clinicalStatus.coding[0].code, 'active'); assert.deepEqual(r.reaction, [{ manifestation: [{ text: 'Rash' }], severity: 'moderate' }]);
  assert.equal(r.onsetDateTime, '2015-06-01'); assert.equal(r.recordedDate, '2026-11-20T08:00:00.000Z'); assert.deepEqual(checkAllergy(r), []); assert.equal(counts.exported, 1);
});

test('nothing is invented: no type, category or criticality; unrecorded reaction and onset stay absent', () => {
  const { resources: [r], counts } = build([row({ reaction: null, severity: null, onset_date: null })]);
  assert.equal(r.reaction, undefined); assert.equal(r.onsetDateTime, undefined); assert.equal(counts.onsetUnknown, 1);
  for (const k of ['type', 'category', 'criticality']) assert.equal(r[k], undefined);
  assert.equal(build([row()]).resources[0].criticality, undefined, 'severity is not criticality');
});

test('severity with no reaction is not turned into a made-up reaction: it goes in a note and is counted', () => {
  const { resources: [r], counts } = build([row({ reaction: null, severity: 'severe' })]);
  assert.equal(r.reaction, undefined); assert.match(r.note[0].text, /severe.*no reaction/); assert.equal(counts.severityWithoutReaction, 1); assert.deepEqual(checkAllergy(r), []);
  const only = build([row({ severity: null })]).resources[0]; assert.deepEqual(only.reaction, [{ manifestation: [{ text: 'Rash' }] }]);
});

test('resolved: status resolved, recorded resolution in a note, no abatement claimed', () => {
  const { resources: [r], counts } = build([row({ status: 'resolved', resolved_by: 'dr_a', resolved_at: '2026-11-22T01:00:00Z', resolution_reason: 'tolerated challenge' })]);
  assert.equal(r.clinicalStatus.coding[0].code, 'resolved'); assert.match(r.note[0].text, /dr_a.*2026-11-22T01:00:00.000Z.*tolerated/); assert.equal(r.abatementDateTime, undefined); assert.equal(counts.resolved, 1);
});

test('entered in error is kept, with verificationStatus and NO clinicalStatus; a prior resolution is mentioned', () => {
  const { resources: [r], counts } = build([row({ status: 'entered_in_error', error_by: 'dr_b', error_at: '2026-11-23T00:00:00Z', error_reason: 'wrong chart', resolved_at: '2026-11-22T01:00:00Z' })]);
  assert.equal(r.verificationStatus.coding[0].code, 'entered-in-error'); assert.equal(r.clinicalStatus, undefined);
  assert.match(r.note[0].text, /dr_b.*wrong chart/); assert.match(r.note[1].text, /marked resolved/); assert.equal(counts.enteredInError, 1); assert.deepEqual(checkAllergy(r), []);
});

test('code is text only by default; a verifier may add one; junk or a throw means not verified and is counted', () => {
  const ok = build([row()], { verify: () => ({ system: 'http://x.example', code: 'a', display: 'PCN' }) }).resources[0];
  assert.deepEqual(ok.code.coding, [{ system: 'http://x.example', code: 'a', display: 'PCN' }]); assert.equal(ok.code.text, 'Penicillin');
  assert.equal(build([row()]).resources[0].code.coding, undefined);
  for (const verify of [() => { throw new Error('x'); }, () => ({ code: 'a' }), () => 'yes']) assert.equal(build([row()], { verify }).resources[0].code.coding, undefined);
  assert.equal(build([row()], { verify: () => ({ code: 'a' }) }).counts.codingsOmitted, 1);
});

test('ordered by recorded time then id; any input order gives the same output; input untouched', () => {
  n = 0; const rows = [row({ recorded_at: '2026-11-21T00:00:00Z' }), row({ recorded_at: '2026-11-19T00:00:00Z' }), row({ recorded_at: '2026-11-19T00:00:00Z' })]; const before = JSON.stringify(rows);
  const a = buildFhirAllergies({ patientRef: PT, rows }), b = buildFhirAllergies({ patientRef: PT, rows: [...rows].reverse() });
  assert.deepEqual(a.resources.map(r => r.identifier[0].value), ['2', '3', '1']); assert.deepEqual(a, b); assert.equal(JSON.stringify(rows), before);
});

test('bad input is refused, not guessed: status, substance, severity, date, time, id, patient reference', () => {
  assert.throws(() => build([row({ status: 'weird' })]), FhirExportError);
  assert.throws(() => build([row({ substance: ' ' })]), FhirExportError);
  assert.throws(() => build([row({ severity: 'extreme' })]), FhirExportError);
  assert.throws(() => build([row({ onset_date: '2015-13-01' })]), FhirExportError);
  assert.throws(() => build([row({ recorded_at: 'soon' })]), FhirExportError);
  assert.throws(() => build([row({ id: undefined })]), FhirExportError);
  assert.throws(() => buildFhirAllergies({ patientRef: '', rows: [] }), FhirExportError);
  assert.throws(() => buildFhirAllergies({ patientRef: PT, rows: null }), FhirExportError);
});

test('no user ids, case ids or references to people leak into the output', () => {
  const s = JSON.stringify(build([row({ origin_case_id: 5, recorded_by: 9 })]).resources);
  assert.ok(!/origin_case|recorded_by|performer|asserter|recorder/.test(s));
});

test('checkAllergy catches the common mistakes', () => {
  const base = { resourceType: 'AllergyIntolerance', code: { text: 'x' }, patient: { reference: 'p' } };
  assert.ok(checkAllergy(base).includes('missing clinicalStatus'));
  assert.ok(checkAllergy({ ...base, clinicalStatus: {}, verificationStatus: { coding: [{ code: 'entered-in-error' }] } }).some(i => /with entered-in-error/.test(i)));
  assert.ok(checkAllergy({ ...base, clinicalStatus: {}, reaction: [{ severity: 'mild' }] }).includes('reaction without manifestation'));
  assert.ok(checkAllergy({ resourceType: 'AllergyIntolerance', clinicalStatus: {}, patient: { reference: 'p' } }).includes('missing code'));
});

test('the module is pure: no database, file, network, clock or random', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fhir-allergy.js'), 'utf8');
  assert.ok(!/require\(|Date\.now|new Date\(\)|Math\.random|process\.|fetch\(|randomUUID/.test(src));
});
