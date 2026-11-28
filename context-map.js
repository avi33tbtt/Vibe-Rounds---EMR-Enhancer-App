'use strict';
// Task R9c: context membership for the longitudinal explorer. Pure: no database, no clock, no writes, no AI, no text guessing.
// Mapping home decided in docs/LONGITUDINAL-MAP.md section 4: plain data in this file, changed by pull request (no table, no route).
// An event belongs to a context only through something written down: its applied set slug, or an exact listed problem term, or an
// active pin of a listed set on its case. Every membership keeps its reasons. Nothing here is a clinical rule, threshold or advice.
// SYNTHETIC DEMO DATA - NOT FOR CLINICAL USE.

// The clinician's own words and the repo's own set slugs, listed by hand. Row R9d-1 added the hypertension demo set and the combined pathway.
const CONTEXTS = {
  diabetes: {
    label: 'Diabetes',
    setSlugs: ['dm_ctx', 'hba1c_mon', 'glucose_ss', 'foot_ulcer', 'dka_ctx'],
    pathwaySlugs: ['pw_dm', 'pw_dm_ckd_foot', 'pw_dka', 'pw_dm_ckd_htn'],
    problemTerms: ['Diabetes mellitus', 'Type 1 diabetes mellitus', 'Type 2 diabetes mellitus', 'Diabetic ketoacidosis', 'Diabetic foot ulcer'],
  },
  ckd: {
    label: 'Chronic kidney disease',
    setSlugs: ['ckd_ctx'],
    pathwaySlugs: ['pw_dm_ckd_foot', 'pw_dm_ckd_htn'],
    problemTerms: ['Chronic kidney disease'],
  },
  hypertension: {
    label: 'Hypertension',
    setSlugs: ['htn_ctx'],
    pathwaySlugs: ['pw_dm_ckd_htn'],
    problemTerms: ['Hypertension', 'Essential hypertension'],
  },
};
// Sets that belong to no single condition. Their values show in the overall view labelled "no single condition". urine_io (fluid balance) is not mapped to CKD.
const SHARED_SET_SLUGS = ['vitals', 'urine_io'];
const SHARED_LABEL = 'no single condition';

class ContextError extends Error { constructor(m) { super(m); this.name = 'ContextError'; } }

const norm = s => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
const CONTEXT_KEYS = Object.keys(CONTEXTS);
const SET_KINDS = ['observation', 'context_change'];           // these carry their own set slug
const CASE_KINDS = ['note', 'note_amendment', 'encounter'];     // no label to match: only the case's active pins can place them
const LABEL_KINDS = ['problem', 'allergy', 'medication'];       // exact term first, then the case's active pins

// A pin is { setSlug, pathwaySlug (or null), active (false = withdrawn) }. Pins are given per case: { [caseId]: [pin] }.
function activePins(casePins, caseId) {
  if (!casePins || caseId === null || caseId === undefined) return [];
  const list = casePins[caseId];
  return Array.isArray(list) ? list.filter(p => p && p.active !== false && typeof p.setSlug === 'string') : [];
}

// D15: contexts a pathway version declares ({ id, label, elements }), carried on a pin as `contexts` (an array, or null for a hand-made pathway).
// Package text is untrusted (ED-96): an invalid context is ignored, never thrown.
const PKG_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/, RESERVED = ['all', 'shared', 'unmapped'];
const plainLabel = l => typeof l === 'string' && l.length >= 1 && l.length <= 80 && !/[\u0000-\u001f\u007f<>]/.test(l);
const validContexts = list => (Array.isArray(list) ? list : []).filter(c => c && typeof c === 'object' && typeof c.id === 'string' && PKG_ID_RE.test(c.id) && !RESERVED.includes(c.id)
  && plainLabel(c.label) && Array.isArray(c.elements) && c.elements.every(e => typeof e === 'string'));
const BUILTIN = { keys: CONTEXT_KEYS, labels: Object.assign(Object.create(null), ...CONTEXT_KEYS.map(k => ({ [k]: CONTEXTS[k].label }))) };

