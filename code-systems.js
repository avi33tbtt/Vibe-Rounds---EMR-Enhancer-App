'use strict';
// Phase P, P1b: the standard code systems the app knows about. Data only: no codes, no logic.
// ids match code_systems.id (009_code_systems.sql). Licence notes are plain pointers, not legal advice: check your own terms of use.
const CODE_SYSTEMS = [
  { id: 'snomed', uri: 'http://snomed.info/sct', name: 'SNOMED CT', kind: 'standard',
    licence_note: 'Use may need a licence or national membership. Check the arrangement that applies to your facility.' },
  { id: 'loinc', uri: 'http://loinc.org', name: 'LOINC', kind: 'standard',
    licence_note: 'Distributed under the LOINC licence. Check its current terms before use.' },
  { id: 'icd10', uri: 'http://hl7.org/fhir/sid/icd-10', name: 'ICD-10', kind: 'standard',
    licence_note: 'WHO classification; national versions may differ. Check the terms of use that apply to you.' },
  { id: 'icd11', uri: 'http://id.who.int/icd/release/11/mms', name: 'ICD-11', kind: 'standard',
    licence_note: 'WHO classification. Check the WHO terms of use that apply to you.' },
  { id: 'ucum', uri: 'http://unitsofmeasure.org', name: 'UCUM', kind: 'standard',
    licence_note: 'Unified Code for Units of Measure. Check its current terms before use.' }
];
module.exports = { CODE_SYSTEMS };
