'use strict';
// Row R9c: the pure context membership (context-map.js). No database needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectTimeline } = require('../timeline-projection');
const { CONTEXTS, membership, annotate, filterByContexts, contextCounts, ContextError } = require('../context-map');

const obs = (o = {}) => ({ kind: 'observation', sourceId: 1, caseId: 3, at: '2026-01-05T08:00:00Z', effectiveAt: '2026-01-05T08:00:00Z', recordedAt: '2026-01-06T09:00:00Z',
  status: 'final', fieldKey: 'hba1c', valueType: 'number', value: 7.2, unit: '%', appliedSetId: 9, setSlug: 'hba1c_mon', ...o });
const prob = (o = {}) => ({ kind: 'problem', sourceId: 1, caseId: 3, at: '2026-01-05T08:00:00Z', effectiveAt: '2024-03-01', recordedAt: '2026-01-05T08:00:00Z', status: 'active', label: 'Asthma', ...o });
const note = (o = {}) => ({ kind: 'note', sourceId: 1, caseId: 3, at: '2026-01-05T08:00:00Z', status: 'signed', ...o });
const keys = m => m.contexts.map(c => c.key);

test('an observation belongs to a context only through its own set slug, and the reason is kept', () => {
  const m = membership(obs());
  assert.deepEqual(keys(m), ['diabetes']); assert.deepEqual(m.contexts[0].reasons, ['set:hba1c_mon']); assert.equal(m.scope, 'condition');
  assert.deepEqual(keys(membership(obs({ setSlug: 'ckd_ctx' }))), ['ckd']);
});

test('a pathway name alone never moves an observation; it is only a second reason where the set already qualifies', () => {
  const pins = { 3: [{ setSlug: 'vitals', pathwaySlug: 'pw_dm_ckd_foot', active: true }, { setSlug: 'ckd_ctx', pathwaySlug: 'pw_dm_ckd_foot', active: true }] };
  const vitals = membership(obs({ setSlug: 'vitals', fieldKey: 'sbp' }), pins);
  assert.deepEqual(keys(vitals), []); assert.equal(vitals.scope, 'shared'); assert.equal(vitals.scopeLabel, 'no single condition');
  const ckd = membership(obs({ setSlug: 'ckd_ctx', fieldKey: 'creat' }), pins);
  assert.deepEqual(ckd.contexts[0].reasons, ['set:ckd_ctx', 'pathway:pw_dm_ckd_foot']);
});

test('fluid balance (urine_io) is shared, not CKD; an unknown slug, no slug and a missing pin stay unmapped', () => {
  assert.equal(membership(obs({ setSlug: 'urine_io' })).scope, 'shared');
  assert.equal(membership(obs({ setSlug: 'some_new_set' })).scope, 'unmapped');
  assert.equal(membership(obs({ setSlug: null })).scope, 'unmapped');
});

test('problems match only an exact listed term: whole label, any case and spacing, never a substring', () => {
  assert.deepEqual(membership(prob({ label: '  type 2   DIABETES mellitus ' })).contexts[0].reasons, ['term:Type 2 diabetes mellitus']);
  assert.equal(membership(prob({ label: 'Type 2 diabetes mellitus with neuropathy' })).scope, 'unmapped', 'longer label is not guessed');
  assert.equal(membership(prob({ label: 'Hyperkalaemia' })).scope, 'unmapped');
  assert.deepEqual(keys(membership(prob({ label: 'Hypertension' }))), ['hypertension'], 'works by whole term as well as by set');
});

test('notes, encounters and listed items take context from an ACTIVE pin of a listed set on their case; withdrawn pins and other cases give nothing', () => {
  const pins = { 3: [{ setSlug: 'dm_ctx', pathwaySlug: null, active: true }, { setSlug: 'ckd_ctx', pathwaySlug: null, active: false }], 4: [{ setSlug: 'ckd_ctx', active: true }] };
  const n = membership(note(), pins);
  assert.deepEqual(keys(n), ['diabetes']); assert.deepEqual(n.contexts[0].reasons, ['case_set:dm_ctx']);
  assert.equal(membership(note({ caseId: 4 }), pins).contexts[0].key, 'ckd');
  assert.equal(membership(note({ caseId: 9 }), pins).scope, 'unmapped');
  assert.equal(membership(note({ caseId: null }), pins).scope, 'unmapped');
  assert.equal(membership(note(), undefined).scope, 'unmapped');
  assert.deepEqual(keys(membership({ kind: 'encounter', sourceId: 2, caseId: 3 }, pins)), ['diabetes']);
});

