'use strict';
// Row R9d-1: demo content for the longitudinal explorer. Pure: no database, no clock, no random numbers, no writes.
// The seed (R9d-2, R9d-3) publishes these sets and this pathway through the real review rules and records the series through the routes.
// Nothing here is a threshold, band, target, code, dose or advice. Values are illustrative only.
// SYNTHETIC DEMO DATA - NOT FOR CLINICAL USE.

const SYNTHETIC_LABEL = 'SYNTHETIC DEMO DATA - NOT FOR CLINICAL USE';

// Stored set definitions hold no numbers (sets.js refuses them): only text, true/false, lists and objects.
const SETS = [
  { slug: 'dm_ctx', kind: 'disease', definition: {
    title: 'Diabetes Mellitus context', desc: 'Diabetes disease fields. Synthetic demo set. Not for clinical use.',
    fields: [
      { id: 'dm_type', label: 'Type', type: 'select', options: ['T1DM', 'T2DM', 'Other'] },
      { id: 'dm_duration', label: 'Duration (years)', type: 'number' },
      { id: 'dm_meds', label: 'Current anti-diabetic regimen', type: 'text' },
      { id: 'dm_comp', label: 'Known complications', type: 'text' },
      { id: 'dm_hypo', label: 'Recent hypoglycaemia', type: 'boolean' },
    ] } },
  { slug: 'hba1c_mon', kind: 'care', definition: {
    title: 'HbA1c Monitoring', desc: 'Repeated HbA1c results. Synthetic demo set. Not for clinical use.',
    fields: [
      { id: 'hba1c', label: 'HbA1c', type: 'number', unit: '%', repeat: true },
      { id: 'hba1c_notes', label: 'Notes', type: 'text' },
    ] } },
  { slug: 'ckd_ctx', kind: 'disease', definition: {
    title: 'CKD context', desc: 'Chronic kidney disease fields and repeated kidney results. Synthetic demo set. Not for clinical use.',
    fields: [
      { id: 'ckd_stage', label: 'CKD stage', type: 'select', options: ['1', '2', '3a', '3b', '4', '5'] },
      { id: 'egfr', label: 'eGFR', type: 'number', unit: 'mL/min/1.73m²', repeat: true },
      { id: 'creat', label: 'Creatinine', type: 'number', unit: 'mg/dL', repeat: true },
      { id: 'uacr', label: 'Urine albumin-creatinine ratio', type: 'number', unit: 'mg/g', repeat: true },
      { id: 'ckd_cause', label: 'Aetiology', type: 'text' },
    ] } },
  { slug: 'htn_ctx', kind: 'disease', definition: {
    title: 'Hypertension context', desc: 'Hypertension disease fields and repeated blood pressure readings. Synthetic demo set. Not for clinical use.',
    fields: [
      { id: 'htn_type', label: 'Type', type: 'select', options: ['Essential', 'Secondary', 'Other'] },
      { id: 'sbp', label: 'Systolic blood pressure', type: 'number', unit: 'mmHg', repeat: true },
      { id: 'dbp', label: 'Diastolic blood pressure', type: 'number', unit: 'mmHg', repeat: true },
      { id: 'htn_notes', label: 'Notes', type: 'text' },
    ] } },
];

// The pathway lists set slugs; the seed turns them into exact published set versions.
const PATHWAY = {
  slug: 'pw_dm_ckd_htn', title: 'Diabetes + CKD + Hypertension',
  description: 'Demo pathway: documents diabetes, kidney and blood pressure sets together. Synthetic. Not for clinical use.',
  memberSlugs: ['dm_ctx', 'hba1c_mon', 'ckd_ctx', 'htn_ctx'],
};

// Sixteen quarterly visits, 2022-12 to 2026-09 (about 3.8 years). Fixed dates, 09:00 UTC, all in the past.
const VISIT_DATES = ['2022-12-06', '2023-03-07', '2023-06-06', '2023-09-05', '2023-12-05', '2024-03-05', '2024-06-04', '2024-09-03',
  '2024-12-03', '2025-03-04', '2025-06-03', '2025-09-02', '2025-12-02', '2026-03-03', '2026-06-02', '2026-09-01'];
const VISITS = VISIT_DATES.map(d => d + 'T09:00:00Z');

