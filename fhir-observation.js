'use strict';
// Task R6a: FHIR R4 Observation export from the SERVER's observation rows. Pure: no database, no clock, no network, no random.
// FHIR is the export boundary only; the internal rows stay the system of record (core rules).
// Rules kept here:
//  - A Coding is emitted ONLY when the caller's `verify(binding)` returns one. The default verifier returns nothing, so by default every
//    code is text only. A `local` binding is never a Coding, whatever the verifier says (local codes are never exported as FHIR Coding).
//  - Nothing is coerced: an explicitly unknown value has no value[x] and carries dataAbsentReason (never null, never 0); false stays false.
//  - A row entered in error is never dropped: it is exported with status entered-in-error and a note (who, when, why).
//  - No unit code is invented: valueQuantity carries the unit text only (the server has no unit verifier yet).
//  - A date-time with no zone is not turned into an invalid or guessed FHIR dateTime: it is exported as text and counted.
//  - Effective time (effectiveDateTime) and recorded time (issued) stay separate. No clinician names or ids are exported as references.

class FhirExportError extends Error { constructor(m) { super(m); this.name = 'FhirExportError'; } }

const STATUS = { preliminary: 'preliminary', final: 'final', amended: 'corrected', entered_in_error: 'entered-in-error' };
const SOURCES = ['patient', 'clinician', 'imported', 'device', 'derived', 'ai_proposed'];
const TYPES = ['text', 'number', 'integer', 'boolean', 'datetime', 'select', 'unknown'];
const ID_SYSTEM = 'urn:emr-enhancer:observation';
const SOURCE_TAG = 'urn:emr-enhancer:source-type';
const DAR = 'http://terminology.hl7.org/CodeSystem/data-absent-reason';
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function iso(v, what) {
  const d = v instanceof Date ? v : new Date(v);
  if (v === null || v === undefined || Number.isNaN(d.getTime())) throw new FhirExportError(what + ' is not a valid time');
  return d.toISOString();
}

// Label and verified codings for each applied set and field. sets: [{ id (applied set id), slug, version, definition_json }].
function fieldIndex(sets) {
  const m = new Map();
  for (const s of (Array.isArray(sets) ? sets : [])) {
    if (!isObj(s)) continue;
    const fields = new Map();
    for (const f of (isObj(s.definition_json) && Array.isArray(s.definition_json.fields) ? s.definition_json.fields : [])) if (isObj(f) && typeof f.id === 'string') fields.set(f.id, f);
    m.set(Number(s.id), fields);
  }
  return m;
}

function codingsOf(field, verify, counts) {
  if (!field) return [];
  const bs = [...(Array.isArray(field.bindings) ? field.bindings : []), ...(isObj(field.coding) ? [field.coding] : [])].filter(isObj);
  const out = [], seen = new Set();
  for (const b of bs) {
    let c = null;
    if (b.system !== 'local') { try { c = verify(b); } catch (e) { c = null; } }       // a failing verifier means "not verified"
    if (isObj(c) && typeof c.system === 'string' && c.system && typeof c.code === 'string' && c.code && !seen.has(c.system + '|' + c.code)) {
      seen.add(c.system + '|' + c.code);
      out.push(c.display ? { system: c.system, code: c.code, display: c.display } : { system: c.system, code: c.code });
    } else counts.codingsOmitted++;
  }
  return out;
}

