'use strict';
// Task R6f-1: FHIR Bundle -> reviewable PROPOSALS. Pure: no database, clock, network or random. NOTHING is written anywhere by this module.
// A proposal is a draft for a person to look at and accept later (a later row stores and accepts them); it is never a record.
// Rules kept here:
//  - Draft only: every proposal says draft:true. Observations start as status 'preliminary' with source 'imported' (the source's own status is kept as sourceStatus).
//  - Nothing is guessed: a missing or date-only effective time, an unsupported value type, text over its limit, or more than one patient in the bundle
//    becomes a BLOCKER on the proposal (it cannot be accepted until a person fixes it); text is never cut and no time is invented.
//  - No patient matching: the Patient entry is reported only as identifiers. Choosing the chart is a person's decision.
//  - No codes are imported: every code.coding is dropped and counted (imported codes are unverified).
//  - A MedicationRequest is ALWAYS blocked: dose, route and frequency are separate required fields and are never split out of free text.
//    Its text is kept word for word for a clinician. An imported bundle can never create an active order.
//  - Only POST entries are read in a transaction (a PUT or DELETE is refused, never acted on). Entries entered in error are skipped and counted.
//  - Note text and names are not carried (counted). The audit summary holds counts and a hash only, never content.
const crypto = require('crypto');

const LIM = { entries: 500, label: 200, reaction: 500, medication: 200, dosage: 1000 };
const SUPPORTED = ['Observation', 'Condition', 'AllergyIntolerance', 'MedicationRequest'];
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' && v.trim() ? v : null);

class BundleImportError extends Error { constructor(m) { super(m); this.name = 'BundleImportError'; } }

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const bundleHash = b => crypto.createHash('sha256').update(canonical(b), 'utf8').digest('hex');
const validDate = s => typeof s === 'string' && DATE.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime()) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const validInstant = s => typeof s === 'string' && ZONED.test(s) && !Number.isNaN(new Date(s).getTime());
const code = (cc, k) => (isObj(cc) && Array.isArray(cc.coding) ? cc.coding.map(c => c && c[k]).find(x => typeof x === 'string') : undefined);
const statusCode = cc => code(cc, 'code');
const codingCount = cc => (isObj(cc) && Array.isArray(cc.coding) ? cc.coding.length : 0);
const labelOf = cc => text(isObj(cc) && cc.text) || text(code(cc, 'display'));   // a display is text, not a code

function observation(r, P, tally) {
  const f = { label: labelOf(r.code), valueType: null, value: null, unit: null, effectiveAt: null, sourceRecordedAt: validInstant(r.issued) ? r.issued : null };
  tally.codingsDropped += codingCount(r.code);
  if (!f.label) P.blockers.push('The observation has no name (code.text).'); else if (f.label.length > LIM.label) P.blockers.push('The name is longer than ' + LIM.label + ' characters.');
  const vs = Object.keys(r).filter(k => /^value[A-Z]/.test(k) && r[k] !== undefined);
  if (r.dataAbsentReason !== undefined && vs.length) P.blockers.push('Both a value and a reason for no value are given.');
  else if (vs.length > 1) P.blockers.push('More than one value is given.');
  else if (vs.length === 0) {
    if (statusCode(r.dataAbsentReason) === 'unknown') { f.valueType = 'unknown'; }
    else P.blockers.push(r.dataAbsentReason !== undefined ? 'The reason for no value is not "unknown", which is the only one carried over.' : 'There is no value.');
  } else {
    const k = vs[0], v = r[k];
    if (k === 'valueQuantity' && isObj(v) && typeof v.value === 'number' && Number.isFinite(v.value)) { f.valueType = 'number'; f.value = v.value; f.unit = text(v.unit) || null; if (f.unit && f.unit.length > 40) P.blockers.push('The unit is longer than 40 characters.'); }
    else if (k === 'valueInteger' && Number.isInteger(v)) { f.valueType = 'integer'; f.value = v; }
    else if (k === 'valueBoolean' && typeof v === 'boolean') { f.valueType = 'boolean'; f.value = v; }
    else if (k === 'valueString' && typeof v === 'string') { f.valueType = 'text'; f.value = v; }
    else if (k === 'valueDateTime' && (validInstant(v) || validDate(v))) { f.valueType = 'datetime'; f.value = v; }
    else P.blockers.push('The value (' + k + ') cannot be carried over as it is.');
  }
  const e = r.effectiveDateTime !== undefined ? r.effectiveDateTime : r.effectiveInstant;
  if (validInstant(e)) f.effectiveAt = new Date(e).toISOString();
  else if (validDate(e)) P.blockers.push('The effective time is a date with no time of day; a person must give the time.');
  else P.blockers.push('There is no usable effective time; a person must give one.');
  if (r.status === 'entered-in-error') return null;
  P.sourceStatus = text(r.status) || 'unknown';
  P.startsAs = 'preliminary'; P.source = 'imported';
  if (Array.isArray(r.note) && r.note.length) tally.notesDropped += r.note.length;
  P.fields = f;
  return P;
}

