'use strict';
// Task R6b: FHIR Condition export (fhir-condition.js). Pure: no database, no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFhirConditions, checkCondition, FhirExportError } = require('../fhir-condition');

const PT = 'urn:uuid:11111111-1111-4111-8111-111111111111';
let n = 0;
const row = o => ({ id: ++n, label: 'Type 2 diabetes', onset_date: '2020-03-01', status: 'active', recorded_at: '2026-11-20T08:00:00.000Z', local_term_code: null,
  resolved_by: null, resolved_at: null, resolution_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const build = (rows, extra = {}) => { n = 0; return buildFhirConditions({ patientRef: PT, rows: typeof rows === 'function' ? rows() : rows, ...extra }); };

test('an active problem: clinical status active, the clinician\'s words as text, onset as a date only, recorded time kept apart', () => {
  const { resources: [r], counts } = build([row()]);
  assert.equal(r.clinicalStatus.coding[0].code, 'active'); assert.deepEqual(r.code, { text: 'Type 2 diabetes' }); assert.equal(r.subject.reference, PT);
  assert.equal(r.onsetDateTime, '2020-03-01'); assert.equal(r.recordedDate, '2026-11-20T08:00:00.000Z'); assert.equal(r.abatementDateTime, undefined);
  assert.equal(r.identifier[0].value, '1'); assert.deepEqual(checkCondition(r), []); assert.equal(counts.exported, 1);
});

test('unknown onset stays absent and is counted; no date is invented', () => {
  const { resources: [r], counts } = build([row({ onset_date: null })]);
  assert.equal(r.onsetDateTime, undefined); assert.equal(counts.onsetUnknown, 1);
});

test('resolved: status resolved, no abatement claimed, the recorded resolution goes in a note', () => {
  const { resources: [r], counts } = build([row({ status: 'resolved', resolved_by: 'dr_a', resolved_at: '2026-11-22T01:00:00Z', resolution_reason: 'cured' })]);
  assert.equal(r.clinicalStatus.coding[0].code, 'resolved'); assert.equal(r.abatementDateTime, undefined);
  assert.match(r.note[0].text, /dr_a.*2026-11-22T01:00:00.000Z.*cured/); assert.equal(counts.resolved, 1); assert.deepEqual(checkCondition(r), []);
});

test('entered in error is kept, with verificationStatus and NO clinicalStatus; a prior resolution is mentioned', () => {
  const { resources: [r], counts } = build([row({ status: 'entered_in_error', error_by: 'dr_b', error_at: '2026-11-23T00:00:00Z', error_reason: 'wrong chart', resolved_at: '2026-11-22T01:00:00Z' })]);
  assert.equal(r.verificationStatus.coding[0].code, 'entered-in-error'); assert.equal(r.clinicalStatus, undefined);
  assert.match(r.note[0].text, /dr_b.*wrong chart/); assert.match(r.note[1].text, /marked resolved/); assert.equal(counts.enteredInError, 1); assert.deepEqual(checkCondition(r), []);
});

test('code is text only by default; the reserved local code is never a Coding; a verifier may add one; junk or a throw means not verified', () => {
  assert.equal(build([row({ local_term_code: 'demo.dm2' })], { verify: () => ({ system: 'http://x.example', code: 'a' }) }).resources[0].code.coding, undefined);
  assert.equal(build([row({ local_term_code: 'demo.dm2' })]).counts.codingsOmitted, 1);
  const ok = build([row()], { verify: () => ({ system: 'http://x.example', code: 'a', display: 'DM2' }) }).resources[0];
  assert.deepEqual(ok.code.coding, [{ system: 'http://x.example', code: 'a', display: 'DM2' }]); assert.equal(ok.code.text, 'Type 2 diabetes');
  for (const verify of [() => { throw new Error('x'); }, () => ({ code: 'a' }), () => 'yes']) assert.equal(build([row()], { verify }).resources[0].code.coding, undefined);
});

test('ordered by recorded time then id; same input in any order gives the same output; input untouched', () => {
  n = 0; const rows = [row({ recorded_at: '2026-11-21T00:00:00Z' }), row({ recorded_at: '2026-11-19T00:00:00Z' }), row({ recorded_at: '2026-11-19T00:00:00Z' })]; const before = JSON.stringify(rows);
  const a = buildFhirConditions({ patientRef: PT, rows }), b = buildFhirConditions({ patientRef: PT, rows: [...rows].reverse() });
  assert.deepEqual(a.resources.map(r => r.identifier[0].value), ['2', '3', '1']); assert.deepEqual(a, b); assert.equal(JSON.stringify(rows), before);
});

test('bad input is refused, not guessed: status, label, date, time, id, patient reference', () => {
  assert.throws(() => build([row({ status: 'weird' })]), FhirExportError);
  assert.throws(() => build([row({ label: '  ' })]), FhirExportError);
  assert.throws(() => build([row({ onset_date: '2020-02-31' })]), FhirExportError);
  assert.throws(() => build([row({ onset_date: '2020-13-01' })]), FhirExportError);
  assert.throws(() => build([row({ recorded_at: 'soon' })]), FhirExportError);
  assert.throws(() => build([row({ id: undefined })]), FhirExportError);
  assert.throws(() => buildFhirConditions({ patientRef: '', rows: [] }), FhirExportError);
  assert.throws(() => buildFhirConditions({ patientRef: PT, rows: null }), FhirExportError);
});

test('no user ids, case ids or references to people leak into the output', () => {
  const s = JSON.stringify(build([row({ origin_case_id: 5, recorded_by: 9 })]).resources);
  assert.ok(!/origin_case|recorded_by|performer|asserter|recorder/.test(s));
});

test('checkCondition catches the common mistakes', () => {
  assert.ok(checkCondition({ resourceType: 'Condition', code: { text: 'x' }, subject: { reference: 'p' } }).includes('missing clinicalStatus'));
  assert.ok(checkCondition({ resourceType: 'Condition', code: { text: 'x' }, subject: { reference: 'p' }, clinicalStatus: {}, verificationStatus: { coding: [{ code: 'entered-in-error' }] } }).some(i => /with entered-in-error/.test(i)));
  assert.ok(checkCondition({ resourceType: 'Condition', clinicalStatus: {}, subject: { reference: 'p' } }).includes('missing code'));
  assert.ok(checkCondition({ resourceType: 'Condition', clinicalStatus: {}, subject: { reference: 'p' }, code: { coding: [{ code: 'c' }] } }).some(i => /Coding/.test(i)));
});

test('the module is pure: no database, file, network, clock or random', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fhir-condition.js'), 'utf8');
  assert.ok(!/require\(|Date\.now|new Date\(\)|Math\.random|process\.|fetch\(|randomUUID/.test(src));
});
