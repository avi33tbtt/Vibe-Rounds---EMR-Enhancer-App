'use strict';
// node --test board-no-reading.test.js
// Chunk 37c5: the ward board shows "No reading for N min" only from an approved, enabled minutes_since_gt rule that is true now.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('./enhancer.html', 'utf8');
const grab = (re) => { const m = html.match(re); assert.ok(m, 'not found: ' + re); return m[0]; };
const ctx = { console }; ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('./cds-rules.js', 'utf8'), ctx);
vm.runInContext(grab(/function boardNoReading\(.*\n/) + ';this.boardNoReading=boardNoReading;', ctx);
const { boardNoReading } = ctx;

const NOW = Date.parse('2026-11-20T12:00:00Z');
const set = (rules) => ({ setId: 'care.vitals', kind: 'care', sections: [{ fields: [
  { id: 'v_time', type: 'datetime', repeat: true, group: 'v' },
  { id: 'v_hr', type: 'number', repeat: true, group: 'v', label: 'HR' }] }], rules });
const rule = (extra) => Object.assign({ ruleId: 'r1', fieldRef: 'care.vitals/v_hr', op: 'minutes_since_gt', threshold: 60,
  indicator: 'info', summary: 'Check', enabled: true, provenance: { verifiedBy: 'RN Test' } }, extra);
const kase = { applied: [{ setId: 'care.vitals' }], values: { 'care.vitals/@v': [{ v_time: new Date(NOW - 90 * 6e4).toISOString(), v_hr: '70' }] } };
const run = (rules) => boardNoReading(ctx.CDS.evalRules(kase, [set(rules)], NOW), 'care.vitals');

test('no rule: nothing is shown', () => assert.equal(run([]), null));
test('unapproved rule never shows', () => assert.equal(run([rule({ provenance: { verifiedBy: '' } })]), null));
test('disabled rule never shows', () => assert.equal(run([rule({ enabled: false })]), null));
test('approved rule not yet true shows nothing', () => assert.equal(run([rule({ threshold: 120 })]), null));
test('approved rule true now shows the recorded age, not the threshold', () => assert.equal(run([rule()]), 90));
test('only minutes_since_gt alerts count, and only for that set', () => {
  assert.equal(boardNoReading([{ op: '>', setId: 'care.vitals', value: 5 }], 'care.vitals'), null);
  assert.equal(boardNoReading([{ op: 'minutes_since_gt', setId: 'other', value: 5 }], 'care.vitals'), null);
  assert.equal(boardNoReading(null, 'care.vitals'), null);
});