function condition(r, P, tally) {
  const f = { label: labelOf(r.code), onsetDate: null, sourceRecordedAt: validInstant(r.recordedDate) ? r.recordedDate : null };
  tally.codingsDropped += codingCount(r.code);
  if (statusCode(r.verificationStatus) === 'entered-in-error') return null;
  if (!f.label) P.blockers.push('The problem has no name (code.text).'); else if (f.label.length > LIM.label) P.blockers.push('The name is longer than ' + LIM.label + ' characters.');
  if (typeof r.onsetDateTime === 'string') { const d = r.onsetDateTime.slice(0, 10); if (validDate(d) && (r.onsetDateTime.length === 10 || validInstant(r.onsetDateTime))) f.onsetDate = d; else P.warnings.push('The onset is not a valid date and was left blank.'); }
  P.sourceStatus = statusCode(r.clinicalStatus) || 'unknown'; P.startsAs = 'active';
  if (P.sourceStatus !== 'active') P.warnings.push('The source status is "' + P.sourceStatus + '"; a new problem starts as active and is resolved afterwards with a reason.');
  if (Array.isArray(r.note) && r.note.length) tally.notesDropped += r.note.length;
  P.fields = f;
  return P;
}

function allergy(r, P, tally) {
  const f = { substance: labelOf(r.code), reaction: null, severity: null, onsetDate: null, sourceRecordedAt: validInstant(r.recordedDate) ? r.recordedDate : null };
  tally.codingsDropped += codingCount(r.code);
  if (statusCode(r.verificationStatus) === 'entered-in-error') return null;
  if (!f.substance) P.blockers.push('The allergy has no substance (code.text).'); else if (f.substance.length > LIM.label) P.blockers.push('The substance is longer than ' + LIM.label + ' characters.');
  const rx = Array.isArray(r.reaction) ? r.reaction.filter(isObj) : [];
  if (rx.length) {
    const m = rx[0].manifestation && rx[0].manifestation[0];
    f.reaction = labelOf(m) || null;
    if (f.reaction && f.reaction.length > LIM.reaction) P.blockers.push('The reaction is longer than ' + LIM.reaction + ' characters.');
    if (['mild', 'moderate', 'severe'].includes(rx[0].severity)) f.severity = rx[0].severity;
    if (rx.length > 1) P.warnings.push((rx.length - 1) + ' further reaction(s) were not carried over.');
  }
  if (typeof r.onsetDateTime === 'string') { const d = r.onsetDateTime.slice(0, 10); if (validDate(d)) f.onsetDate = d; else P.warnings.push('The onset is not a valid date and was left blank.'); }
  P.sourceStatus = statusCode(r.clinicalStatus) || 'unknown'; P.startsAs = 'active';
  if (P.sourceStatus !== 'active') P.warnings.push('The source status is "' + P.sourceStatus + '"; a new allergy starts as active and is resolved afterwards with a reason.');
  if (Array.isArray(r.note) && r.note.length) tally.notesDropped += r.note.length;
  P.fields = f;
  return P;
}

