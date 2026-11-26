'use strict';
// Row R6g: representative rows for every FHIR export (R6a to R6d), run through the real builders. Pure; used by the conformance test and by the optional validator run.
// Covers the awkward cases on purpose: unknown, zero and false values, a correction, entered in error, resolved, stopped, changed.
const { buildFhirObservations } = require('../fhir-observation');
const { buildFhirConditions } = require('../fhir-condition');
const { buildFhirAllergies } = require('../fhir-allergy');
const { buildFhirMedicationRequests } = require('../fhir-medication-request');

const PT = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const DEF = { fields: [
  { id: 'hr', label: 'Heart rate', type: 'number' }, { id: 'cnt', label: 'Count', type: 'integer' }, { id: 'alert', label: 'Alert', type: 'boolean' },
  { id: 'avpu', label: 'AVPU', type: 'select' }, { id: 'note', label: 'Comment', type: 'text' }, { id: 'when', label: 'Onset', type: 'datetime' } ] };
const SETS = [{ id: 7, slug: 'vitals_set', version: 1, definition_json: DEF }];
let n;
const obs = o => ({ id: ++n, applied_set_id: 7, field_key: 'hr', value_type: 'number', value_json: 88, unit_display: 'bpm', effective_at: '2026-11-23T07:30:00.000Z', recorded_at: '2026-11-23T07:31:00.000Z',
  source_type: 'clinician', status: 'final', corrects_id: null, change_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const cond = o => ({ id: ++n, label: 'Type 2 diabetes', onset_date: '2020-03-01', status: 'active', recorded_at: '2026-11-20T08:00:00.000Z', local_term_code: null,
  resolved_by: null, resolved_at: null, resolution_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const algy = o => ({ id: ++n, substance: 'Penicillin', reaction: 'Rash', severity: 'moderate', onset_date: '2015-06-01', status: 'active', recorded_at: '2026-11-20T08:00:00.000Z',
  resolved_by: null, resolved_at: null, resolution_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const med = o => ({ id: ++n, term_id: null, medication: 'Drug A', dose_text: 'as written by the doctor', route_text: 'by mouth', frequency_text: 'twice a day', indication_text: null, status: 'active',
  replaces_order_id: null, ordered_at: '2026-11-20T08:00:00.000Z', ended_by: null, ended_at: null, end_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const err = { error_by: 'doc', error_at: '2026-11-24T09:00:00.000Z', error_reason: 'Wrong patient' };

function fixtures() {
  const out = [];
  const add = (kind, list) => list.resources.forEach((r, i) => out.push({ kind, name: `${kind}-${i + 1}`, resource: r }));
  n = 0; add('Observation', buildFhirObservations({ patientRef: PT, sets: SETS, rows: [obs({ value_json: 0 }), obs({ field_key: 'alert', value_type: 'boolean', value_json: false, unit_display: null }),
    obs({ field_key: 'cnt', value_type: 'integer', value_json: 3, unit_display: null }), obs({ field_key: 'avpu', value_type: 'select', value_json: 'Alert', unit_display: null }),
    obs({ field_key: 'note', value_type: 'text', value_json: 'ok', unit_display: null }), obs({ value_type: 'unknown', value_json: null, unit_display: null }),
    obs({ status: 'preliminary', source_type: 'imported' }), obs({ status: 'entered_in_error', ...err })] }));
  n = 0; add('Condition', buildFhirConditions({ patientRef: PT, rows: [cond(), cond({ onset_date: null }), cond({ status: 'resolved', resolved_by: 'doc', resolved_at: '2026-11-22T08:00:00.000Z', resolution_reason: 'Resolved' }), cond({ status: 'entered_in_error', ...err })] }));
  n = 0; add('AllergyIntolerance', buildFhirAllergies({ patientRef: PT, rows: [algy(), algy({ reaction: null, severity: null, onset_date: null }), algy({ status: 'resolved', resolved_by: 'doc', resolved_at: '2026-11-22T08:00:00.000Z', resolution_reason: 'Resolved' }), algy({ status: 'entered_in_error', ...err })] }));
  n = 0; add('MedicationRequest', buildFhirMedicationRequests({ patientRef: PT, rows: [med(), med({ indication_text: 'Fever' }), med({ status: 'stopped', ended_by: 'doc', ended_at: '2026-11-22T08:00:00.000Z', end_reason: 'Course done' }),
    med({ status: 'changed', replaces_order_id: null }), med({ status: 'entered_in_error', ...err })] }));
  return out;
}
module.exports = { fixtures, PT };
