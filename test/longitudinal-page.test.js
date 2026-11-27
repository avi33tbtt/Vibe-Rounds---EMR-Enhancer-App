'use strict';
// Row R9f: the Longitudinal screen (modules/79-longitudinal.js). Server data only, read only; the server decides, the page shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '79-longitudinal.js'), 'utf8');
const NAMES = ['renderLongitudinalNav', 'longitudinalLoad', 'renderLongitudinal', 'lgQuery', 'lgWhat', 'lgSource'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, perms) => w.eval(`Srv.user = ${JSON.stringify({ username: 'u', role: 'x', perms })}`);
const withCase = (w, patientId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}`);
const box = w => w.document.getElementById('longitudinalBox').innerHTML;
const E = (o = {}) => ({ key: 'observation:1', kind: 'observation', kindLabel: 'Value', sourceId: 1, caseId: 3, at: '2026-11-20T08:00:00Z',
  effectiveAt: '2026-11-20T08:00:00Z', recordedAt: '2026-11-21T09:30:00Z', status: 'final', by: 'doc', fieldKey: 'hba1c', value: 7.5, unit: '%',
  contexts: [], scope: 'unmapped', scopeLabel: 'unmapped', ...o });
const body = (events, o = {}) => ({ events, total: events.length, limit: 100, offset: 0, hiddenInError: 0, truncated: false, ...o });

test('79-longitudinal.js loads after 79-timeline.js, before 90-wire.js; nothing inline; no storage or writes; tab and pane exist', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/79-longitudinal.js'), l.indexOf('modules/79-timeline.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/79-longitudinal.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n);
    assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing from the module: ' + n);
  }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.ok(!/api\('(POST|PUT|PATCH|DELETE)'/.test(mod), 'read only');
  assert.match(raw, /id="navLongitudinal"[^>]*display:none/);
  assert.match(raw, /<div class="pane" id="longitudinal">/);
});

test('tab hidden without cases:read; without a patient or permission no request is made; signing out clears', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, body([E()])); });
  calls.length = 0;
  as(w, ['medications:read']); w.eval('renderLongitudinalNav()');
  assert.equal(w.document.getElementById('navLongitudinal').style.display, 'none');
  await w.eval('longitudinalLoad()'); assert.deepEqual(calls, []);
  as(w, ['cases:read']); w.eval('renderLongitudinalNav()');
  assert.equal(w.document.getElementById('navLongitudinal').style.display, '');
  withCase(w, null); await w.eval('longitudinalLoad()'); assert.deepEqual(calls, []);
  assert.match(box(w), /Open a registered patient/);
  assert.match(box(w), /SYNTHETIC DEMO DATA — NOT FOR CLINICAL USE/);
  withCase(w, 7); await w.eval('longitudinalLoad()'); assert.deepEqual(calls, ['/api/patients/7/longitudinal?limit=100&offset=0']);
  assert.equal(w.eval('LG.events.length'), 1);
  w.eval('Srv.user = null; renderLongitudinalNav()'); assert.equal(w.eval('LG.events.length'), 0); assert.equal(w.eval('LG.loaded'), false);
});

test('events are grouped by year then day; effective and recorded time apart; source link; unmapped labelled; text escaped', async () => {
  const w = await page(async () => res(200, body([
    E({ sourceId: 9, at: '2025-03-02T08:00:00Z', effectiveAt: '2025-03-02T08:00:00Z', fieldKey: '<img src=x onerror=alert(1)>', by: '<i>u</i>' }),
    E({ kind: 'problem', kindLabel: 'Problem', sourceId: 4, at: '2026-11-20T10:00:00Z', effectiveAt: '2025-01-01', label: '<b>Asthma</b>', status: 'active', scope: 'condition' }),
    E({ kind: 'note', sourceId: 'n1', at: '2026-11-22T12:00:00Z', status: 'signed', caseId: null })])));
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img') && !h.includes('<i>u') && !h.includes('<b>Asthma'), 'escaped');
  assert.equal((h.match(/<h3/g) || []).length, 2, 'years 2025 and 2026');
  assert.equal((h.match(/<h4/g) || []).length, 3);
  assert.match(h, /Effective 2026-11-20 08:00 · recorded 2026-11-21 09:30/);
  assert.match(h, /Effective 2025-01-01/);
  assert.match(h, /source observation #9 · case #3/); assert.match(h, /data-act="longOpenCase" data-arg="3"/);
  assert.match(h, /no case/);
  assert.match(h, /\(context: unmapped\)/);
  assert.equal((h.match(/context: unmapped/g) || []).length, 2, 'the mapped problem is not labelled unmapped');
});

test('empty value is shown as "no value", never as zero; entered in error is struck through and is not hidden once asked for', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, u.includes('includeErrors=1') ? body([E({ status: 'entered_in_error', value: 120 })]) : body([E({ value: null })], { hiddenInError: 2 })); });
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  assert.match(box(w), /no value/); assert.ok(!/hba1c<\/b>: 0/.test(box(w)));
  assert.match(box(w), /2 entered-in-error row\(s\) are hidden/);
  w.document.getElementById('lg_errs').checked = true; w.document.getElementById('lg_errs').dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(calls.some(u => u.includes('includeErrors=1')));
  assert.match(box(w), /line-through/); assert.match(box(w), /entered in error/);
  assert.ok(!/are hidden/.test(box(w)));
});

test('date range is sent only when it is a real date; load more appends; a failed load shows the message and keeps the banner', async () => {
  const calls = [];
  let fail = false;
  const w = await page(async (u) => { calls.push(u); return fail ? res(500, { error: 'x', message: 'boom' }) : res(200, body([E({ sourceId: calls.length })], { total: 3 })); });
  as(w, ['cases:read']); withCase(w, 7);
  w.eval("LG.from='2025-01-01';LG.to='not a date'"); await w.eval('longitudinalLoad()');
  assert.equal(calls[calls.length - 1], '/api/patients/7/longitudinal?limit=100&offset=0&from=2025-01-01');
  assert.match(box(w), /Load more \(1 of 3\)/);
  await w.eval('longitudinalLoad(true)');
  assert.match(calls[calls.length - 1], /offset=1/); assert.equal(w.eval('LG.events.length'), 2);
  fail = true; await w.eval('longitudinalLoad(false)');
  assert.match(box(w), /could not be loaded/); assert.match(box(w), /SYNTHETIC DEMO DATA/);
});

test('a truncated read is warned about', async () => {
  const w = await page(async () => res(200, body([E()], { truncated: true })));
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  assert.match(box(w), /may be incomplete/);
});
