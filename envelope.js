'use strict';
// Task B5a-1: the pure context-envelope builder. Plain rows in, one plain object out, no database, no clock, no network.
// The output follows contracts/context-envelope.schema.json (vendored from CCIS, see contracts/README.md).
// Left out, always, and said so in `x-emr.withheld` (a reader sees "withheld", not "forgotten"):
//   identity and narrative (no field exists for them), free-text values, entered-in-error rows (inclusions.enteredInError is false),
//   unitless numbers (the schema cannot say "a number without a unit"; we never invent a unit), derived rows (the EMR keeps no formula),
//   system events (EMR actions, not clinical events classified by meaning).
// Nothing is coerced: an explicitly unknown value is state "unknown" with no value; false stays false; no code is ever "verified".
const crypto = require('crypto');

class EnvelopeError extends Error { constructor(message) { super(message); this.name = 'EnvelopeError'; } }

const SOURCE_CLASS = { patient: 'patient-reported', clinician: 'clinician-entered', imported: 'imported', device: 'device', derived: 'derived', ai_proposed: 'ai-proposed' };
const STATUS = { preliminary: 'preliminary', final: 'final', amended: 'corrected' };            // entered_in_error never gets here
const KIND_OF_FIELD = { number: 'quantity', integer: 'integer', boolean: 'boolean', select: 'string', datetime: 'datetime', text: 'string' };

const iso = d => (d instanceof Date ? d : new Date(d)).toISOString();                           // always UTC with Z
const time = d => ({ value: iso(d), zone: 'stated' });
const ver = n => `${Number(n)}.0.0`;                                                              // EMR versions are whole numbers; the schema wants semver

// A slug or field id becomes one canonical id segment (lower-case, letters/digits/hyphens, starts with a letter).
function seg(s) {
  let v = String(s).toLowerCase().replace(/_/g, '-');
  if (!/^[a-z0-9-]+$/.test(v) || /^-|-$/.test(v)) throw new EnvelopeError('cannot map "' + s + '" to a canonical id');
  if (!/^[a-z]/.test(v)) v = 'n-' + v;
  return v;
}
// Two different keys must never map to the same id.
function checkUnique(pairs, what) {
  const seen = new Map();
  for (const [key, id] of pairs) { if (seen.has(id) && seen.get(id) !== key) throw new EnvelopeError(what + ' "' + key + '" and "' + seen.get(id) + '" map to the same id'); seen.set(id, key); }
}
function caseRef(secret, caseId) {
  if (String(secret || '').length < 32) throw new EnvelopeError('refSecret must be at least 32 characters');
  return 'cx_' + crypto.createHmac('sha256', secret).update('emr-context-case-ref:' + caseId).digest('hex').slice(0, 32);
}
const rankOf = rows => new Map(rows.slice().sort((a, b) => Number(a.id) - Number(b.id)).map((r, i) => [Number(r.id), i + 1]));
const T_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/, T_BARE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

