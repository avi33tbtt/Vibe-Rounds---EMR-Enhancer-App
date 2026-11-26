'use strict';
// Row R6g-1: offline conformance checks on every FHIR export (R6a to R6d), run on the shared fixtures. No network, no database, no Java.
// These are the structural rules of FHIR R4 that the public HL7 validator checks first (required elements, no empty elements, valid dates, well-formed Codings,
// the invariants that apply to these four resources). They do NOT replace the validator: the real run is R6g-2 (scripts/validate-fhir.js on a machine with the jar).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtures, PT } = require('./fhir-conformance-fixtures');
const { checkObservation } = require('../fhir-observation');
const { checkCondition } = require('../fhir-condition');
const { checkAllergy } = require('../fhir-allergy');
const { checkMedicationRequest } = require('../fhir-medication-request');

const ALL = fixtures();
const CHECK = { Observation: checkObservation, Condition: checkCondition, AllergyIntolerance: checkAllergy, MedicationRequest: checkMedicationRequest };
const KINDS = Object.keys(CHECK);
const RE = {
  date: /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/,
  dateTime: /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00)))?)?)?$/,
  instant: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00))$/,
  id: /^[A-Za-z0-9\-.]{1,64}$/ };
const DATE_KEYS = { date: ['onsetDate', 'recordedDate'], instant: ['issued'], dateTime: ['effectiveDateTime', 'onsetDateTime', 'authoredOn', 'abatementDateTime', 'recordedDate', 'date'] };
const walk = (v, f, p = '$') => { f(v, p); if (Array.isArray(v)) v.forEach((x, i) => walk(x, f, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], f, `${p}.${k}`); };
const has = (r, re) => Object.keys(r).some(k => re.test(k));
const code = cc => cc && cc.coding && cc.coding[0] && cc.coding[0].code;
const of = kind => ALL.filter(x => x.kind === kind);

test('fixtures cover all four exports, including the awkward rows (unknown, zero, false, corrected, resolved, stopped, changed, entered in error)', () => {
  assert.deepEqual([...new Set(ALL.map(x => x.kind))].sort(), [...KINDS].sort());
  for (const k of KINDS) assert.ok(of(k).length >= 4, k + ' has enough fixtures');
  for (const k of KINDS) assert.equal(of(k).filter(x => x.resource.status === 'entered-in-error' || (x.resource.verificationStatus && code(x.resource.verificationStatus) === 'entered-in-error')).length, 1, k + ': the entered-in-error row is exported, not dropped');
});

test('every resource passes its own export check and has the right resourceType, a valid id and the chosen patient', () => {
  for (const { kind, name, resource: r } of ALL) {
    assert.equal(r.resourceType, kind, name);
    assert.deepEqual(CHECK[kind](r), [], name + ' own check');
    if (r.id !== undefined) assert.match(String(r.id), RE.id, name + ' id');
    const ref = (r.subject || r.patient || {}).reference;
    assert.equal(ref, PT, name + ' patient reference');
  }
});

test('R4 required elements are present on every resource', () => {
  for (const { kind, name, resource: r } of ALL) {
    if (kind === 'Observation') { assert.ok(r.status, name + ' status'); assert.ok(r.code, name + ' code'); }
    if (kind === 'Condition') assert.ok(r.subject, name + ' subject');
    if (kind === 'AllergyIntolerance') assert.ok(r.patient, name + ' patient');
    if (kind === 'MedicationRequest') { assert.ok(r.status, name + ' status'); assert.ok(r.intent, name + ' intent'); assert.ok(r.subject, name + ' subject'); assert.ok(has(r, /^medication(CodeableConcept|Reference)$/), name + ' medication[x]'); }
  }
});

test('no empty element anywhere: no null, empty string, empty list or empty object (FHIR forbids them); the JSON round-trips unchanged', () => {
  for (const { name, resource: r } of ALL) {
    walk(r, (v, p) => {
      assert.notEqual(v, null, name + ' null at ' + p); assert.notEqual(v, undefined, name + ' undefined at ' + p);
      if (typeof v === 'string') assert.ok(v.trim() === v && v.length > 0, name + ' empty or padded string at ' + p);
      if (Array.isArray(v)) assert.ok(v.length > 0, name + ' empty list at ' + p);
      if (v && typeof v === 'object' && !Array.isArray(v)) assert.ok(Object.keys(v).length > 0, name + ' empty object at ' + p);
    });
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r, name + ' round trip');
  }
});