// One row per measurement: [setSlug, fieldKey, unit, values by visit]. null = not recorded at that visit (see MISSING). Illustrative values.
const COLUMNS = [
  ['hba1c_mon', 'hba1c', '%',            [8.1, 7.9, 7.6, 7.8, 7.4, 7.2, 7.5, 7.3, 7.1, 7.4, 7.2, 7.0, 7.3, 7.1, 6.9, 7.2]],
  ['ckd_ctx', 'creat', 'mg/dL',          [1.4, 1.4, 1.5, 1.5, 1.6, 1.6, 1.7, 1.7, 1.8, 1.8, 1.8, 1.9, 1.9, 2.0, 2.0, 2.1]],
  ['ckd_ctx', 'egfr', 'mL/min/1.73m²',   [52, 52, 50, 50, 47, 47, 45, 44, 43, 42, 41, 40, 39, 38, 38, 37]],
  ['ckd_ctx', 'uacr', 'mg/g',            [84, null, 96, null, 112, null, 131, null, null, null, 158, null, 187, null, 214, null]],
  ['htn_ctx', 'sbp', 'mmHg',             [148, 146, 150, 144, 142, 146, 140, 138, 141, 136, 139, 134, 137, 132, 135, 130]],
  ['htn_ctx', 'dbp', 'mmHg',             [92, 90, 94, 88, 88, 90, 86, 84, 86, 82, 84, 80, 82, 78, 80, 78]],
];

// The three states the explorer must keep apart. Each is one value in the series, found by its (field, visit index).
const UNKNOWN_AT = { setSlug: 'hba1c_mon', fieldKey: 'hba1c', visit: 5 };           // recorded as an explicit Unknown: no value, and the result was not available
const MISSING_AT = { setSlug: 'ckd_ctx', fieldKey: 'uacr', visit: 8 };              // nothing is recorded at all: no row, not zero (a six-monthly sample that was not taken)
const ERROR_AT = { setSlug: 'htn_ctx', fieldKey: 'sbp', visit: 10, wrongValue: 190, reason: 'Typing error (extra digit).' };   // later marked entered in error; the right value is a new row

// Build the flat, ordered list of points. Pure and repeatable: the same call always returns equal data.
//   point = { key, setSlug, fieldKey, unit, effectiveAt, value, unknown, enteredInError, replaces }
function buildSeries() {
  const points = [];
  const base = { setSlug: null, fieldKey: null, unit: null, effectiveAt: null, value: null, unknown: false, enteredInError: false, replaces: null };
  COLUMNS.forEach(([setSlug, fieldKey, unit, values]) => {
    values.forEach((v, i) => {
      const key = `${setSlug}.${fieldKey}@${VISIT_DATES[i]}`;
      const isUnknown = setSlug === UNKNOWN_AT.setSlug && fieldKey === UNKNOWN_AT.fieldKey && i === UNKNOWN_AT.visit;
      const isError = setSlug === ERROR_AT.setSlug && fieldKey === ERROR_AT.fieldKey && i === ERROR_AT.visit;
      if (v === null) return;                                                       // absent: no point at all
      if (isError) {
        points.push({ ...base, key, setSlug, fieldKey, unit, effectiveAt: VISITS[i], value: ERROR_AT.wrongValue, enteredInError: true });
        points.push({ ...base, key: key + '#corrected', setSlug, fieldKey, unit, effectiveAt: VISITS[i], value: v, replaces: key });
      } else if (isUnknown) {
        points.push({ ...base, key, setSlug, fieldKey, unit, effectiveAt: VISITS[i], unknown: true });
      } else points.push({ ...base, key, setSlug, fieldKey, unit, effectiveAt: VISITS[i], value: v });
    });
  });
  return points.sort((a, b) => a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

const MISSING = [{ setSlug: MISSING_AT.setSlug, fieldKey: MISSING_AT.fieldKey, effectiveAt: VISITS[MISSING_AT.visit], key: `${MISSING_AT.setSlug}.${MISSING_AT.fieldKey}@${VISIT_DATES[MISSING_AT.visit]}` }];

module.exports = { SYNTHETIC_LABEL, SETS, PATHWAY, VISITS, COLUMNS, UNKNOWN_AT, MISSING_AT, ERROR_AT, MISSING, buildSeries };
