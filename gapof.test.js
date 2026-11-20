'use strict';
// node --test gapof.test.js  (no database)
// Phase V, V8d8: gapOf reads the "minutes between two fields" rule from the demo set's own field data (derived.op 'minutes_between').
// The real gapOf is read from enhancer.html and run on a made-up set, so it is proved generic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const made = { setId: 'x.made', sections: [{ fields: [
  { id: 'm_start', type: 'datetime' }, { id: 'm_end', type: 'datetime' },
  { id: 'm_gap', type: 'duration_min', derived: { from: ['m_start', 'm_end'], op: 'minutes_between' } }] }] };
const src = fs.readFileSync('./enhancer.html', 'utf8').match(/function gapOf\(c\)\{[^\n]*\}/);
function run(set, values) {
  const ctx = {
    SNK: 'x.made', getSet: () => set, flS: (s) => s.sections.flatMap((x) => x.fields),
    val: (c, fid) => { const v = c.values[fid]; return v === undefined || v === '' ? '' : v; },
  };
  vm.runInNewContext(src[0] + ';this.gapOf=gapOf', ctx);
  return ctx.gapOf({ values });
}
test('V8d8: gapOf is found in enhancer.html', () => assert.ok(src));
test('V8d8: typed minutes win; otherwise minutes between the two named fields', () => {
  assert.equal(run(made, { m_gap: '90' }), 90);
  assert.equal(run(made, { m_start: '2026-01-01T08:00', m_end: '2026-01-01T09:30' }), 90);
  assert.equal(run(made, { m_start: '2026-01-01T08:00' }), null);
  assert.equal(run(made, {}), null);
});
test('V8d8: a set with no such rule, or no set, gives null', () => {
  assert.equal(run({ setId: 'x.made', sections: [{ fields: [{ id: 'm_gap', type: 'duration_min' }] }] }, { m_gap: '5' }), null);
  assert.equal(run(null, { m_gap: '5' }), null);
});
