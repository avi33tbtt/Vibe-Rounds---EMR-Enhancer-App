'use strict';
// Task R6b: FHIR R4 Condition export from the SERVER's problem rows (patient_problems). Pure: no database, clock, network or random.
// FHIR is the export boundary only; the problem list stays the system of record.
// Rules kept here (same as fhir-observation.js):
//  - A Coding is emitted ONLY when the caller's `verify(row)` returns one. Default: none, so code is the clinician's own words as text.
//    The reserved local_term_code is never a Coding, whatever the verifier says.
//  - An entered-in-error problem is never dropped: verificationStatus = entered-in-error, no clinicalStatus (FHIR rule con-3), with a note.
//  - Resolution is not turned into abatementDateTime: the server knows when the resolution was RECORDED, not when the condition ended. It goes in a note.
//  - onsetDateTime is the date the clinician gave, as a date only; unknown stays absent. recordedDate keeps the recording time apart.
//  - No user ids and no references to people are exported; names given by the caller appear only inside notes.

class FhirExportError extends Error { constructor(m) { super(m); this.name = 'FhirExportError'; } }

const ID_SYSTEM = 'urn:emr-enhancer:problem';
const CLIN = 'http://terminology.hl7.org/CodeSystem/condition-clinical';
const VER = 'http://terminology.hl7.org/CodeSystem/condition-ver-status';
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function iso(v, what) {
  const d = v instanceof Date ? v : new Date(v);
  if (v === null || v === undefined || Number.isNaN(d.getTime())) throw new FhirExportError(what + ' is not a valid time');
  return d.toISOString();
}
function dateOnly(v, what) {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'string' && DATE.test(v) ? new Date(v + 'T00:00:00Z') : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new FhirExportError(what + ' is not a valid date');
  return v;
}

// rows: id, label, onset_date ('YYYY-MM-DD' or null), status, recorded_at, local_term_code, resolved_by, resolved_at, resolution_reason, error_by, error_at, error_reason.
function buildFhirConditions({ patientRef, rows, verify } = {}) {
  if (typeof patientRef !== 'string' || !patientRef.trim()) throw new FhirExportError('patientRef is required');
  if (!Array.isArray(rows)) throw new FhirExportError('rows must be a list');
  const verifier = typeof verify === 'function' ? verify : () => null;
  const counts = { exported: 0, resolved: 0, enteredInError: 0, onsetUnknown: 0, codingsOmitted: 0 };
  const resources = [];
  for (const p of [...rows].sort((a, b) => (Date.parse(a && a.recorded_at) - Date.parse(b && b.recorded_at)) || (Number(a && a.id) - Number(b && b.id)))) {
    if (!isObj(p)) throw new FhirExportError('a row must be an object');
    if (p.id === undefined || p.id === null) throw new FhirExportError('a problem needs its id');
    if (!['active', 'resolved', 'entered_in_error'].includes(p.status)) throw new FhirExportError('unknown status on problem ' + p.id);
    if (typeof p.label !== 'string' || !p.label.trim()) throw new FhirExportError('problem ' + p.id + ' has no label');
    let c = null;
    if (p.local_term_code) counts.codingsOmitted++;                                  // reserved local code: never a Coding
    else { try { c = verifier(p); } catch (e) { c = null; } }
    const ok = isObj(c) && typeof c.system === 'string' && c.system && typeof c.code === 'string' && c.code;
    if (c && !ok) counts.codingsOmitted++;
    const r = {
      resourceType: 'Condition',
      identifier: [{ system: ID_SYSTEM, value: String(p.id) }],
      code: ok ? { coding: [c.display ? { system: c.system, code: c.code, display: c.display } : { system: c.system, code: c.code }], text: p.label } : { text: p.label },
      subject: { reference: patientRef },
      recordedDate: iso(p.recorded_at, 'recorded_at of problem ' + p.id),
    };
    const onset = dateOnly(p.onset_date, 'onset_date of problem ' + p.id);
    if (onset) r.onsetDateTime = onset; else counts.onsetUnknown++;
    const notes = [];
    if (p.status === 'entered_in_error') {
      r.verificationStatus = { coding: [{ system: VER, code: 'entered-in-error' }] };
      counts.enteredInError++;
      notes.push('Entered in error by ' + (typeof p.error_by === 'string' && p.error_by ? p.error_by : 'unknown') + (p.error_at ? ' at ' + iso(p.error_at, 'error_at') : '') + (p.error_reason ? ': ' + p.error_reason : ''));
      if (p.resolved_at) notes.push('It had been marked resolved at ' + iso(p.resolved_at, 'resolved_at') + ' before it was entered in error.');
    } else {
      r.clinicalStatus = { coding: [{ system: CLIN, code: p.status }] };
      if (p.status === 'resolved') {
        counts.resolved++;
        notes.push('Resolution recorded by ' + (typeof p.resolved_by === 'string' && p.resolved_by ? p.resolved_by : 'unknown') + (p.resolved_at ? ' at ' + iso(p.resolved_at, 'resolved_at') : '') + (p.resolution_reason ? ': ' + p.resolution_reason : ''));
      }
    }
    if (notes.length) r.note = notes.map(text => ({ text }));
    resources.push(r);
    counts.exported++;
  }
  return { resources, counts };
}

// Minimum check: subject and code always; clinicalStatus unless entered in error (con-3); never both an in-error verificationStatus and a clinicalStatus.
function checkCondition(r) {
  const issues = [];
  if (!isObj(r) || r.resourceType !== 'Condition') return ['not a Condition'];
  for (const k of ['subject', 'code']) if (r[k] === undefined || r[k] === null) issues.push('missing ' + k);
  const err = !!(r.verificationStatus && r.verificationStatus.coding && r.verificationStatus.coding.some(c => c.code === 'entered-in-error'));
  if (!err && !r.clinicalStatus) issues.push('missing clinicalStatus');
  if (err && r.clinicalStatus) issues.push('clinicalStatus with entered-in-error');
  if (r.code && r.code.coding) for (const c of r.code.coding) if (!c.system || !c.code) issues.push('a Coding without system or code');
  return issues;
}

module.exports = { buildFhirConditions, checkCondition, FhirExportError };
