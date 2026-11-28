'use strict';
// Task D12a: pure composed form model (composed-form.js). No database, no DOM.
// Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeForm } = require('../composed-form');
const { buildForm } = require('../pathway-form');

const F = (id, label, concept) => ({ id, label, type: 'text', ...(concept ? { concept } : {}) });
const SETS = () => ({
  dm: { title: 'DM', fields: [F('hba1c', 'HbA1c', 'glycated-hb'), F('bp', 'BP')] },
  ckd: { title: 'CKD', fields: [F('hb_a1c', 'HbA1c (kidney view)', 'glycated-hb'), F('egfr', 'eGFR', 'egfr'), F('bp2', 'BP')] },
});
const el = (set, extra = {}) => ({ kind: 'element', set, ...extra });
const P = (slug, sections, contexts = []) => ({ slug, version: 1, entryForm: { sections }, contexts });
const A = () => P('dm-path', [{ id: 's1', label: 'Monitoring', items: [el('dm')] }], [{ id: 'c1', label: 'Diabetes', elements: ['dm'] }]);
const B = () => P('ckd-path', [{ id: 's1', label: 'Monitoring', items: [el('ckd', { rowGroups: [['hb_a1c', 'egfr'], ['hb_a1c']] }), { kind: 'section', section: 'core.problems' }] }], [{ id: 'c1', label: 'Diabetes', elements: ['dm', 'ckd'] }, { id: 'c2', label: 'Kidney', elements: ['ckd'] }]);
const ids = sec => sec.items.flatMap(i => i.kind === 'element' ? i.fields.map(f => f.id) : []);

test('1. shared section id: one merged section, items in applied order', () => {
  const r = composeForm({ pathways: [A(), B()], sets: SETS() });
  assert.equal(r.sections.length, 1);
  assert.deepEqual(r.sections[0].items.map(i => i.kind + ':' + (i.set || i.section)), ['element:dm', 'element:ckd', 'section:core.problems']);
});

test('2. shared concept: drawn once at the owner; the user field is listed under shared', () => {
  const r = composeForm({ pathways: [A(), B()], sets: SETS() });
  assert.deepEqual(ids(r.sections[0]), ['hba1c', 'bp', 'egfr', 'bp2']);
  assert.deepEqual(r.shared, [{ concept: 'glycated-hb', owner: { set: 'dm', field: 'hba1c' }, users: [{ set: 'ckd', field: 'hb_a1c' }] }]);
  assert.equal(r.sections[0].items[0].fields[0].concept, 'glycated-hb');
  assert.deepEqual(r.sections[0].items[1].rows, [['egfr']], 'row groups lose the dropped field; an emptied group goes');
});

test('3. same label but no concept: both kept (nothing is matched by label)', () => {
  const s = SETS(); s.ckd.fields = [F('bpx', 'BP')];
  const r = composeForm({ pathways: [A(), P('b', [{ id: 's1', label: 'Monitoring', items: [el('ckd')] }])], sets: s });
  assert.deepEqual(ids(r.sections[0]), ['hba1c', 'bp', 'bpx']); assert.deepEqual(r.shared, []);
});

test('4. the same set in both pathways is placed once', () => {
  const r = composeForm({ pathways: [A(), P('b', [{ id: 's2', label: 'Again', items: [el('dm')] }])], sets: SETS() });
  assert.equal(ids(r.sections[0]).filter(x => x === 'hba1c').length, 1);
  assert.deepEqual(r.sections[1].items, [], 'the second placement is dropped');
  assert.deepEqual(r.unplaced, ['ckd']);
});

test('5. section label conflict: first label wins, note section-label; a set left with no field is noted', () => {
  const b = B(); b.entryForm.sections[0].label = 'Other';
  const r = composeForm({ pathways: [A(), b], sets: SETS() });
  assert.equal(r.sections[0].label, 'Monitoring'); assert.deepEqual(r.notes, [{ code: 'section-label', id: 's1' }]);
  const s = SETS(); s.ckd.fields = [F('hb_a1c', 'x', 'glycated-hb')];
  const r2 = composeForm({ pathways: [A(), B()], sets: s });
  assert.ok(r2.notes.some(n => n.code === 'no-field-left' && n.id === 'ckd'));
});

test('6. contexts: union by id, elements deduplicated in first-seen order', () => {
  const r = composeForm({ pathways: [A(), B()], sets: SETS() });
  assert.deepEqual(r.contexts, [{ id: 'c1', label: 'Diabetes', sets: ['dm', 'ckd'] }, { id: 'c2', label: 'Kidney', sets: ['ckd'] }]);
});

test('7. hostile strings stay plain strings; problems are codes with fixed text', () => {
  const X = '<img src=x onerror=1>', s = SETS(); s.dm.title = X;
  const a = P('a', [{ id: X, label: X, items: [el('dm'), el('missing-set'), { kind: 'section', section: X }] }]);
  const r = composeForm({ pathways: [a], sets: s });
  assert.equal(r.sections[0].label, X); assert.equal(r.sections[0].items[0].title, X);
  assert.deepEqual(r.problems.map(p => p.code).sort(), ['section-unknown', 'set-missing']);
  assert.ok(r.problems.every(p => !p.message.includes('<')));
});

test('8. inputs are not mutated; output is repeatable; one pathway gives the buildForm sections', () => {
  const inp = { pathways: [A(), B()], sets: SETS() }, copy = JSON.parse(JSON.stringify(inp));
  const r1 = composeForm(inp), r2 = composeForm(inp);
  assert.deepEqual(inp, copy); assert.deepEqual(r1, r2);
  const one = composeForm({ pathways: [B()], sets: SETS() }), plain = buildForm({ entryForm: B().entryForm, contexts: B().contexts, sets: SETS() });
  assert.deepEqual(one.sections.map(s => [s.id, s.label, s.items.map(i => i.set || i.section)]), plain.sections.map(s => [s.id, s.label, s.items.map(i => i.set || i.section)]));
});
