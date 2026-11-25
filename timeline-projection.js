'use strict';
// Task R9b: pure read-model projection for the longitudinal explorer. No database, no clock, no writes.
// Input: events as sent by GET /api/patients/:id/timeline (R3g). Output: display events that point at their source rows.
// This is NOT a system of record: it never invents a fact, never merges two source rows, never changes an input.
// Effective time (when it was true) and recorded time (when it was entered) stay separate. Missing times stay null and are flagged.
// Entered-in-error stays its own state (inError) and is never treated as zero, absent or unknown.
// Encounter, note-amendment and context-change kinds are accepted here for later rows; the route does not send them yet.

const KINDS = ['observation', 'note', 'problem', 'allergy', 'medication', 'encounter', 'note_amendment', 'context_change'];
const KIND_LABEL = { observation: 'Value', note: 'Signed note', problem: 'Problem', allergy: 'Allergy', medication: 'Medication', encounter: 'Encounter', note_amendment: 'Note amendment', context_change: 'Context change' };

class ProjectionError extends Error { constructor(m) { super(m); this.name = 'ProjectionError'; } }

// A time is a real ISO date or timestamp, or it is missing (null). Anything else is a mistake in the source and is refused, not guessed.
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
function time(v, what) {
  if (v === null || v === undefined || v === '') return null;
  const s = v instanceof Date ? v.toISOString() : v;
  if (typeof s !== 'string' || !ISO.test(s) || Number.isNaN(new Date(s.length === 10 ? s + 'T00:00:00Z' : s).getTime()))
    throw new ProjectionError(`${what} is not a valid date or time`);
  return s;
}
const ms = s => (s === null ? null : new Date(s.length === 10 ? s + 'T00:00:00Z' : s).getTime());
const isId = v => (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && v.length > 0 && v.length <= 64);
const num = v => (typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : null);

function projectOne(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new ProjectionError('an event must be an object');
  if (!KINDS.includes(e.kind)) throw new ProjectionError('unknown event kind: ' + String(e.kind).slice(0, 40));
  if (!isId(e.sourceId)) throw new ProjectionError('an event needs the id of its source row');
  const at = time(e.at, 'at'), effectiveAt = time(e.effectiveAt, 'effectiveAt'), recordedAt = time(e.recordedAt, 'recordedAt');
  const status = typeof e.status === 'string' && e.status ? e.status : null;
  const out = {
    key: e.kind + ':' + e.sourceId,                  // one source row = one key; used to show a record once
    kind: e.kind, kindLabel: KIND_LABEL[e.kind], sourceId: e.sourceId,
    caseId: e.caseId === undefined ? null : e.caseId,
    encounterId: e.encounterId === undefined ? null : e.encounterId,
    at, effectiveAt, recordedAt,
    timeMissing: { at: at === null, effective: effectiveAt === null, recorded: recordedAt === null },
    day: at === null ? null : at.slice(0, 10),
    status, inError: status === 'entered_in_error',
    by: e.by === undefined ? null : e.by,
    label: e.label === undefined ? null : e.label,
    setSlug: e.setSlug === undefined ? null : e.setSlug,
  };
  if (e.kind === 'observation') {
    out.fieldKey = e.fieldKey === undefined ? null : e.fieldKey;
    out.valueType = e.valueType === undefined ? null : e.valueType;
    out.unit = e.unit === undefined ? null : e.unit;
    out.value = e.value === undefined ? null : e.value;
    out.hasValue = e.value !== null && e.value !== undefined && e.value !== '';   // an empty value is shown as "no value", never as 0
    out.correctsId = e.correctsId === undefined ? null : e.correctsId;
    out.appliedSetId = e.appliedSetId === undefined ? null : e.appliedSetId;
  }
  return out;
}

// Same-time order: time, then kind, then source id. Events without a time go last, in kind and id order, so the order never depends on the input order.
function compare(a, b) {
  const ta = ms(a.at), tb = ms(b.at);
  if (ta !== tb) { if (ta === null) return 1; if (tb === null) return -1; return ta - tb; }
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const na = num(a.sourceId), nb = num(b.sourceId);
  if (na !== null && nb !== null) return na - nb;
  return String(a.sourceId) < String(b.sourceId) ? -1 : String(a.sourceId) > String(b.sourceId) ? 1 : 0;
}

// events -> { events, duplicates }. A repeated key (same source row twice) is kept once and counted; two different rows are never merged.
function projectTimeline(events) {
  if (!Array.isArray(events)) throw new ProjectionError('events must be a list');
  const seen = new Map();
  let duplicates = 0;
  for (const e of events) {
    const p = projectOne(e);
    if (seen.has(p.key)) { duplicates++; continue; }
    seen.set(p.key, p);
  }
  return { events: [...seen.values()].sort(compare), duplicates };
}

// Group by day for display. Events without a time form one group at the end, labelled undated.
function groupByDay(projected) {
  const groups = [];
  for (const e of projected) {
    const day = e.day === null ? 'undated' : e.day;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(e); else groups.push({ day, year: day === 'undated' ? null : day.slice(0, 4), events: [e] });
  }
  return groups;
}

// Previous and next entries of the same field in the same set, for the detail drawer. Entered-in-error rows are skipped; "same field" is set slug (or applied set id) plus field key.
function sameFieldNeighbours(projected, key) {
  const me = projected.find(e => e.key === key);
  if (!me || me.kind !== 'observation') return { previous: null, next: null };
  const lane = e => e.kind === 'observation' && !e.inError && e.fieldKey === me.fieldKey && (e.setSlug || 'set#' + e.appliedSetId) === (me.setSlug || 'set#' + me.appliedSetId);
  const same = projected.filter(lane).filter(e => e.at !== null);
  const i = same.findIndex(e => e.key === key);
  if (i === -1) {   // the selected row itself is in error or undated: neighbours are by time
    const t = ms(me.at);
    const before = same.filter(e => t !== null && ms(e.at) <= t), after = same.filter(e => t !== null && ms(e.at) > t);
    return { previous: before.length ? before[before.length - 1].key : null, next: after.length ? after[0].key : null };
  }
  return { previous: i > 0 ? same[i - 1].key : null, next: i < same.length - 1 ? same[i + 1].key : null };
}

module.exports = { projectTimeline, groupByDay, sameFieldNeighbours, ProjectionError, KINDS };