// caseRow {id}; pins {sets, pathways} (rows as read by the route: sets have id, slug, version, definition_json, state; pathways have id, slug, version);
// observations (id, applied_set_id, field_key, value_type, value_json, unit_display, effective_at, recorded_at, source_type, status, corrects_id, recorded_role);
// events (only counted). exportedAt is an input.
function buildEnvelope({ caseRow, pins, observations, events = [], exportedAt, producerVersion, refSecret }) {
  const sets = pins.sets, pathways = pins.pathways;
  checkUnique(sets.map(s => [s.slug, seg(s.slug)]), 'set');
  checkUnique(pathways.map(p => [p.slug, seg(p.slug)]), 'pathway');
  const setById = new Map(sets.map(s => [Number(s.id), s]));
  const fieldOf = (a, key) => ((a.definition_json || {}).fields || []).find(f => f && f.id === key);
  const obRef = rankOf(observations);
  const corrected = new Set(observations.filter(o => o.corrects_id != null).map(o => Number(o.corrects_id)));
  const withheld = { narrativeObservations: 0, enteredInErrorObservations: 0, unitlessNumbers: 0, derivedObservations: 0, correctionTargetsWithheld: 0, events: events.length };

  const kept = new Set(), out = [];
  const sorted = observations.slice().sort((x, y) => new Date(x.effective_at) - new Date(y.effective_at) || Number(x.id) - Number(y.id));
  for (const o of sorted) {
    if (o.status === 'entered_in_error') { withheld.enteredInErrorObservations++; continue; }
    if (o.value_type === 'text') { withheld.narrativeObservations++; continue; }
    if (o.source_type === 'derived') { withheld.derivedObservations++; continue; }
    const a = setById.get(Number(o.applied_set_id));
    if (!a) throw new EnvelopeError('observation ' + o.id + ' names an applied set that is not in the pins');
    const field = fieldOf(a, o.field_key);
    const item = { id: 'ob-' + obRef.get(Number(o.id)), concept: { id: seg(a.slug) + '.' + seg(o.field_key), codes: [] } };
    if (o.value_type === 'unknown') {
      item.kind = KIND_OF_FIELD[field && field.type] || 'string';
      item.state = 'unknown';
    } else if (o.value_type === 'number' || o.value_type === 'integer') {
      if (!o.unit_display || !/^\S+$/.test(o.unit_display)) { withheld.unitlessNumbers++; continue; }
      item.kind = o.value_type === 'integer' ? 'integer' : 'quantity'; item.value = o.value_json; item.unit = o.unit_display;
    } else if (o.value_type === 'boolean') { item.kind = 'boolean'; item.value = o.value_json; }
    else if (o.value_type === 'select') { item.kind = 'string'; item.value = o.value_json; }
    else if (o.value_type === 'datetime') {
      if (T_OFFSET.test(o.value_json)) { item.kind = 'datetime'; item.value = { value: o.value_json, zone: 'stated' }; }
      else if (T_BARE.test(o.value_json)) { item.kind = 'datetime'; item.value = { value: o.value_json, zone: 'unknown' }; }
      else { withheld.narrativeObservations++; continue; }
    } else throw new EnvelopeError('unknown value_type ' + o.value_type);
    item.effective = time(o.effective_at); item.recorded = time(o.recorded_at);
    item.status = STATUS[o.status]; item.sourceClass = SOURCE_CLASS[o.source_type];
    if (!item.status || !item.sourceClass) throw new EnvelopeError('unknown status or source on observation ' + o.id);
    item.provenance = { roleClass: o.recorded_role || 'unknown', origin: 'emr-enhancer/' + seg(a.slug) + '@' + ver(a.version), verified: false, corrected: corrected.has(Number(o.id)) };
    item._corrects = o.corrects_id; kept.add(Number(o.id));
    out.push({ item, id: Number(o.id) });
  }
  const keptRef = new Map(out.map(({ item, id }) => [id, item.id]));
  const obsOut = out.map(({ item }) => {
    const c = item._corrects; delete item._corrects;
    if (c != null) { if (keptRef.has(Number(c))) item.correctionOf = keptRef.get(Number(c)); else withheld.correctionTargetsWithheld++; }
    return item;
  });

  const uniq = (rows, type) => {
    const m = new Map(rows.map(r => [seg(r.slug) + '|' + ver(r.version), { id: seg(r.slug), type, version: ver(r.version) }]));
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(e => e[1]);
  };
  return {
    envelope: { version: '0.1.0', exportedAt: iso(exportedAt), producer: { system: 'emr-enhancer', version: producerVersion } },
    inclusions: { identity: false, narrative: false, enteredInError: false },
    case: { ref: caseRef(refSecret, caseRow.id) },
    applied: { elements: uniq(sets.filter(s => s.state === 'active'), 'contextual-element'), pathways: uniq(pathways, 'pathway') },
    observations: obsOut,
    events: [],
    'x-emr': { withheld },
  };
}

module.exports = { buildEnvelope, caseRef, EnvelopeError };