// Keys and labels for a set of per-case pins: the built-in keys, then package context ids from ACTIVE pins (ED-96). Built-in labels always win.
function contextDefs(casePins) {
  const found = [];
  for (const list of Object.values(casePins || {})) {
    if (!Array.isArray(list)) continue;
    for (const p of list) if (p && p.active !== false && typeof p.pathwaySlug === 'string') for (const c of validContexts(p.contexts)) found.push({ id: c.id, label: c.label, pathway: p.pathwaySlug });
  }
  found.sort((a, b) => (a.pathway < b.pathway ? -1 : a.pathway > b.pathway ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const labels = Object.assign(Object.create(null), BUILTIN.labels), keys = CONTEXT_KEYS.slice();
  for (const c of found) if (!(c.id in labels)) { labels[c.id] = c.label; keys.push(c.id); }
  return { keys, labels, pathway: true };
}

function add(found, key, reason, D) {
  if (!D.keys.includes(key)) throw new ContextError('unknown context: ' + key);
  const have = found.get(key) || [];
  if (!have.includes(reason)) have.push(reason);
  found.set(key, have);
}

// One event -> { contexts: [{ key, label, reasons: [...] }], scope: 'condition' | 'shared' | 'unmapped', scopeLabel }.
// Rule 2: a pathway name never moves an observation; it is only added as a second reason where the observation's own set already qualifies.
function membership(event, casePins, defs) {
  if (!event || typeof event !== 'object') throw new ContextError('an event must be an object');
  const found = new Map();
  const slug = typeof event.setSlug === 'string' && event.setSlug ? event.setSlug : null;
  const pins = activePins(casePins, event.caseId);
  const D = defs || BUILTIN;
  // D15 / ED-97: a pin whose pathway version has `contexts` is placed only by those contexts; every other pin keeps the built-in lists.
  const covered = p => D.pathway === true && Array.isArray(p.contexts);
  const pkgKeys = p => validContexts(p.contexts).filter(c => c.elements.includes(p.setSlug)).map(c => c.id);

  if (SET_KINDS.includes(event.kind) && slug) {
    const pin = pins.find(p => p.setSlug === slug);
    if (pin && covered(pin)) for (const key of pkgKeys(pin)) add(found, key, 'pathway:' + pin.pathwaySlug + '/' + key, D);
    else for (const key of CONTEXT_KEYS) {
      if (!CONTEXTS[key].setSlugs.includes(slug)) continue;
      add(found, key, 'set:' + slug, D);
      if (pin && pin.pathwaySlug && CONTEXTS[key].pathwaySlugs.includes(pin.pathwaySlug)) add(found, key, 'pathway:' + pin.pathwaySlug, D);
    }
  }
  if (LABEL_KINDS.includes(event.kind) && typeof event.label === 'string' && event.label.trim()) {
    const label = norm(event.label);                              // whole label, case-insensitive, never a substring
    for (const key of CONTEXT_KEYS) {
      const hit = CONTEXTS[key].problemTerms.find(t => norm(t) === label);
      if (hit) add(found, key, 'term:' + hit, D);
    }
  }
  if (LABEL_KINDS.includes(event.kind) || CASE_KINDS.includes(event.kind)) {
    for (const p of pins) {
      if (covered(p)) { for (const key of pkgKeys(p)) add(found, key, 'case_set:' + p.setSlug, D); continue; }
      for (const key of CONTEXT_KEYS) if (CONTEXTS[key].setSlugs.includes(p.setSlug)) add(found, key, 'case_set:' + p.setSlug, D);
    }
  }

  const contexts = [...found.entries()].map(([key, reasons]) => ({ key, label: D.labels[key], reasons }));
  if (contexts.length) return { contexts, scope: 'condition', scopeLabel: contexts.map(c => c.label).join(', ') };
  if (SET_KINDS.includes(event.kind) && slug && SHARED_SET_SLUGS.includes(slug)) return { contexts: [], scope: 'shared', scopeLabel: SHARED_LABEL };
  return { contexts: [], scope: 'unmapped', scopeLabel: 'unmapped' };
}

// Projected events -> copies with `contexts`, `scope`, `scopeLabel`. A repeated key is kept once and counted. Inputs are not changed.
function annotate(events, casePins, defs) {
  if (!Array.isArray(events)) throw new ContextError('events must be a list');
  const seen = new Map();
  let duplicates = 0;
  for (const e of events) {
    const key = e && e.key !== undefined ? e.key : e && e.kind + ':' + e.sourceId;
    if (seen.has(key)) { duplicates++; continue; }
    seen.set(key, { ...e, ...membership(e, casePins, defs) });
  }
  return { events: [...seen.values()], duplicates };
}

// One context, several contexts (any of them), or null/empty for the overall view (everything, unmapped and shared included). Each source row once.
function filterByContexts(annotated, keys, defs) {
  if (!Array.isArray(annotated)) throw new ContextError('events must be a list');
  if (keys === null || keys === undefined || (Array.isArray(keys) && keys.length === 0)) return annotated.slice();
  if (!Array.isArray(keys)) throw new ContextError('contexts must be a list');
  const D = defs || BUILTIN;
  for (const k of keys) if (!D.keys.includes(k)) throw new ContextError('unknown context: ' + String(k).slice(0, 40));
  const out = [], seen = new Set();
  for (const e of annotated) {
    if (seen.has(e.key) || !e.contexts.some(c => keys.includes(c.key))) continue;
    seen.add(e.key); out.push(e);
  }
  return out;
}

// Counts for the filter chips: rows per context (a row in two contexts counts in both), plus shared and unmapped. `all` counts each row once.
function contextCounts(annotated, defs) {
  const counts = { all: 0, shared: 0, unmapped: 0 };
  for (const k of (defs || BUILTIN).keys) counts[k] = 0;
  const seen = new Set();
  for (const e of annotated) {
    if (seen.has(e.key)) continue;
    seen.add(e.key); counts.all++;
    if (e.scope === 'shared') counts.shared++; else if (e.scope === 'unmapped') counts.unmapped++;
    for (const c of e.contexts) if (Object.prototype.hasOwnProperty.call(counts, c.key)) counts[c.key]++;   // a key outside `defs` is not counted (never NaN)
  }
  return counts;
}

module.exports = { CONTEXTS, CONTEXT_KEYS, contextDefs, SHARED_SET_SLUGS, SHARED_LABEL, ContextError, membership, annotate, filterByContexts, contextCounts };