test('every date, dateTime and instant is a valid FHIR value; a dateTime with a time always carries a zone', () => {
  for (const { name, resource: r } of ALL) walk(r, (v, p) => {
    const key = p.split('.').pop().replace(/\[\d+\]$/, '');
    if (typeof v !== 'string') return;
    if (key === 'issued') assert.match(v, RE.instant, name + ' ' + p);
    else if (['effectiveDateTime', 'onsetDateTime', 'authoredOn', 'abatementDateTime', 'recordedDate'].includes(key)) assert.match(v, RE.dateTime, name + ' ' + p);
    else if (key === 'onsetDate') assert.match(v, RE.date, name + ' ' + p);
    if (/T/.test(v) && /^\d{4}-/.test(v)) assert.match(v, /(Z|[+-]\d{2}:\d{2})$/, name + ' ' + p + ' has no zone');
  });
});

test('every Coding has a system and a code; the system is a URL or URN; no local or unverified code is ever a Coding', () => {
  let seen = 0;
  for (const { name, resource: r } of ALL) walk(r, (v, p) => {
    if (!v || typeof v !== 'object' || !Array.isArray(v.coding)) return;
    v.coding.forEach(c => { seen++; assert.ok(c.system && c.code, name + ' ' + p + ' coding needs system and code'); assert.match(c.system, /^(https?:\/\/|urn:)/, name + ' system'); assert.ok(!/local|demo|emr-enhancer/i.test(c.system + c.code), name + ' local code leaked: ' + c.system + ' ' + c.code); });
  });
  assert.ok(seen > 0, 'the status codings are checked');
  for (const { name, resource: r } of ALL.filter(x => x.kind === 'Observation')) assert.equal(r.code.coding, undefined, name + ': the observation code is text only without a verifier');
});

test('R4 invariants for these resources: Condition con-3/con-4, AllergyIntolerance ait-2, Observation obs-6/obs-7 (a value and a reason for no value never together)', () => {
  for (const { name, resource: r } of of('Condition')) {
    if (code(r.verificationStatus) !== 'entered-in-error') assert.ok(r.clinicalStatus, name + ' clinicalStatus (con-3)');
    if (has(r, /^abatement/)) assert.ok(['resolved', 'remission', 'inactive'].includes(code(r.clinicalStatus)), name + ' abatement needs a resolved status (con-4)');
  }
  for (const { name, resource: r } of of('AllergyIntolerance')) {
    if (code(r.verificationStatus) !== 'entered-in-error') assert.ok(r.clinicalStatus, name + ' clinicalStatus (ait-2)');
  }
  for (const { name, resource: r } of of('Observation')) {
    const vals = Object.keys(r).filter(k => /^value[A-Z]/.test(k));
    assert.ok(vals.length <= 1, name + ' more than one value[x]');
    assert.ok(!(vals.length && r.dataAbsentReason), name + ' value and dataAbsentReason together (obs-6)');
  }
});

test('the safety shapes survive: unknown has dataAbsentReason and no value, zero and false stay, a unit is text only, entered in error keeps a note', () => {
  const O = of('Observation').map(x => x.resource);
  assert.equal(O[0].valueQuantity.value, 0); assert.equal(O[1].valueBoolean, false);
  const u = O.find(r => r.dataAbsentReason); assert.ok(u && !Object.keys(u).some(k => k.startsWith('value')), 'unknown: reason, no value'); assert.equal(code(u.dataAbsentReason), 'unknown');
  for (const r of O.filter(r => r.valueQuantity)) assert.equal(r.valueQuantity.system, undefined, 'no unit code invented');
  for (const k of KINDS) { const e = of(k).map(x => x.resource).find(r => r.status === 'entered-in-error' || code(r.verificationStatus) === 'entered-in-error'); assert.ok(e && Array.isArray(e.note) && e.note.length, k + ' entered in error keeps a note'); }
});
