'use strict';
// node --test handover-view.test.js
// Chunk 37d2: the Handover view only displays handoverData: escaped text, no colours or flags, wired into the shell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('./enhancer.html', 'utf8');
const grab = (re) => { const m = html.match(re); assert.ok(m, 'not found: ' + re); return m[0]; };
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ctx = { esc }; vm.createContext(ctx);
vm.runInContext(grab(/^function handoverHtml[\s\S]*?\n}\n/m) + ';this.handoverHtml=handoverHtml;', ctx);
const empty = { narrative: '', pathways: [], latest: [], acks24h: [], newRows: [] };
const draw = (d, h = 12) => ctx.handoverHtml(Object.assign({}, empty, d), h, (rid) => 'rule ' + rid);

test('empty data shows every section with a plain empty line', () => {
  const o = draw({});
  ['Narrative', 'Pathways', 'Latest readings', 'Entered in the last 12 h', 'Alerts acknowledged in the last 24 h'].forEach((t) => assert.ok(o.includes(t), t));
  assert.ok(o.includes('No narrative entered.') && o.includes('No timed readings.'));
});
test('all recorded text is escaped', () => {
  const o = draw({ narrative: '<img src=x onerror=alert(1)>', latest: [{ set: '<b>S</b>', value: '"v"', ageText: '' }], pathways: [{ title: '<i>p</i>', startedAt: '2026-11-19T00:00' }] });
  assert.ok(!/<img|<b>S|<i>p/.test(o));
  assert.ok(o.includes('started 2026-11-19'));
});
test('rows, acknowledgements and the chosen window are shown', () => {
  const o = draw({ newRows: [{ set: 'Vitals', enteredAt: '2026-11-20T10:00:00Z', readingAt: '2026-11-20T09:55:00Z', value: 'HR 70 bpm' }], acks24h: [{ ruleId: 'r1', setId: 's', ackedAt: '2026-11-20T09:00:00Z' }] }, 24);
  assert.ok(o.includes('HR 70 bpm') && o.includes('rule r1') && o.includes('Entered in the last 24 h'));
  assert.ok(/data-how="24"[^>]*border/.test(o));
});
test('display only: no colour variables, no flags, no judgement words', () => {
  const o = draw({ latest: [{ set: 'Vitals', value: 'HR 200 bpm', ageText: '(recorded 5 min ago)' }] });
  assert.ok(!/var\(--(r|a|g)\b/.test(o));
  assert.ok(!/abnormal|critical|\bhigh\b|\blow\b|overdue|stable|deteriorat|improv|worse/i.test(o.replace(/<[^>]*>/g, ' ')));
});
test('wired into the shell: nav button, pane, dispatcher, live refresh', () => {
  assert.ok(html.includes('data-shell-t="ho">Handover</button>'));
  assert.ok(html.includes('<div class="pane" id="ho">'));
  assert.ok(html.includes("if(id==='ho')handoverRender();"));
  assert.ok(html.includes("$('ho').classList.contains('on'))handoverRender()"));
});
