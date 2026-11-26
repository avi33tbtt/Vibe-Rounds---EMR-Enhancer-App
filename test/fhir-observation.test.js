'use strict';
// Task R6a: FHIR Observation export (fhir-observation.js). Pure: no database, no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFhirObservations, checkObservation, FhirExportError } = require('../fhir-observation');

const PT = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const DEF = { fields: [
  { id: 'hr', label: 'Heart rate', type: 'number', bindings: [{ system: 'local', code: 'demo.hr', display: 'Heart rate' }, { system: 'loinc', code: '8867-4', display: 'Heart rate' }] },
  { id: 'cnt', label: 'Count', type: 'integer' }, { id: 'alert', label: 'Alert', type: 'boolean' }, { id: 'avpu', label: 'AVPU', type: 'select' },
  { id: 'note', label: 'Comment', type: 'text' }, { id: 'when', label: 'Onset', type: 'datetime' } ] };
const SETS = [{ id: 7, slug: 'vitals_set', version: 1, definition_json: DEF }];
let n = 0;
const row = o => ({ id: ++n, applied_set_id: 7, field_key: 'hr', value_type: 'number', value_json: 88, unit_display: 'bpm', effective_at: '2026-11-23T07:30:00.000Z', recorded_at: '2026-11-23T07:31:00.000Z',
  source_type: 'clinician', status: 'final', corrects_id: null, change_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const build = (rows, extra = {}) => { n = 0; return buildFhirObservations({ patientRef: PT, rows: typeof rows === 'function' ? rows() : rows, sets: SETS, ...extra }); };

test('values are typed, never coerced: 0 and false stay; unknown has dataAbsentReason and no value; a unit is text only', () => {
  const { resources: R, counts } = build(() => [row({ value_json: 0 }), row({ field_key: 'alert', value_type: 'boolean', value_json: false, unit_display: null }),
    row({ field_key: 'cnt', value_type: 'integer', value_json: 3, unit_display: null }), row({ field_key: 'avpu', value_type: 'select', value_json: 'Alert', unit_display: null }),
    row({ field_key: 'note', value_type: 'text', value_json: 'ok', unit_display: null }), row({ field_key: 'hr', value_type: 'unknown', value_json: null, unit_display: null })]);
  assert.deepEqual(R[0].valueQuantity, { value: 0, unit: 'bpm' }); assert.equal(R[0].valueQuantity.system, undefined, 'no unit code invented');
  assert.equal(R[1].valueBoolean, false); assert.equal(R[2].valueInteger, 3); assert.equal(R[3].valueString, 'Alert'); assert.equal(R[4].valueString, 'ok');
  const u = R[5];
  assert.equal(Object.keys(u).some(k => k.startsWith('value')), false); assert.equal(u.dataAbsentReason.coding[0].code, 'unknown'); assert.equal(counts.unknown, 1);
  for (const r of R) assert.deepEqual(checkObservation(r), []);
});

test('code is text only by default; a local binding is never a Coding even if a verifier says yes; every omitted binding is counted', () => {
  const r = build([row()]);
  assert.deepEqual(r.resources[0].code, { text: 'Heart rate' }); assert.equal(r.counts.codingsOmitted, 2);
  const all = build([row()], { verify: b => ({ system: 'http://x.example/' + b.system, code: b.code, display: b.display }) });
  assert.equal(all.resources[0].code.coding.length, 1, 'only the non-local binding'); assert.equal(all.resources[0].code.coding[0].code, '8867-4');
  assert.equal(all.counts.codingsOmitted, 1);
  assert.ok(!JSON.stringify(all.resources).includes('demo.hr'), 'local code absent from the output');
});

test('a verifier that throws or returns junk means "not verified"; nothing is emitted', () => {
  for (const verify of [() => { throw new Error('boom'); }, () => ({ code: 'x' }), () => 'yes', () => ({ system: 's' })]) {
    const r = build([row()], { verify });
    assert.deepEqual(r.resources[0].code, { text: 'Heart rate' });
  }
});

test('status: entered in error is kept (never dropped) with who, when and why; amended becomes corrected; ai_proposed stays tagged', () => {
  const { resources: R, counts } = build(() => [row({ status: 'entered_in_error', error_by: 'dr_a', error_at: '2026-11-24T01:00:00Z', error_reason: 'wrong patient' }),
    row({ status: 'preliminary', source_type: 'ai_proposed' }), row({ status: 'amended', corrects_id: 2, change_reason: 'recount' })]);
  assert.equal(R.length, 3); assert.equal(counts.enteredInError, 1);
  const e = R.find(r => r.status === 'entered-in-error'); assert.match(e.note[0].text, /dr_a.*2026-11-24T01:00:00.000Z.*wrong patient/);
  assert.equal(R.find(r => r.status === 'corrected').status, 'corrected');
  assert.equal(R.find(r => r.status === 'preliminary').meta.tag[0].code, 'ai_proposed');
});

test('a correction links both ways in notes; the original keeps its own status and value', () => {
  const { resources: R } = build(() => [row({ value_json: 80 }), row({ value_json: 90, status: 'amended', corrects_id: 1, change_reason: 'typo' })]);
  const orig = R.find(r => r.identifier[0].value === '1'), fix = R.find(r => r.identifier[0].value === '2');
  assert.equal(orig.status, 'final'); assert.equal(orig.valueQuantity.value, 80); assert.match(orig.note[0].text, /Corrected by observation 2/);
  assert.equal(fix.valueQuantity.value, 90); assert.match(fix.note[0].text, /Corrects observation 1: typo/);
});

test('effective time and recorded time stay apart; output is ordered by effective time then id', () => {
  const { resources: R } = build(() => [row({ effective_at: '2026-11-25T00:00:00Z', recorded_at: '2026-11-20T00:00:00Z' }), row({ effective_at: '2026-11-22T00:00:00Z', recorded_at: '2026-11-26T00:00:00Z' })]);
  assert.deepEqual(R.map(r => r.identifier[0].value), ['2', '1']);
  assert.equal(R[1].effectiveDateTime, '2026-11-25T00:00:00.000Z'); assert.equal(R[1].issued, '2026-11-20T00:00:00.000Z');
});

test('date-time values: zoned and date-only pass; a time with no zone is exported as text, counted, and not given a guessed zone', () => {
  const { resources: R, counts } = build(() => [row({ field_key: 'when', value_type: 'datetime', value_json: '2026-11-20T08:00:00+05:45', unit_display: null }),
    row({ field_key: 'when', value_type: 'datetime', value_json: '2026-11-20', unit_display: null }), row({ field_key: 'when', value_type: 'datetime', value_json: '2026-11-20T08:00', unit_display: null })]);
  assert.equal(R[0].valueDateTime, '2026-11-20T08:00:00+05:45'); assert.equal(R[1].valueDateTime, '2026-11-20');
  assert.equal(R[2].valueDateTime, undefined); assert.equal(R[2].valueString, '2026-11-20T08:00'); assert.equal(counts.datetimeNoZone, 1); assert.match(R[2].note[0].text, /without a time zone/);
});

test('a field missing from the pinned definition is still exported, labelled by its key, and counted; no names or user ids leak', () => {
  const { resources: R, counts } = build([row({ applied_set_id: 99, field_key: 'mystery' })]);
  assert.equal(R[0].code.text, 'mystery'); assert.equal(counts.fieldsUnresolved, 1);
  const s = JSON.stringify(R); assert.ok(!/recorded_by|username|performer/.test(s));
});

test('bad input is refused, not guessed: unknown status, value type, source, missing id, bad time, no patient reference', () => {
  assert.throws(() => build([row({ status: 'weird' })]), FhirExportError);
  assert.throws(() => build([row({ value_type: 'blob' })]), FhirExportError);
  assert.throws(() => build([row({ source_type: 'magic' })]), FhirExportError);
  assert.throws(() => build([row({ id: undefined })]), FhirExportError);
  assert.throws(() => build([row({ recorded_at: 'yesterday' })]), FhirExportError);
  assert.throws(() => buildFhirObservations({ patientRef: '', rows: [] }), FhirExportError);
  assert.throws(() => buildFhirObservations({ patientRef: PT, rows: 'x' }), FhirExportError);
});

test('the input is not changed, and the same input always gives the same output', () => {
  n = 0; const rows = [row(), row({ value_type: 'unknown', value_json: null, unit_display: null })]; const before = JSON.stringify(rows);
  const a = buildFhirObservations({ patientRef: PT, rows, sets: SETS }), b = buildFhirObservations({ patientRef: PT, rows: [...rows].reverse(), sets: SETS });
  assert.equal(JSON.stringify(rows), before); assert.deepEqual(a, b);
});

test('checkObservation catches the common mistakes', () => {
  assert.ok(checkObservation({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'p' } }).some(i => /no value/.test(i)));
  assert.ok(checkObservation({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'p' }, valueString: 'a', dataAbsentReason: {} }).some(i => /together/.test(i)));
  assert.ok(checkObservation({ resourceType: 'Observation', code: { text: 'x' }, subject: { reference: 'p' }, valueString: 'a' }).includes('missing status'));
  assert.ok(checkObservation({ resourceType: 'Observation', status: 'final', code: { coding: [{ code: 'c' }] }, subject: { reference: 'p' }, valueString: 'a' }).some(i => /Coding/.test(i)));
});

test('the module is pure: no database, file, network, clock or random', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fhir-observation.js'), 'utf8');
  assert.ok(!/require\(|Date\.now|new Date\(\)|Math\.random|process\.|fetch\(|randomUUID/.test(src));
});
