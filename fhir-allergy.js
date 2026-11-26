'use strict';
// Task R6c: FHIR R4 AllergyIntolerance export from the SERVER's allergy rows (patient_allergies). Pure: no database, clock, network or random.
// FHIR is the export boundary only; the allergy list stays the system of record.
// Rules kept here (same as fhir-condition.js):
//  - A Coding is emitted ONLY when the caller's `verify(row)` returns one. Default: none, so code is the clinician's own words as text.
//  - An entered-in-error allergy is never dropped: verificationStatus = entered-in-error, no clinicalStatus, with a note (who, when, why).
//  - Resolution is a note, not an abatement claim (the server knows when it was recorded, not when the allergy ended).
//  - Nothing is invented: no type, category or criticality (severity of a reaction is not criticality). Unrecorded reaction or severity stays absent.
//  - FHIR needs a manifestation inside `reaction`; a severity with no recorded reaction therefore goes in a note and is counted, not into a made-up reaction.
//  - No user ids and no references to people are exported; names given by the caller appear only inside notes.

class FhirExportError extends Error { constructor(m) { super(m); this.name = 'FhirExportError'; } }

const ID_SYSTEM = 'urn:emr-enhancer:allergy';
const CLIN = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const VER = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';
const SEVERITY = ['mild', 'moderate', 'severe'];
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
const text = v => (typeof v === 'string' && v.trim() ? v : null);

// rows: id, substance, reaction, severity, onset_date, status, recorded_at, resolved_by, resolved_at, resolution_reason, error_by, error_at, error_reason.
function buildFhirAllergies({ patientRef, rows, verify } = {}) {
  if (typeof patientRef !== 'string' || !patientRef.trim()) throw new FhirExportError('patientRef is required');
  if (!Array.isArray(rows)) throw new FhirExportError('rows must be a list');
  const verifier = typeof verify === 'function' ? verify : () => null;
  const counts = { exported: 0, resolved: 0, enteredInError: 0, onsetUnknown: 0, codingsOmitted: 0, severityWithoutReaction: 0 };
  const resources = [];
  for (const p of [...rows].sort((a, b) => (Date.parse(a && a.recorded_at) - Date.parse(b && b.recorded_at)) || (Number(a && a.id) - Number(b && b.id)))) {
    if (!isObj(p)) throw new FhirExportError('a row must be an object');
    if (p.id === undefined || p.id === null) throw new FhirExportError('an allergy needs its id');
    if (!['active', 'resolved', 'entered_in_error'].includes(p.status)) throw new FhirExportError('unknown status on allergy ' + p.id);
    if (!text(p.substance)) throw new FhirExportError('allergy ' + p.id + ' has no substance');
    if (p.severity !== null && p.severity !== undefined && !SEVERITY.includes(p.severity)) throw new FhirExportError('unknown severity on allergy ' + p.id);
    let c = null;
    try { c = verifier(p); } catch (e) { c = null; }
    const ok = isObj(c) && typeof c.system === 'string' && c.system && typeof c.code === 'string' && c.code;
    if (c && !ok) counts.codingsOmitted++;
    const r = {
      resourceType: 'AllergyIntolerance',
      identifier: [{ system: ID_SYSTEM, value: String(p.id) }],
      code: ok ? { coding: [c.display ? { system: c.system, code: c.code, display: c.display } : { system: c.system, code: c.code }], text: p.substance } : { text: p.substance },
      patient: { reference: patientRef },
      recordedDate: iso(p.recorded_at, 'recorded_at of allergy ' + p.id),
    };
    const onset = dateOnly(p.onset_date, 'onset_date of allergy ' + p.id);
    if (onset) r.onsetDateTime = onset; else counts.onsetUnknown++;
    const notes = [];
    const reaction = text(p.reaction), sev = p.severity || null;
    if (reaction) r.reaction = [sev ? { manifestation: [{ text: reaction }], severity: sev } : { manifestation: [{ text: reaction }] }];
    else if (sev) { counts.severityWithoutReaction++; notes.push('Severity recorded as ' + sev + ' with no reaction described.'); }
    if (p.status === 'entered_in_error') {
      r.verificationStatus = { coding: [{ system: VER, code: 'entered-in-error' }] };
      counts.enteredInError++;
      notes.push('Entered in error by ' + (text(p.error_by) || 'unknown') + (p.error_at ? ' at ' + iso(p.error_at, 'error_at') : '') + (p.error_reason ? ': ' + p.error_reason : ''));
      if (p.resolved_at) notes.push('It had been marked resolved at ' + iso(p.resolved_at, 'resolved_at') + ' before it was entered in error.');
    } else {
      r.clinicalStatus = { coding: [{ system: CLIN, code: p.status }] };
      if (p.status === 'resolved') {
        counts.resolved++;
        notes.push('Resolution recorded by ' + (text(p.resolved_by) || 'unknown') + (p.resolved_at ? ' at ' + iso(p.resolved_at, 'resolved_at') : '') + (p.resolution_reason ? ': ' + p.resolution_reason : ''));
      }
    }
    if (notes.length) r.note = notes.map(t => ({ text: t }));
    resources.push(r);
    counts.exported++;
  }
  return { resources, counts };
}

// Minimum check: patient and code always; clinicalStatus unless entered in error; a reaction always has a manifestation.
function checkAllergy(r) {
  const issues = [];
  if (!isObj(r) || r.resourceType !== 'AllergyIntolerance') return ['not an AllergyIntolerance'];
  for (const k of ['patient', 'code']) if (r[k] === undefined || r[k] === null) issues.push('missing ' + k);
  const err = !!(r.verificationStatus && r.verificationStatus.coding && r.verificationStatus.coding.some(c => c.code === 'entered-in-error'));
  if (!err && !r.clinicalStatus) issues.push('missing clinicalStatus');
  if (err && r.clinicalStatus) issues.push('clinicalStatus with entered-in-error');
  for (const x of (r.reaction || [])) if (!Array.isArray(x.manifestation) || !x.manifestation.length) issues.push('reaction without manifestation');
  if (r.code && r.code.coding) for (const c of r.code.coding) if (!c.system || !c.code) issues.push('a Coding without system or code');
  return issues;
}

module.exports = { buildFhirAllergies, checkAllergy, FhirExportError };
