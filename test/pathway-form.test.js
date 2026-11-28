'use strict';
// Task D10: pure pathway form model. No database. Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildForm } = require('../pathway-form');

const sets = () => ({
  vit: { title: 'Vitals', fields: [{ id: 'hr', label: 'Heart rate', type: 'number', unit: '/min' }, { id: 'bp', label: 'BP', type: 'number' }, { id: 'rhythm', label: 'Rhythm', type: 'select', options: ['regular', 'irregular'] }] },
  glu: { title: 'Glucose', fields: [{ id: 'g', label: 'Glucose', type: 'number', unit: 'mmol/L', derived: true }] },
});
const form = items2 => ({ sections: [{ id: 'main', label: 'Main', items: [{ kind: 'element', set: 'vit' }] }, { id: 'more', label: 'More', items: items2 || [{ kind: 'element', set: 'glu' }] }] });
const codes = r => r.problems.map(p => p.code);

test('1. two sets in two sections: layout order, all fields in set order, unit, options and derived kept', () => {
  const r = buildForm({ entryForm: form(), contexts: [], sets: sets() });
  assert.deepEqual(r.sections.map(s => s.id), ['main', 'more']);
  assert.deepEqual(r.sections[0].items[0].fields.map(f => f.id), ['hr', 'bp', 'rhythm']);
  assert.equal(r.sections[0].items[0].fields[0].unit, '/min'); assert.deepEqual(r.sections[0].items[0].fields[2].options, ['regular', 'irregular']);
  assert.equal(r.sections[1].items[0].fields[0].derived, true); assert.deepEqual(r.problems, []); assert.deepEqual(r.unplaced, []);
});

test('2. a fields subset and rowGroups are kept; an id outside the set is skipped with field-unknown', () => {
  const ef = { sections: [{ id: 'a', label: 'A', items: [{ kind: 'element', set: 'vit', fields: ['rhythm', 'hr', 'nope'], rowGroups: [['rhythm', 'hr'], ['nope']], visibleByDefault: false }] }] };
  const r = buildForm({ entryForm: ef, contexts: [], sets: sets() }), it = r.sections[0].items[0];
  assert.deepEqual(it.fields.map(f => f.id), ['rhythm', 'hr']); assert.deepEqual(it.rows, [['rhythm', 'hr']]); assert.equal(it.visible, false); assert.deepEqual(codes(r), ['field-unknown']);
});

test('3. section items map to tabs; care-episode has no tab and a warning; an unknown id is skipped', () => {
  const r = buildForm({ entryForm: form([{ kind: 'section', section: 'core.problems' }, { kind: 'section', section: 'core.investigations' }, { kind: 'section', section: 'core.care-episode' }, { kind: 'section', section: 'core.bogus' }]), contexts: [], sets: sets() });
  assert.deepEqual(r.sections[1].items.map(i => i.tab), ['problems', 'orders', null]);
  assert.deepEqual(codes(r), ['section-marker', 'section-unknown']);
});

test('4. a missing set, a field placed twice and an unplaced set give their codes', () => {
  const ef = { sections: [{ id: 'a', label: 'A', items: [{ kind: 'element', set: 'ghost' }, { kind: 'element', set: 'vit', fields: ['hr', 'hr'] }] }] };
  const r = buildForm({ entryForm: ef, contexts: [], sets: sets() });
  assert.deepEqual(codes(r).sort(), ['field-twice', 'set-missing']); assert.deepEqual(r.unplaced, ['glu']); assert.deepEqual(r.sections[0].items[0].fields.map(f => f.id), ['hr']);
});

test('5. contexts keep only sets that exist', () => {
  const r = buildForm({ entryForm: form(), contexts: [{ id: 'dm', label: 'Diabetes', elements: ['glu', 'ghost'] }], sets: sets() });
  assert.deepEqual(r.contexts, [{ id: 'dm', label: 'Diabetes', sets: ['glu'] }]);
});

test('6. inputs are not changed and the same input gives the same output', () => {
  const i = { entryForm: form(), contexts: [{ id: 'dm', label: 'D', elements: ['glu'] }], sets: sets() }, copy = JSON.parse(JSON.stringify(i));
  const a = buildForm(i), b = buildForm(i);
  assert.deepEqual(i, copy); assert.deepEqual(a, b);
  a.sections[0].items[0].fields[0].label = 'changed'; assert.equal(i.sets.vit.fields[0].label, 'Heart rate');
});

test('7. hostile text stays a plain string; a non-string label becomes empty; messages hold no package text', () => {
  const bad = '<img src=x onerror=alert(1)>', s = sets(); s.vit.title = bad; s.vit.fields[0].label = { x: 1 };
  const ef = { sections: [{ id: 'a', label: bad, items: [{ kind: 'element', set: 'vit', fields: ['hr', bad] }, { kind: 'section', section: bad }] }] };
  const r = buildForm({ entryForm: ef, contexts: [], sets: s });
  assert.equal(r.sections[0].label, bad); assert.equal(r.sections[0].items[0].title, bad); assert.equal(r.sections[0].items[0].fields[0].label, '');
  assert.ok(!JSON.stringify(r.problems).includes('img'));
});

test('8. limits: 31 sets and over 200 fields give too-large without a crash; junk input is safe', () => {
  const many = {}, items = [];
  for (let i = 0; i < 31; i++) { many['s' + i] = { title: 'T', fields: [{ id: 'f', label: 'F', type: 'text' }] }; items.push({ kind: 'element', set: 's' + i }); }
  const r = buildForm({ entryForm: { sections: [{ id: 'a', label: 'A', items }] }, contexts: [], sets: many });
  assert.equal(r.sections[0].items.length, 30); assert.ok(codes(r).includes('too-large'));
  const wide = { w: { title: 'W', fields: Array.from({ length: 201 }, (_, i) => ({ id: 'f' + i, label: 'F', type: 'text' })) } };
  assert.ok(codes(buildForm({ entryForm: { sections: [{ id: 'a', label: 'A', items: [{ kind: 'element', set: 'w' }] }] }, sets: wide })).includes('too-large'));
  assert.deepEqual(buildForm(null), { sections: [], contexts: [], unplaced: [], problems: [] });
});