function medicationRequest(r, P, tally) {
  if (r.status === 'entered-in-error') return null;
  const mc = r.medicationCodeableConcept;
  tally.codingsDropped += codingCount(mc);
  const f = { medication: labelOf(mc), dosageText: null };
  if (!f.medication) P.blockers.push('The medication has no name (medicationCodeableConcept.text).'); else if (f.medication.length > LIM.medication) P.blockers.push('The medication name is longer than ' + LIM.medication + ' characters.');
  const d = Array.isArray(r.dosageInstruction) && isObj(r.dosageInstruction[0]) ? text(r.dosageInstruction[0].text) : null;
  if (d) { f.dosageText = d; if (d.length > LIM.dosage) P.blockers.push('The dosage text is longer than ' + LIM.dosage + ' characters.'); }
  P.blockers.push('Review only: an imported bundle never creates an order. Dose, route and frequency are separate required fields and are not taken out of free text; a clinician must enter the order.');
  P.sourceStatus = text(r.status) || 'unknown'; P.startsAs = 'none';
  if (Array.isArray(r.note) && r.note.length) tally.notesDropped += r.note.length;
  P.fields = f;
  return P;
}
const MAP = { Observation: observation, Condition: condition, AllergyIntolerance: allergy, MedicationRequest: medicationRequest };

// bundle: a parsed Bundle. Returns { proposals, rejected, skipped, patients, warnings, summary, audit }. Writes nothing.
function parseBundle(bundle) {
  if (!isObj(bundle) || bundle.resourceType !== 'Bundle') throw new BundleImportError('This is not a FHIR Bundle.');
  if (!['transaction', 'collection'].includes(bundle.type)) throw new BundleImportError('Only transaction and collection bundles are read.');
  const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
  if (!entries.length) throw new BundleImportError('The bundle has no entries.');
  if (entries.length > LIM.entries) throw new BundleImportError('The bundle has ' + entries.length + ' entries; at most ' + LIM.entries + ' are read in one go.');
  const proposals = [], rejected = [], patients = [], seen = new Set(), warnings = [];
  const tally = { codingsDropped: 0, notesDropped: 0 }, byType = {};
  let skipped = 0;
  entries.forEach((e, index) => {
    const rej = reason => rejected.push({ index, reason });
    if (!isObj(e) || !isObj(e.resource)) return rej('The entry has no resource.');
    const r = e.resource, t = r.resourceType;
    byType[t] = (byType[t] || 0) + 1;
    if (typeof e.fullUrl === 'string' && e.fullUrl) { if (seen.has(e.fullUrl)) return rej('The same fullUrl appears twice.'); seen.add(e.fullUrl); }
    if (bundle.type === 'transaction' && !(isObj(e.request) && e.request.method === 'POST')) return rej('Only POST entries are read; this entry asks for ' + (isObj(e.request) && e.request.method ? e.request.method : 'no method') + '.');
    if (t === 'Patient') {
      const ids = (Array.isArray(r.identifier) ? r.identifier : []).filter(i => isObj(i) && text(i.value)).slice(0, 5).map(i => ({ system: text(i.system) || null, value: i.value }));
      patients.push({ fullUrl: e.fullUrl || null, identifiers: ids });
      return;
    }
    if (!SUPPORTED.includes(t)) return rej(typeof t === 'string' ? 'The resource type ' + t.slice(0, 40) + ' is not read.' : 'The entry has no resource type.');
    const P = { key: t + '#' + index, kind: t, index, fullUrl: e.fullUrl || null, draft: true, blockers: [], warnings: [], ready: false };
    const out = MAP[t](r, P, tally);
    if (!out) { skipped++; return; }
    proposals.push(out);
  });
  if (patients.length > 1) { warnings.push('The bundle names ' + patients.length + ' patients; nothing in it can be accepted until it is split.'); for (const p of proposals) p.blockers.push('The bundle names more than one patient.'); }
  if (!patients.length) warnings.push('The bundle has no Patient entry; a person must choose the chart.');
  for (const p of proposals) p.ready = p.blockers.length === 0;
  const summary = { entries: entries.length, proposals: proposals.length, ready: proposals.filter(p => p.ready).length, blocked: proposals.filter(p => !p.ready).length,
    rejected: rejected.length, skippedInError: skipped, patients: patients.length, codingsDropped: tally.codingsDropped, notesDropped: tally.notesDropped };
  // counts and a hash only: never content, names or identifiers
  const audit = { bundleType: bundle.type, hash: bundleHash(bundle), byType, ...summary };
  return { proposals, rejected, skipped, patients, warnings, summary, audit };
}

module.exports = { parseBundle, bundleHash, BundleImportError, LIMITS: LIM, SUPPORTED };
