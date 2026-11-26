'use strict';
// Task R6d: FHIR MedicationRequest export (fhir-medication-request.js). Pure: no database, no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFhirMedicationRequests, checkMedicationRequest, FhirExportError } = require('../fhir-medication-request');

const PT = 'urn:uuid:11111111-1111-4111-8111-111111111111';
let n = 0;
const row = o => ({ id: ++n, term_id: null, medication: 'Drug A', dose_text: 'as written by the doctor', route_text: 'by mouth', frequency_text: 'twice a day', indication_text: null, status: 'active',
  replaces_order_id: null, ordered_at: '2026-11-20T08:00:00.000Z', ended_by: null, ended_at: null, end_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const build = (rows, extra = {}) => { n = 0; return buildFhirMedicationRequests({ patientRef: PT, rows: typeof rows === 'function' ? rows() : rows, ...extra }); };

test('an active order: intent order, text medication, authored time, subject; no structured dose or timing', () => {
  const { resources: [r], counts } = build([row({ indication_text: 'fever' })]);
  assert.equal(r.status, 'active'); assert.equal(r.intent, 'order'); assert.deepEqual(r.medicationCodeableConcept, { text: 'Drug A' }); assert.equal(r.subject.reference, PT);
  assert.equal(r.authoredOn, '2026-11-20T08:00:00.000Z'); assert.deepEqual(r.reasonCode, [{ text: 'fever' }]); assert.deepEqual(checkMedicationRequest(r), []); assert.equal(counts.exported, 1);
  assert.equal(build([row()]).resources[0].reasonCode, undefined, 'no indication stays absent');
});

test('dose, route and frequency are copied word for word and never parsed; numbers in the text are not turned into quantities', () => {
  const { resources: [r] } = build([row({ dose_text: '500 mg  (take two) ', route_text: 'IV', frequency_text: 'every 6 hours' })]);
  const d = r.dosageInstruction[0];
  assert.equal(d.text, 'Dose: 500 mg  (take two) . Route: IV. Frequency: every 6 hours.'); assert.deepEqual(d.route, { text: 'IV' });
  for (const k of ['doseAndRate', 'timing', 'asNeededBoolean', 'method']) assert.equal(d[k], undefined);
  assert.ok(!JSON.stringify(r).includes('valueQuantity'));
});

test('stopped: status stopped, reason kept, ending recorded in a note, no period or dispense claim', () => {
  const { resources: [r], counts } = build([row({ status: 'stopped', ended_by: 'dr_a', ended_at: '2026-11-22T01:00:00Z', end_reason: 'rash' })]);
  assert.equal(r.status, 'stopped'); assert.deepEqual(r.statusReason, { text: 'rash' }); assert.match(r.note[0].text, /Stopped.*dr_a.*2026-11-22T01:00:00.000Z.*rash/);
  assert.equal(r.dispenseRequest, undefined); assert.equal(counts.stopped, 1);
});

test('changed: the old order is stopped and says it was replaced; the new order points back with priorPrescription', () => {
  const { resources: R, counts } = build(() => [row({ status: 'changed', ended_by: 'dr_a', ended_at: '2026-11-22T01:00:00Z', end_reason: 'new plan' }), row({ replaces_order_id: 1, medication: 'Drug A2', ordered_at: '2026-11-22T01:00:00Z' })]);
  const old = R.find(r => r.identifier[0].value === '1'), neu = R.find(r => r.identifier[0].value === '2');
  assert.equal(old.status, 'stopped'); assert.match(old.note[0].text, /Changed/); assert.match(old.note[1].text, /Replaced by order 2/); assert.equal(counts.changed, 1);
  assert.deepEqual(neu.priorPrescription, { type: 'MedicationRequest', identifier: { system: 'urn:emr-enhancer:medication-order', value: '1' } }); assert.equal(neu.status, 'active');
});

test('entered in error is kept, with who, when and why; an earlier ending is mentioned', () => {
  const { resources: [r], counts } = build([row({ status: 'entered_in_error', error_by: 'dr_b', error_at: '2026-11-23T00:00:00Z', error_reason: 'wrong patient', ended_at: '2026-11-22T01:00:00Z' })]);
  assert.equal(r.status, 'entered-in-error'); assert.match(r.note[0].text, /dr_b.*wrong patient/); assert.match(r.note[1].text, /had been ended/); assert.equal(counts.enteredInError, 1);
});

test('code is text only by default; an order naming a local drug term is never a Coding; a verifier may add one for free text; junk means not verified', () => {
  const v = () => ({ system: 'http://x.example', code: 'a', display: 'Drug A' });
  const local = build([row({ term_id: 4 })], { verify: v }); assert.equal(local.resources[0].medicationCodeableConcept.coding, undefined); assert.equal(local.counts.codingsOmitted, 1);
  const ok = build([row()], { verify: v }).resources[0]; assert.deepEqual(ok.medicationCodeableConcept.coding, [{ system: 'http://x.example', code: 'a', display: 'Drug A' }]); assert.equal(ok.medicationCodeableConcept.text, 'Drug A');
  for (const verify of [() => { throw new Error('x'); }, () => ({ code: 'a' }), () => 'yes']) assert.equal(build([row()], { verify }).resources[0].medicationCodeableConcept.coding, undefined);
});

test('ordered by authored time then id; any input order gives the same output; input untouched', () => {
  n = 0; const rows = [row({ ordered_at: '2026-11-21T00:00:00Z' }), row({ ordered_at: '2026-11-19T00:00:00Z' }), row({ ordered_at: '2026-11-19T00:00:00Z' })]; const before = JSON.stringify(rows);
  const a = buildFhirMedicationRequests({ patientRef: PT, rows }), b = buildFhirMedicationRequests({ patientRef: PT, rows: [...rows].reverse() });
  assert.deepEqual(a.resources.map(r => r.identifier[0].value), ['2', '3', '1']); assert.deepEqual(a, b); assert.equal(JSON.stringify(rows), before);
});

test('bad input is refused, not guessed: status, missing medication, dose, route or frequency, time, id, patient reference', () => {
  assert.throws(() => build([row({ status: 'weird' })]), FhirExportError);
  for (const k of ['medication', 'dose_text', 'route_text', 'frequency_text']) assert.throws(() => build([row({ [k]: ' ' })]), FhirExportError, k);
  assert.throws(() => build([row({ ordered_at: 'soon' })]), FhirExportError);
  assert.throws(() => build([row({ id: undefined })]), FhirExportError);
  assert.throws(() => buildFhirMedicationRequests({ patientRef: '', rows: [] }), FhirExportError);
  assert.throws(() => buildFhirMedicationRequests({ patientRef: PT, rows: null }), FhirExportError);
});

test('no user ids, case ids or references to people leak into the output', () => {
  const s = JSON.stringify(build([row({ origin_case_id: 5, ordered_by: 9 })]).resources);
  assert.ok(!/origin_case|ordered_by|requester|performer|recorder/.test(s));
});

test('checkMedicationRequest catches the common mistakes', () => {
  const base = { resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: 'p' }, medicationCodeableConcept: { text: 'x' } };
  assert.deepEqual(checkMedicationRequest(base), []);
  assert.ok(checkMedicationRequest({ ...base, intent: undefined }).includes('missing intent'));
  assert.ok(checkMedicationRequest({ ...base, dosageInstruction: [{ doseAndRate: [] }] }).includes('structured dose or timing'));
  assert.ok(checkMedicationRequest({ ...base, medicationCodeableConcept: { coding: [{ code: 'c' }] } }).some(i => /Coding/.test(i)));
});

test('the module is pure: no database, file, network, clock or random', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fhir-medication-request.js'), 'utf8');
  assert.ok(!/require\(|Date\.now|new Date\(\)|Math\.random|process\.|fetch\(|randomUUID/.test(src));
});
