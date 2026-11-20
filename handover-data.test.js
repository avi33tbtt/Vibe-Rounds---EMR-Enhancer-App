'use strict';
// node --test handover-data.test.js
// Chunk 37d1: handoverData is a pure function (no rendering, no judgement text). Also guards the boardRow text after the shared-helper refactor.
// V6/V7: handoverData reads its sections through handoverSections() and sectionsData() (the SECTIONS table); with no EMR view pathway in the registry it uses HANDOVER_FALLBACK. All of them are extracted from enhancer.html here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('./enhancer.html', 'utf8');
const grab = (re) => { const m = html.match(re); assert.ok(m, 'not found: ' + re); return m[0]; };
const names = ['flS', 'vk', 'rowsOf', 'rowT', 'grp', 'tcol', 'shortOf', 'isPw', 'ageTxt'];
const code = names.map((n) => grab(new RegExp('^const ' + n + '=.*\\n', 'm'))).join('')
  + ['pairOf', 'rowVals', 'rowText', 'latestOf'].map((n) => grab(new RegExp('^function ' + n + '\\(.*\\n', 'm'))).join('')
  + grab(/^const SECTIONS=\{[\s\S]*?\n\};\n/m) + grab(/^const HANDOVER_FALLBACK=.*\n/m)
  + ['handoverSections', 'sectionsData'].map((n) => grab(new RegExp('^function ' + n + '\\(.*\\n', 'm'))).join('')
  + grab(/^function handoverData[\s\S]*?\n}\n/m);
const NOW = Date.parse('2026-11-20T12:00:00Z'), iso = (minAgo) => new Date(NOW - minAgo * 6e4).toISOString();
const SETS = {
  'care.vitals': { setId: 'care.vitals', kind: 'care', title: 'Vitals', sections: [{ fields: [
    { id: 'v_time', type: 'datetime', repeat: true, group: 'v', label: 'Time' },
    { id: 'hr', type: 'number', repeat: true, group: 'v', label: 'HR', unit: 'bpm' }] }] },
  'pw.a': { setId: 'pw.a', kind: 'pathway', title: 'Pathway A', sections: [] },
};
const ctx = { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } } };
vm.createContext(ctx);
ctx.getSet = (id) => SETS[id] || null;
ctx.emrSurfaces = () => [];                                  // no EMR view pathway in this made-up registry: the fallback sections apply
vm.runInContext(code + ';this.handoverData=handoverData;', ctx);
const J = (x) => JSON.parse(JSON.stringify(x));
const kase = (rows, extra) => Object.assign({ applied: [{ setId: 'care.vitals' }], values: { 'care.vitals/@v': rows } }, extra);
const row = (readMin, hr, enteredMin, extra) => Object.assign({ v_time: iso(readMin), hr: String(hr) }, enteredMin == null ? {} : { __at: iso(enteredMin) }, extra);

test('empty or missing case gives empty sections, no throw', () => {
  const d = J(ctx.handoverData(null, 0, NOW));
  assert.deepEqual(d, { narrative: '', pathways: [], latest: [], acks24h: [], newRows: [] });
});
test('latest is the newest timed row, shown as recorded, with its age', () => {
  const d = J(ctx.handoverData(kase([row(120, 80, 120), row(10, 95, 10)]), 0, NOW));
  assert.equal(d.latest.length, 1);
  assert.equal(d.latest[0].value, 'HR 95 bpm');
  assert.match(d.latest[0].ageText, /10 min/);
});
test('newRows: only rows entered after sinceMs, oldest first; no entry time means left out', () => {
  const rows = [row(30, 1, 30), row(200, 2, 200), row(50, 3, 50), row(40, 4, null)];
  const d = J(ctx.handoverData(kase(rows), NOW - 100 * 6e4, NOW));
  assert.deepEqual(d.newRows.map((r) => r.value), ['HR 3 bpm', 'HR 1 bpm']);
  assert.equal(J(ctx.handoverData(kase(rows), NOW - 30 * 6e4, NOW)).newRows.length, 0); // edge: exactly at since is not "after"
});
test('entered_in_error rows are ignored everywhere', () => {
  const d = J(ctx.handoverData(kase([row(5, 99, 5, { __status: 'entered_in_error' })]), 0, NOW));
  assert.equal(d.latest.length, 0); assert.equal(d.newRows.length, 0);
});
test('acks24h keeps only acknowledgements from the last 24 h', () => {
  const log = [{ ruleId: 'a', setId: 's', ackedAt: iso(60) }, { ruleId: 'b', setId: 's', ackedAt: iso(25 * 60) }, { ruleId: 'c', setId: 's', ackedAt: 'bad' }];
  assert.deepEqual(J(ctx.handoverData(kase([], { alertLog: log }), 0, NOW)).acks24h.map((x) => x.ruleId), ['a']);
});
test('narrative is trimmed as written; pathways list title and start; unknown pathway keeps its id', () => {
  const d = J(ctx.handoverData(kase([], { narrative: '  Post-op day 2.\n', pathways: [{ pathwayId: 'pw.a', startedAt: '2026-11-19' }, { pathwayId: 'gone' }] }), 0, NOW));
  assert.equal(d.narrative, 'Post-op day 2.');
  assert.deepEqual(d.pathways, [{ title: 'Pathway A', startedAt: '2026-11-19' }, { title: 'gone', startedAt: '' }]);
});
