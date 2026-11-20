'use strict';
// node --test views-followup.test.js  (no database)
// Phase V, V8d7: field.followUp. Validator cases use a made-up set; the screen helper followUpOf is read from enhancer.html and run on the same made-up set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Views = require('./views.js');

const made = (over) => {
  const s = { setId: 'x.made', sections: [{ title: 'T', fields: [
    { id: 'm_when', label: 'Reading date', type: 'date', repeat: true, group: 'mg' },
    { id: 'm_val', label: 'Reading', type: 'number', repeat: true, group: 'mg' },
    { id: 'm_next', label: 'Next check', type: 'date', followUp: { label: 'Check', history: { group: 'mg', valueField: 'm_val', dateField: 'm_when' } } }] }] };
  if (over) over(s.sections[0].fields[2].followUp, s.sections[0].fields);
  return s;
};
const errs = (s) => Views.validateView(s).errors;

test('V8d7: a made-up set with followUp is valid, with or without history', () => {
  assert.deepEqual(errs(made()), []);
  assert.deepEqual(errs(made((f) => { delete f.history; })), []);
});
test('V8d7: followUp errors are refused', () => {
  assert.ok(errs(made((f) => { f.extra = 1; })).some((e) => /unknown key "extra"/.test(e)));
  assert.ok(errs(made((f) => { f.label = ''; })).some((e) => /label must be text/.test(e)));
  assert.ok(errs(made((f) => { f.history.group = 'zz'; })).some((e) => /not in group "zz"/.test(e)));
  assert.ok(errs(made((f) => { f.history.valueField = 'm_when'; })).some((e) => /number or integer/.test(e)));
  assert.ok(errs(made((f) => { f.history.dateField = 'm_val'; })).some((e) => /date or datetime/.test(e)));
  assert.ok(errs(made((f) => { delete f.history.dateField; })).some((e) => /dateField is required/.test(e)));
  assert.ok(errs(made((f, fl) => { fl[2].type = 'text'; })).some((e) => /must be on a date field/.test(e)));
  assert.ok(errs(made((f, fl) => { fl[2].repeat = true; })).some((e) => /cannot be on a repeat field/.test(e)));
  assert.ok(errs(made((f, fl) => { fl[1].followUp = { label: 'B' }; })).some((e) => /only one field/.test(e)));
});
test('V8d7: followUpOf (the code in enhancer.html) reads the flag and returns null without it', () => {
  const src = fs.readFileSync('./enhancer.html', 'utf8').match(/function followUpOf\(s\)\{[^\n]*\}/);
  assert.ok(src, 'followUpOf not found in enhancer.html');
  const ctx = { flS: (s) => s.sections.flatMap((x) => x.fields) };
  vm.runInNewContext(src[0] + ';this.followUpOf=followUpOf', ctx);
  const u = ctx.followUpOf(made());
  assert.equal(u.id, 'm_next'); assert.equal(u.label, 'Check'); assert.equal(u.h.valueField, 'm_val');
  assert.equal(ctx.followUpOf(made((f, fl) => { delete fl[2].followUp; })), null);
  assert.equal(ctx.followUpOf(null), null);
});