// rows: observations as stored (id, applied_set_id, field_key, value_type, value_json, unit_display, effective_at, recorded_at, source_type, status,
//        corrects_id, change_reason, error_by, error_at, error_reason). patientRef: the Patient reference the caller puts in `subject`.
// Returns { resources, counts }. Input is not changed.
function buildFhirObservations({ patientRef, rows, sets = [], verify } = {}) {
  if (typeof patientRef !== 'string' || !patientRef.trim()) throw new FhirExportError('patientRef is required');
  if (!Array.isArray(rows)) throw new FhirExportError('rows must be a list');
  const verifier = typeof verify === 'function' ? verify : () => null;
  const idx = fieldIndex(sets);
  const counts = { exported: 0, enteredInError: 0, unknown: 0, codingsOmitted: 0, datetimeNoZone: 0, fieldsUnresolved: 0 };
  const correctedBy = new Map();
  for (const r of rows) if (isObj(r) && r.corrects_id !== null && r.corrects_id !== undefined) correctedBy.set(Number(r.corrects_id), r.id);
  const resources = [];
  for (const o of [...rows].sort((a, b) => (Date.parse(a && a.effective_at) - Date.parse(b && b.effective_at)) || (Number(a && a.id) - Number(b && b.id)))) {
    if (!isObj(o)) throw new FhirExportError('a row must be an object');
    if (!STATUS[o.status]) throw new FhirExportError('unknown status on observation ' + o.id);
    if (!TYPES.includes(o.value_type)) throw new FhirExportError('unknown value_type on observation ' + o.id);
    if (!SOURCES.includes(o.source_type)) throw new FhirExportError('unknown source_type on observation ' + o.id);
    if (o.id === undefined || o.id === null) throw new FhirExportError('an observation needs its id');
    const field = (idx.get(Number(o.applied_set_id)) || new Map()).get(o.field_key) || null;
    if (!field) counts.fieldsUnresolved++;
    const codings = codingsOf(field, verifier, counts);
    const label = field && typeof field.label === 'string' && field.label ? field.label : String(o.field_key);
    const r = {
      resourceType: 'Observation',
      meta: { tag: [{ system: SOURCE_TAG, code: o.source_type }] },
      identifier: [{ system: ID_SYSTEM, value: String(o.id) }],
      status: STATUS[o.status],
      code: codings.length ? { coding: codings, text: label } : { text: label },
      subject: { reference: patientRef },
      effectiveDateTime: iso(o.effective_at, 'effective_at of observation ' + o.id),
      issued: iso(o.recorded_at, 'recorded_at of observation ' + o.id),
    };
    const notes = [];
    switch (o.value_type) {
      case 'unknown':
        r.dataAbsentReason = { coding: [{ system: DAR, code: 'unknown' }] }; counts.unknown++; break;
      case 'number': r.valueQuantity = o.unit_display ? { value: o.value_json, unit: o.unit_display } : { value: o.value_json }; break;
      case 'integer': r.valueInteger = o.value_json; break;
      case 'boolean': r.valueBoolean = o.value_json; break;
      case 'datetime':
        if (typeof o.value_json === 'string' && (ZONED.test(o.value_json) || DATE.test(o.value_json))) r.valueDateTime = o.value_json;
        else { r.valueString = String(o.value_json); counts.datetimeNoZone++; notes.push('Date and time recorded without a time zone; exported as text.'); }
        break;
      default: r.valueString = o.value_json;                                          // text and select
    }
    if (o.corrects_id !== null && o.corrects_id !== undefined) notes.push('Corrects observation ' + o.corrects_id + (o.change_reason ? ': ' + o.change_reason : ''));
    if (correctedBy.has(Number(o.id)) && o.status !== 'entered_in_error') notes.push('Corrected by observation ' + correctedBy.get(Number(o.id)));
    if (o.status === 'entered_in_error') {
      counts.enteredInError++;
      notes.push('Entered in error by ' + (o.error_by || 'unknown') + (o.error_at ? ' at ' + iso(o.error_at, 'error_at') : '') + (o.error_reason ? ': ' + o.error_reason : ''));
    }
    if (notes.length) r.note = notes.map(text => ({ text }));
    resources.push(r);
    counts.exported++;
  }
  return { resources, counts };
}

// The same minimum the page checks before it shows a Bundle: status, code, subject, and a value or a reason for none.
function checkObservation(r) {
  const issues = [];
  if (!isObj(r) || r.resourceType !== 'Observation') return ['not an Observation'];
  for (const k of ['status', 'code', 'subject']) if (r[k] === undefined || r[k] === null) issues.push('missing ' + k);
  const hasValue = Object.keys(r).some(k => k.startsWith('value'));
  if (!hasValue && !r.dataAbsentReason) issues.push('no value and no dataAbsentReason');
  if (hasValue && r.dataAbsentReason) issues.push('value and dataAbsentReason together');
  if (r.code && r.code.coding) for (const c of r.code.coding) if (!c.system || !c.code) issues.push('a Coding without system or code');
  return issues;
}

module.exports = { buildFhirObservations, checkObservation, FhirExportError };