test('an observation is NOT placed by its case pins, and a problem does not give its case an observation membership', () => {
  const pins = { 3: [{ setSlug: 'dm_ctx', active: true }] };
  assert.equal(membership(obs({ setSlug: 'vitals' }), pins).scope, 'shared');
  assert.equal(membership(obs({ setSlug: null }), pins).scope, 'unmapped');
});

test('one record can sit in two contexts, with a reason for each; the combined view shows it once', () => {
  const pins = { 3: [{ setSlug: 'dm_ctx', active: true }, { setSlug: 'ckd_ctx', active: true }] };
  const { events } = annotate(projectTimeline([note({ sourceId: 5 }), obs({ sourceId: 6 }), obs({ sourceId: 7, setSlug: 'ckd_ctx', fieldKey: 'creat' })]).events, pins);
  const n = events.find(e => e.key === 'note:5');
  assert.deepEqual(keys(n), ['diabetes', 'ckd']);
  const both = filterByContexts(events, ['diabetes', 'ckd']);
  assert.deepEqual(both.map(e => e.key).sort(), ['note:5', 'observation:6', 'observation:7'], 'note:5 once');
  assert.deepEqual(filterByContexts(events, ['ckd']).map(e => e.key).sort(), ['note:5', 'observation:7']);
});

test('the overall view (no filter) keeps unmapped and shared events; a filter drops them; unknown context names are refused', () => {
  const { events } = annotate(projectTimeline([obs({ sourceId: 1 }), obs({ sourceId: 2, setSlug: 'vitals' }), prob({ sourceId: 3 })]).events, {});
  assert.equal(filterByContexts(events, null).length, 3); assert.equal(filterByContexts(events, []).length, 3);
  assert.deepEqual(filterByContexts(events, ['diabetes']).map(e => e.key), ['observation:1']);
  assert.throws(() => filterByContexts(events, ['asthma']), ContextError);
  assert.throws(() => filterByContexts(events, 'diabetes'), ContextError);
  assert.deepEqual(contextCounts(events), { all: 3, shared: 1, unmapped: 1, diabetes: 1, ckd: 0, hypertension: 0 });
});

test('annotate keeps a repeated source key once and counts it; inputs are not changed; entered-in-error stays its own state', () => {
  const input = projectTimeline([obs({ sourceId: 1 }), obs({ sourceId: 2, status: 'entered_in_error' })]).events;
  const copy = JSON.stringify(input);
  const { events, duplicates } = annotate([...input, input[0]], {});
  assert.equal(duplicates, 1); assert.equal(events.length, 2); assert.equal(JSON.stringify(input), copy);
  assert.equal(events.find(e => e.key === 'observation:2').inError, true);
  assert.deepEqual(keys(events.find(e => e.key === 'observation:2')), ['diabetes'], 'an error row keeps its context so the filter does not hide it silently');
});

test('the map itself is sane: every context lists only strings, no slug sits in two contexts, hypertension has its demo set (R9d-1)', () => {
  const seen = new Map();
  for (const [k, c] of Object.entries(CONTEXTS)) {
    for (const s of [...c.setSlugs, ...c.pathwaySlugs, ...c.problemTerms]) assert.equal(typeof s, 'string');
    for (const s of c.setSlugs) { assert.equal(seen.has(s), false, s + ' is in two contexts'); seen.set(s, k); }
  }
  assert.deepEqual(CONTEXTS.hypertension.setSlugs, ['htn_ctx']);
  assert.throws(() => membership(null), ContextError);
});
