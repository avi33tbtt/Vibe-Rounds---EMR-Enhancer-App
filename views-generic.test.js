'use strict';
// node --test views-generic.test.js
// V4d: renderSummaries (enhancer.html) is generic. A made-up set with different ids gets its sums from its own
// view.summary block, and with the block removed nothing is shown. No clinical set or field id is used here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Views = require('./views.js');

const html = fs.readFileSync('./enhancer.html', 'utf8');
const cut = (from, to) => { const i = html.indexOf(from); assert.ok(i >= 0, 'not found: ' + from); const j = html.indexOf(to, i); assert.ok(j > i, 'not found: ' + to); return html.slice(i, j); };
const code = cut('const esc=', '\n') + '\n' + cut('const flS=', '\n') + '\n' + cut('const SUMW=', 'function dueBadge(');
const ctx = { Views, OVM: false, Date };
vm.createContext(ctx);
vm.runInContext(code + ';this.renderSummaries=renderSummaries;this.SUMW=SUMW;this.setOvm=v=>{OVM=v};', ctx);

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const made = (summary) => ({
  setId: 'test.fluids', kind: 'care', version: 1, title: 'x', contexts: ['care'],
  view: Object.assign({ type: 'flowsheet', timeField: 'w_at' }, summary ? { summary } : {}),
  sections: [{ title: 'Rows', fields: [
    { id: 'w_at', label: 'At', type: 'datetime', repeat: true, group: 'w' },
    { id: 'w_kind', label: 'Kind', type: 'select', options: ['Alpha', 'Beta'], repeat: true, group: 'w' },
    { id: 'w_qty', label: 'Qty', type: 'number', unit: 'units', repeat: true, group: 'w' }] }] });
const block = [{ type: 'sumBy', timeField: 'w_at', keyField: 'w_kind', valueField: 'w_qty', windowsHours: [2, 6], label: 'total of entered rows' }];
const rows = [
  { w_at: ago(10), w_kind: 'Alpha', w_qty: '5' }, { w_at: ago(20), w_kind: 'Alpha', w_qty: 2.5 },
  { w_at: ago(30), w_kind: 'Beta', w_qty: 4 }, { w_at: ago(30), w_kind: 'Beta', w_qty: 99, __status: 'entered_in_error' },
  { w_at: ago(300), w_kind: 'Beta', w_qty: 1000 }];

test('a made-up set with a sumBy block shows its sums, label, unit and window buttons', () => {
  const out = ctx.renderSummaries(made(block), rows);
  assert.match(out, /Total of entered rows/);
  assert.match(out, /Alpha: <b>7\.5<\/b> units/);
  assert.match(out, /Beta: <b>4<\/b> units/, 'entered_in_error and out-of-window rows are not counted');
  assert.match(out, /Last 2 h/); assert.match(out, /Last 6 h/);
  assert.match(out, /no target, limit or comparison/);
});

test('choosing a longer window (kept per set id) changes the sums', () => {
  ctx.SUMW['test.fluids|0'] = 6;
  const out = ctx.renderSummaries(made(block), rows);
  assert.match(out, /Beta: <b>1004<\/b> units/);
  delete ctx.SUMW['test.fluids|0'];
});

test('with the summary block removed nothing is shown', () => {
  assert.equal(ctx.renderSummaries(made(null), rows), '');
  assert.equal(ctx.renderSummaries(made([]), rows), '');
  assert.equal(ctx.renderSummaries({ setId: 'x' }, rows), '');
});

test('an empty window says so and draws no numbers; trend/overview mode draws nothing', () => {
  assert.match(ctx.renderSummaries(made(block), []), /No entered rows in this window/);
  ctx.setOvm(true);
  assert.equal(ctx.renderSummaries(made(block), rows), '');
  ctx.setOvm(false);
});
