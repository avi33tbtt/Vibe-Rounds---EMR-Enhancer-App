/* element-sets.js : seed registry for EMR Enhancer (Phase 2, chunk 8).
   Load it with a script tag (src="element-sets.js") BEFORE the main script in enhancer.html.
   Each entry is an "element set": kind = disease | care | template | custom.
   Add new sets here; no logic lives in this file. Codes: leave coding out unless you verified it yourself. */
window.SEED_SETS=[
{
 "setId":"disease.snake_envenomation",
 "kind":"disease",
 "version":1,
 "title":"Snake envenomation (hemotoxic)",
 "description":"Hemotoxic snake envenomation: bite-to-antivenom timing, severity, therapy, outcome.",
 "contexts":["disease"],
 "requires":[],
 "suggests":[],
 "diagnosis":{"text":"Snake envenomation (hemotoxic)","snomed":{"code":"","display":""}},
 "sections":[
  {"title":"Time-critical","fields":[
   {"id":"bite","label":"Time of bite","type":"datetime","required":true,"rationale":"Anchor for every interval."},
   {"id":"arr","label":"Hospital arrival time","type":"datetime","required":true,"rationale":"Pre-hospital delay."},
   {"id":"asv","label":"ASV first dose time","type":"datetime","required":true,"rationale":"Delay to antivenom drives outcome."},
   {"id":"gap","label":"Bite to ASV (min)","type":"duration_min","rationale":"Key prognostic interval.","derived":{"from":["bite","asv"],"op":"minutes_between","flag":[60,240]}}]},
  {"title":"Severity","fields":[
   {"id":"wbct","label":"20-min whole blood clotting test","type":"select","options":["Clotted","Unclotted","Not done"],"rationale":"Detects venom-induced coagulopathy."},
   {"id":"swell","label":"Local swelling grade","type":"select","options":["0","1","2","3"],"rationale":"Progression marker."},
   {"id":"neuro","label":"Neurotoxic signs (ptosis, bulbar)","type":"boolean","rationale":"Needs ventilation planning."}]},
  {"title":"Therapy & outcome","fields":[
   {"id":"vials","label":"Initial ASV vials","type":"integer","rationale":"Dose tracking."},
   {"id":"rxn","label":"Acute reaction to ASV","type":"boolean","rationale":"Safety monitoring."},
   {"id":"out","label":"Outcome","type":"select","options":["Recovered","AKI","Amputation","Death"],"rationale":"Outcome for analytics."}]}]},
{
 "setId":"disease.dka",
 "kind":"disease",
 "version":1,
 "title":"Diabetic ketoacidosis",
 "description":"Diabetic ketoacidosis: arrival-to-insulin timing, severity at presentation, therapy, complications.",
 "contexts":["disease"],
 "requires":[],
 "suggests":[],
 "diagnosis":{"text":"Diabetic ketoacidosis","snomed":{"code":"","display":""}},
 "sections":[
  {"title":"Time-critical","fields":[
   {"id":"arr","label":"ED arrival time","type":"datetime","required":true,"rationale":"Start of treatment clock."},
   {"id":"ins","label":"Insulin infusion start","type":"datetime","required":true,"rationale":"Delay to insulin after fluids/potassium check."},
   {"id":"gap","label":"Arrival to insulin (min)","type":"duration_min","rationale":"Process-of-care interval.","derived":{"from":["arr","ins"],"op":"minutes_between","flag":[60,180]}}]},
  {"title":"Severity at presentation","fields":[
   {"id":"glu","label":"Blood glucose","type":"number","unit":"mg/dL","rationale":"Severity context."},
   {"id":"ph","label":"Venous pH","type":"number","rationale":"Defines DKA severity."},
   {"id":"hco3","label":"Bicarbonate","type":"number","unit":"mmol/L","rationale":"Severity."},
   {"id":"k","label":"Potassium before insulin","type":"number","unit":"mmol/L","rationale":"Insulin is held if low; critical safety value."},
   {"id":"ket","label":"Ketones","type":"select","options":["Negative","Trace","Moderate","Large"],"rationale":"Confirms ketosis."},
   {"id":"gcs","label":"GCS","type":"integer","rationale":"Mental status."}]},
  {"title":"Therapy & outcome","fields":[
   {"id":"fl","label":"IV fluid in first hour","type":"integer","unit":"mL","rationale":"Resuscitation adequacy."},
   {"id":"edema","label":"Cerebral edema","type":"boolean","rationale":"Key complication."},
   {"id":"out","label":"Outcome","type":"select","options":["Recovered","ICU stay","Death"],"rationale":"Outcome."}]}]},
{
 "setId":"care.vitals",
 "direct":true,
 "quick":{"order":1,"short":"Vitals"},
 "view":{"type":"flowsheet","timeField":"vit_time"},
 "kind":"care",
 "version":1,
 "title":"Vitals",
 "description":"Temperature, pulse, respiratory rate, blood pressure, SpO2, weight. One row per set of readings.",
 "contexts":["care"],
 "requires":[],
 "suggests":[],
 "sections":[
  {"title":"Vital signs","fields":[
   {"id":"vit_time","label":"Time recorded","type":"datetime","repeat":true,"group":"vitals","rationale":"Timestamp for this set of readings."},
   {"id":"temp","label":"Temperature","type":"number","unit":"°C","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"vitals"},
   {"id":"hr","label":"Heart rate","type":"number","unit":"bpm","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"vitals"},
   {"id":"rr","label":"Respiratory rate","type":"number","unit":"/min","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"vitals"},
   {"id":"bp_sys","label":"Systolic BP","type":"number","unit":"mmHg","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"vitals"},
   {"id":"bp_dia","label":"Diastolic BP","type":"number","unit":"mmHg","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"vitals"},
   {"id":"spo2","label":"SpO2","type":"number","unit":"%","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"vitals"},
   {"id":"weight","label":"Weight","type":"number","unit":"kg","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"vitals"}]}]},
{
 "setId":"template.basic_emr",
 "kind":"template",
 "version":1,
 "title":"Basic EMR note",
 "description":"Presenting complaint, history, examination, assessment, plan.",
 "contexts":["care"],
 "requires":[],
 "suggests":[],
 "sections":[
  {"title":"Clinical note","fields":[
   {"id":"cc","label":"Presenting complaint","type":"text","multiline":true,"fhir":{"resource":"Observation","valueType":"valueString"}},
   {"id":"hx","label":"History","type":"text","multiline":true,"fhir":{"resource":"Observation","valueType":"valueString"}},
   {"id":"exam","label":"Examination","type":"text","multiline":true,"fhir":{"resource":"Observation","valueType":"valueString"}},
   {"id":"assess","label":"Assessment","type":"text","multiline":true,"fhir":{"resource":"Observation","valueType":"valueString"}},
   {"id":"plan","label":"Plan","type":"text","multiline":true,"fhir":{"resource":"Observation","valueType":"valueString"}}]}]},
{
 "setId":"care.hba1c_monitoring",
 "direct":true,
 "quick":{"order":4,"short":"HbA1c"},
 "kind":"care",
 "version":2,
 "title":"HbA1c monitoring",
 "description":"HbA1c readings over time with a clinician-set target and next-due date, plus capillary glucose.",
 "contexts":["care"],
 "requires":[],
 "suggests":["care.sliding_scale_insulin"],
 "sections":[
  {"title":"HbA1c","fields":[
   {"id":"a1c_date","label":"HbA1c date","type":"date","repeat":true,"group":"hba1c","rationale":"Date of this reading."},
   {"id":"a1c","label":"HbA1c","type":"number","unit":"%","rationale":"Longitudinal glycaemic control.","repeat":true,"target":"a1c_target","fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"hba1c"},
   {"id":"a1c_target","label":"HbA1c target (entered by clinician)","type":"number","unit":"%","rationale":"Individualised target; no default is supplied."},
   {"id":"a1c_due","label":"Next HbA1c due","type":"date","rationale":"Follow-up scheduling."}]},
  {"title":"Capillary glucose","fields":[
   {"id":"cbg_time","label":"Time","type":"datetime","repeat":true,"group":"cbg"},
   {"id":"cbg","label":"Capillary glucose","type":"number","unit":"mg/dL","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"cbg"}]}]},
{
 "setId":"care.sliding_scale_insulin",
 "direct":true,
 "quick":{"order":5,"short":"Sliding scale"},
 "kind":"care",
 "version":1,
 "title":"Sliding-scale insulin",
 "description":"Protocol-defined sliding scale. Bands are typed by the clinician or institution; none are supplied here.",
 "contexts":["care"],
 "requires":[],
 "suggests":["care.hba1c_monitoring"],
 "protocol":{"type":"sliding_scale","editable":true,"verifiedBy":"","bands":[],"glucoseField":"ssi_glucose"},
 "sections":[
  {"title":"Administration log","fields":[
   {"id":"ssi_time","label":"Time","type":"datetime","repeat":true,"group":"ssi_log"},
   {"id":"ssi_glucose","label":"Glucose before dose","type":"number","unit":"mg/dL","rationale":"","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"ssi_log"},
   {"id":"ssi_dose","label":"Dose given (as administered, free text)","type":"text","repeat":true,"group":"ssi_log","rationale":"Entered by the person who gave it; never calculated here.","fhir":{"resource":"MedicationAdministration","valueType":"valueString"}},
   {"id":"ssi_by","label":"Given by","type":"text","repeat":true,"group":"ssi_log"}]}]},
{
 "setId":"care.fever_chart",
 "direct":true,
 "quick":{"order":2,"short":"Fever chart"},
 "kind":"care",
 "version":1,
 "title":"Fever chart",
 "description":"Temperature readings over several days (per-row unit, route, optional pulse, antipyretic given). Threshold is entered by the clinician; none is supplied.",
 "contexts":["care"],
 "requires":[],
 "suggests":["care.vitals"],
 "view":{"type":"fever","timeField":"ft_time","tempField":"temp","unitField":"temp_unit","thresholdField":"fever_thr","thresholdUnitField":"fever_thr_unit","extra":["pulse"]},
 "sections":[
  {"title":"Temperature readings","fields":[
   {"id":"ft_time","label":"Time recorded","type":"datetime","repeat":true,"group":"fever","rationale":"Timestamp for this reading."},
   {"id":"temp","label":"Temperature","type":"number","unitField":"temp_unit","rationale":"Stored exactly as entered, with the unit chosen on the row.","repeat":true,"fhir":{"resource":"Observation","valueType":"valueQuantity"},"group":"fever"},
   {"id":"temp_unit","label":"Unit","type":"select","options":["°C","°F"],"default":"°C","meta":true,"repeat":true,"group":"fever","rationale":"Unit of this row's temperature."},
   {"id":"route","label":"Route","type":"select","options":["Oral","Axillary","Rectal","Tympanic","Other"],"repeat":true,"group":"fever","fhir":{"resource":"Observation","valueType":"valueString"}},
   {"id":"pulse","label":"Pulse","type":"number","unit":"bpm","repeat":true,"group":"fever","rationale":"Optional; drawn as a second series.","fhir":{"resource":"Observation","valueType":"valueQuantity"}},
   {"id":"antipyretic","label":"Antipyretic given (as administered, free text)","type":"text","repeat":true,"group":"fever","rationale":"Entered by the person who gave it; never calculated here.","fhir":{"resource":"MedicationAdministration","valueType":"valueString"}}]},
  {"title":"Fever threshold (display line only)","fields":[
   {"id":"fever_thr","label":"Fever threshold (entered by clinician)","type":"number","meta":true,"rationale":"No default is supplied. With nothing typed the chart shows data only."},
   {"id":"fever_thr_unit","label":"Threshold unit","type":"select","options":["°C","°F"],"meta":true,"rationale":"Choose the unit the threshold was typed in."}]}]},
{
 "setId":"care.daily_insulin_monitoring",
 "direct":true,
 "quick":{"order":3,"short":"Insulin chart"},
 "kind":"care",
 "version":1,
 "title":"Daily insulin monitoring",
 "description":"Slot-based daily record: glucose, dose as given (free text), given by. Target range is entered by the clinician; none is supplied.",
 "contexts":["care"],
 "requires":[],
 "suggests":["care.sliding_scale_insulin","care.hba1c_monitoring"],
 "view":{"type":"dailygrid","timeField":"ins_time","slotField":"slot","glucoseField":"ins_glucose","doseField":"ins_dose","byField":"ins_by","slots":["Pre-breakfast","Pre-lunch","Pre-dinner","Bedtime","Night"]},
 "sections":[
  {"title":"Daily readings","fields":[
   {"id":"ins_time","label":"Time","type":"datetime","repeat":true,"group":"dim","rationale":"Timestamp for this reading."},
   {"id":"slot","label":"Slot","type":"select","options":["Pre-breakfast","Pre-lunch","Pre-dinner","Bedtime","Night","Other"],"repeat":true,"group":"dim","rationale":"Which daily check this is."},
   {"id":"ins_glucose","label":"Glucose","type":"number","unit":"mg/dL","repeat":true,"group":"dim","rationale":"","fhir":{"resource":"Observation","valueType":"valueQuantity"}},
   {"id":"ins_dose","label":"Dose as given (free text)","type":"text","repeat":true,"group":"dim","rationale":"Entered by the person who gave it; never calculated, summed or converted here.","fhir":{"resource":"MedicationAdministration","valueType":"valueString"}},
   {"id":"ins_by","label":"Given by","type":"text","repeat":true,"group":"dim"},
   {"id":"ins_note","label":"Note","type":"text","repeat":true,"group":"dim"}]},
  {"title":"Glucose target range (display only)","fields":[
   {"id":"tgt_low","label":"Glucose target low (entered by clinician)","type":"number","unit":"mg/dL","meta":true,"rationale":"No default is supplied. The band is drawn only when both numbers are typed."},
   {"id":"tgt_high","label":"Glucose target high (entered by clinician)","type":"number","unit":"mg/dL","meta":true,"rationale":"No default is supplied."}]}]}
,{
 "setId":"care.intake_output",
 "direct":true,
 "quick":{"order":6,"short":"Intake/output"},
 "view":{"type":"flowsheet","timeField":"io_time","summary":[{"type":"sumBy","timeField":"io_time","keyField":"io_type","valueField":"io_volume","windowsHours":[8,12,24],"label":"sum of entered rows"}]},
 "kind":"care",
 "version":2,
 "title":"Intake / output",
 "description":"Fluid intake and output entries, one row per entry. Volumes are recorded as entered; no targets or limits are supplied.",
 "contexts":["care"],
 "requires":[],
 "suggests":[],
 "sections":[
  {"title":"Intake and output","fields":[
   {"id":"io_time","label":"Time recorded","type":"datetime","repeat":true,"group":"io","rationale":"Timestamp for this entry."},
   {"id":"io_type","label":"Type","type":"select","options":["Intake oral","Intake IV","Urine","Drain","Stool","Other"],"repeat":true,"group":"io","rationale":"Which kind of intake or output this is."},
   {"id":"io_volume","label":"Volume","type":"number","unit":"mL","repeat":true,"group":"io","rationale":"Shown as entered; never compared with a target here.","fhir":{"resource":"Observation","valueType":"valueQuantity"}},
   {"id":"io_note","label":"Note","type":"text","repeat":true,"group":"io"}]}]}
/* Seed pathways (chunk 23): member lists only. No doses, bands, thresholds or rules. */
,{
 "setId":"pathway.dka",
 "kind":"pathway",
 "version":1,
 "title":"DKA pathway",
 "description":"Sets commonly used when following a diabetic ketoacidosis case. A bundle of sets only; it contains no protocol.",
 "contexts":["care"],
 "requires":[],
 "suggests":[],
 "members":[{"setId":"care.vitals","optional":false},{"setId":"care.hba1c_monitoring","optional":false},{"setId":"care.sliding_scale_insulin","optional":false},{"setId":"care.daily_insulin_monitoring","optional":false},{"setId":"template.basic_emr","optional":false}],
 "rules":[]
},
{
 "setId":"pathway.snakebite",
 "kind":"pathway",
 "version":1,
 "title":"Snakebite pathway",
 "description":"Sets commonly used when following a snake envenomation case.",
 "contexts":["care"],
 "requires":[],
 "suggests":[],
 "members":[{"setId":"care.vitals","optional":false},{"setId":"template.basic_emr","optional":false},{"setId":"disease.snake_envenomation","optional":false}],
 "rules":[]
},
{
 "setId":"pathway.fever_monitoring",
 "kind":"pathway",
 "version":1,
 "title":"Fever monitoring pathway",
 "description":"Sets commonly used when charting a febrile patient over several days.",
 "contexts":["care"],
 "requires":[],
 "suggests":[],
 "members":[{"setId":"care.vitals","optional":false},{"setId":"care.fever_chart","optional":false},{"setId":"template.basic_emr","optional":false}],
 "rules":[]
}
];
