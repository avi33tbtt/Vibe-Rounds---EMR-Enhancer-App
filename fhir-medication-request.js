'use strict';
// Task R6d: FHIR R4 MedicationRequest export from the SERVER's medication orders (medication_orders). Pure: no database, clock, network or random.
// FHIR is the export boundary only; the order list stays the system of record.
// Rules kept here (same as the other fhir-*.js modules):
//  - Dose, route and frequency are free text on the server and stay free text. They are copied word for word into dosageInstruction.text
//    (route also as route.text). Nothing is parsed, normalised, converted or filled in: no doseAndRate, no timing, no units. No dose is ever computed.
//  - A Coding is emitted ONLY when the caller's `verify(row)` returns one. Default: none. A row that names a local drug term (term_id) is never a Coding.
//  - Entered in error is never dropped: status entered-in-error with a note. A changed order is kept as status stopped, with the reason,
//    and its replacement points back to it with priorPrescription (a logical reference by identifier).
//  - The server knows when an ending was RECORDED, not when the drug stopped: it goes in a note, never in a dispense or validity period.
//  - No user ids and no references to people are exported; names given by the caller appear only inside notes.

class FhirExportError extends Error { constructor(m) { super(m); this.name = 'FhirExportError'; } }

const ID_SYSTEM = 'urn:emr-enhancer:medication-order';
const STATUS = { active: 'active', stopped: 'stopped', changed: 'stopped', entered_in_error: 'entered-in-error' };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' && v.trim() ? v : null);

function iso(v, what) {
  const d = v instanceof Date ? v : new Date(v);
  if (v === null || v === undefined || Number.isNaN(d.getTime())) throw new FhirExportError(what + ' is not a valid time');
  return d.toISOString();
}

// rows: id, term_id, medication, dose_text, route_text, frequency_text, indication_text, status, replaces_order_id, ordered_at,
//       ended_by, ended_at, end_reason, error_by, error_at, error_reason.
function buildFhirMedicationRequests({ patientRef, rows, verify } = {}) {
  if (typeof patientRef !== 'string' || !patientRef.trim()) throw new FhirExportError('patientRef is required');
  if (!Array.isArray(rows)) throw new FhirExportError('rows must be a list');
  const verifier = typeof verify === 'function' ? verify : () => null;
  const counts = { exported: 0, stopped: 0, changed: 0, enteredInError: 0, codingsOmitted: 0 };
  const replacedBy = new Map();
  for (const p of rows) if (isObj(p) && p.replaces_order_id !== null && p.replaces_order_id !== undefined) replacedBy.set(Number(p.replaces_order_id), p.id);
  const resources = [];
  for (const p of [...rows].sort((a, b) => (Date.parse(a && a.ordered_at) - Date.parse(b && b.ordered_at)) || (Number(a && a.id) - Number(b && b.id)))) {
    if (!isObj(p)) throw new FhirExportError('a row must be an object');
    if (p.id === undefined || p.id === null) throw new FhirExportError('an order needs its id');
    if (!STATUS[p.status]) throw new FhirExportError('unknown status on order ' + p.id);
    for (const k of ['medication', 'dose_text', 'route_text', 'frequency_text']) if (!text(p[k])) throw new FhirExportError('order ' + p.id + ' has no ' + k);
    let c = null;
    if (p.term_id !== null && p.term_id !== undefined) counts.codingsOmitted++;      // names a local term: never a Coding
    else { try { c = verifier(p); } catch (e) { c = null; } }
    const ok = isObj(c) && typeof c.system === 'string' && c.system && typeof c.code === 'string' && c.code;
    if (c && !ok) counts.codingsOmitted++;
    const r = {
      resourceType: 'MedicationRequest',
      identifier: [{ system: ID_SYSTEM, value: String(p.id) }],
      status: STATUS[p.status],
      intent: 'order',
      medicationCodeableConcept: ok ? { coding: [c.display ? { system: c.system, code: c.code, display: c.display } : { system: c.system, code: c.code }], text: p.medication } : { text: p.medication },
      subject: { reference: patientRef },
      authoredOn: iso(p.ordered_at, 'ordered_at of order ' + p.id),
      dosageInstruction: [{ text: 'Dose: ' + p.dose_text + '. Route: ' + p.route_text + '. Frequency: ' + p.frequency_text + '.', route: { text: p.route_text } }],
    };
    if (text(p.indication_text)) r.reasonCode = [{ text: p.indication_text }];
    if (p.replaces_order_id !== null && p.replaces_order_id !== undefined) r.priorPrescription = { type: 'MedicationRequest', identifier: { system: ID_SYSTEM, value: String(p.replaces_order_id) } };
    const notes = [];
    if (p.status === 'stopped' || p.status === 'changed') {
      counts[p.status]++;
      if (text(p.end_reason)) r.statusReason = { text: p.end_reason };
      notes.push((p.status === 'changed' ? 'Changed' : 'Stopped') + ' (recorded by ' + (text(p.ended_by) || 'unknown') + (p.ended_at ? ' at ' + iso(p.ended_at, 'ended_at') : '') + ')' + (p.end_reason ? ': ' + p.end_reason : ''));
      if (p.status === 'changed' && replacedBy.has(Number(p.id))) notes.push('Replaced by order ' + replacedBy.get(Number(p.id)));
    } else if (p.status === 'entered_in_error') {
      counts.enteredInError++;
      notes.push('Entered in error by ' + (text(p.error_by) || 'unknown') + (p.error_at ? ' at ' + iso(p.error_at, 'error_at') : '') + (p.error_reason ? ': ' + p.error_reason : ''));
      if (p.ended_at) notes.push('It had been ended (recorded at ' + iso(p.ended_at, 'ended_at') + ') before it was entered in error.');
    }
    if (notes.length) r.note = notes.map(t => ({ text: t }));
    resources.push(r);
    counts.exported++;
  }
  return { resources, counts };
}

// Minimum check: status, intent, subject, medication, and no structured dose or timing (those are never produced here).
function checkMedicationRequest(r) {
  const issues = [];
  if (!isObj(r) || r.resourceType !== 'MedicationRequest') return ['not a MedicationRequest'];
  for (const k of ['status', 'intent', 'subject', 'medicationCodeableConcept']) if (r[k] === undefined || r[k] === null) issues.push('missing ' + k);
  for (const d of (r.dosageInstruction || [])) if (d.doseAndRate || d.timing || d.asNeededBoolean !== undefined) issues.push('structured dose or timing');
  if (r.medicationCodeableConcept && r.medicationCodeableConcept.coding) for (const c of r.medicationCodeableConcept.coding) if (!c.system || !c.code) issues.push('a Coding without system or code');
  return issues;
}

module.exports = { buildFhirMedicationRequests, checkMedicationRequest, FhirExportError };
