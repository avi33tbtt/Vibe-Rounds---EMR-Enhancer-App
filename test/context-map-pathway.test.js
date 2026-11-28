'use strict';
// Task D15: pathway contexts in the pure context map (ED-96, ED-97). No database needed.
// Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const { membership, annotate, filterByContexts, contextCounts, contextDefs, ContextError } = require('../context-map');

const obs = (o = {}) => ({ kind: 'observation', sourceId: 1, caseId: 3, at: '2026-01-05T08:00:00Z', effectiveAt: '2026-01-05T08:00:00Z', recordedAt: '2026-01-06T09:00:00Z',
  status: 'final', fieldKey: 'hba1c', valueType: 'number', value: 7.2, unit: '%', appliedSetId: 9, setSlug: 'hba1c_mon', ...o, key: 'observation:' + (o.sourceId || 1) });
const note = (o = {}) => ({ kind: 'note', sourceId: 2, caseId: 3, at: '2026-01-05T08:00:00Z', status: 'signed', ...o });
const keys = m => m.contexts.map(c => c.key);
const CTX = [{ id: 'renal', label: 'Kidney care', elements: ['pkg_kidney'] }, { id: 'sugar', label: 'Sugar care', elements: ['pkg_sugar', 'pkg_kidney'] }];
const pin = (o = {}) => ({ setSlug: 'pkg_kidney', pathwaySlug: 'pw_pkg', active: true, contexts: CTX, ...o });
const pins = (...list) => ({ 3: list });

test('1. a covered pin places its set in the pathway context, with the pathway reason', () => {
  const p = pins(pin()), d = contextDefs(p);
  const m = membership(obs({ setSlug: 'pkg_kidney' }), p, d);
  assert.deepEqual(keys(m), ['renal', 'sugar']); assert.deepEqual(m.contexts[0].reasons, ['pathway:pw_pkg/renal']); assert.equal(m.contexts[0].label, 'Kidney care'); assert.equal(m.scope, 'condition');
});

test('2. a pin with contexts null gives exactly the old output', () => {
  const old = membership(obs()), withNull = membership(obs(), pins({ setSlug: 'hba1c_mon', pathwaySlug: 'pw_dm', active: true, contexts: null }), contextDefs(pins({ setSlug: 'hba1c_mon', pathwaySlug: 'pw_dm', active: true, contexts: null })));
  assert.deepEqual(withNull, membership(obs(), pins({ setSlug: 'hba1c_mon', pathwaySlug: 'pw_dm', active: true }))); assert.deepEqual(keys(old), ['diabetes']); assert.deepEqual(keys(withNull), ['diabetes']);
});

test('3. a covered set that is in the built-in list but in no pathway context gets no built-in condition', () => {
  const p = pins(pin({ setSlug: 'hba1c_mon' })), m = membership(obs(), p, contextDefs(p));
  assert.deepEqual(keys(m), []); assert.equal(m.scope, 'unmapped');
  const v = pins(pin({ setSlug: 'vitals' })); assert.equal(membership(obs({ setSlug: 'vitals' }), v, contextDefs(v)).scope, 'shared');
});

test('4. a package id equal to a built-in key keeps the built-in label and joins the memberships', () => {
  const p = pins(pin({ contexts: [{ id: 'ckd', label: 'My own label', elements: ['pkg_kidney'] }] })), d = contextDefs(p);
  assert.equal(d.labels.ckd, 'Chronic kidney disease'); assert.equal(d.keys.filter(k => k === 'ckd').length, 1);
  const m = membership(obs({ setSlug: 'pkg_kidney' }), p, d);
  assert.deepEqual(keys(m), ['ckd']); assert.equal(m.contexts[0].label, 'Chronic kidney disease'); assert.deepEqual(m.contexts[0].reasons, ['pathway:pw_pkg/ckd']);
});

test('5. two pathways with the same context id give one key, the first label by slug, each event once', () => {
  const p = pins(pin({ pathwaySlug: 'pw_b', contexts: [{ id: 'renal', label: 'B label', elements: ['pkg_kidney'] }] }), pin({ setSlug: 'pkg_sugar', pathwaySlug: 'pw_a', contexts: [{ id: 'renal', label: 'A label', elements: ['pkg_sugar'] }] }));
  const d = contextDefs(p);
  assert.equal(d.keys.filter(k => k === 'renal').length, 1); assert.equal(d.labels.renal, 'A label');
  const a = annotate([obs({ setSlug: 'pkg_kidney' }), obs({ setSlug: 'pkg_sugar', sourceId: 5 })], p, d);
  assert.equal(a.events.length, 2); assert.deepEqual(contextCounts(a.events, d).renal, 2);
});

test('6. an invalid id, a label with markup or 81 characters, or non-list elements is ignored without a throw', () => {
  const bad = [{ id: 'Bad Id', label: 'x', elements: [] }, { id: 'all', label: 'x', elements: [] }, { id: 'markup', label: '<b>x</b>', elements: [] }, { id: 'long', label: 'x'.repeat(81), elements: [] },
    { id: 'noelems', label: 'x', elements: 'pkg_kidney' }, { id: 'mixed', label: 'x', elements: ['pkg_kidney', 3] }, null, 'text', { id: 'good', label: 'Good', elements: ['pkg_kidney'] }];
  const p = pins(pin({ contexts: bad })), d = contextDefs(p);
  assert.deepEqual(d.keys.slice(3), ['good']);
  assert.deepEqual(keys(membership(obs({ setSlug: 'pkg_kidney' }), p, d)), ['good']);
});

test('7. a withdrawn pin adds no context and no key', () => {
  const p = pins(pin({ active: false })), d = contextDefs(p);
  assert.deepEqual(d.keys, ['diabetes', 'ckd', 'hypertension']);
  assert.deepEqual(keys(membership(obs({ setSlug: 'pkg_kidney' }), p, d)), []);
  assert.deepEqual(keys(membership(note(), pins(pin()), contextDefs(pins(pin())))), ['renal', 'sugar']);
});

test('8. filter and counts accept a package key with defs and throw without it; an unknown key throws either way', () => {
  const p = pins(pin()), d = contextDefs(p), a = annotate([obs({ setSlug: 'pkg_kidney' })], p, d);
  assert.equal(filterByContexts(a.events, ['renal'], d).length, 1);
  assert.throws(() => filterByContexts(a.events, ['renal']), ContextError);
  assert.throws(() => filterByContexts(a.events, ['nope'], d), ContextError); assert.throws(() => filterByContexts(a.events, ['constructor'], d), ContextError);
  assert.equal(contextCounts(a.events, d).renal, 1); assert.equal(contextCounts(a.events).renal, undefined);
});
