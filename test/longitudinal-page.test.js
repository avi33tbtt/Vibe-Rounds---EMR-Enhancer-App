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
const NAMES = ['lgTrend', 'lgSeries', 'lgNum', 'lgPickDate', 'lgDateLanes', 'lgSelect', 'lgDrawer', 'lgNeighbours', 'lgToggle', 'lgChips', 'lgLanes', 'renderLongitudinalNav', 'longitudinalLoad', 'renderLongitudinal', 'lgQuery', 'lgWhat', 'lgSource'];

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

const AV = [{ key: 'diabetes', label: 'Diabetes' }, { key: 'ckd', label: 'Chronic kidney disease' }];
const M = (key, label) => ({ key, label, reasons: ['set ' + key] });
const ctxBody = (u) => {
  const both = E({ key: 'observation:2', sourceId: 2, fieldKey: 'egfr', scope: 'condition', contexts: [M('diabetes', 'Diabetes'), M('ckd', 'Chronic kidney disease')] });
  const un = E({ key: 'observation:3', sourceId: 3, fieldKey: 'weird', scope: 'unmapped' });
  const q = /context=([^&]*)/.exec(u); const keys = q ? decodeURIComponent(q[1]).split(',') : [];
  const all = [both, un];
  const ev = keys.length ? all.filter(e => e.contexts.some(c => keys.includes(c.key))) : all;
  return body(ev, { available: AV, counts: { all: 2, shared: 0, unmapped: 1, diabetes: 1, ckd: 1 }, contexts: keys });
};

test('context chips: All, one, combined; the request carries context=; a record in two contexts shows once with both lanes; unmapped only in All', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, ctxBody(u)); });
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  let h = box(w);
  assert.match(h, /All history \(2\)/); assert.match(h, /Diabetes \(1\)/); assert.match(h, /1 record\(s\) have no established context/);
  assert.match(h, /weird/); assert.match(h, /context: unmapped/);
  await w.eval("lgToggle('diabetes')");
  assert.match(calls[calls.length - 1], /context=diabetes/); h = box(w);
  assert.ok(!/weird/.test(h), 'unmapped not in a condition view'); assert.match(h, /egfr/);
  await w.eval("lgToggle('ckd')");
  assert.match(calls[calls.length - 1], /context=diabetes,ckd/); h = box(w);
  assert.equal((h.match(/egfr/g) || []).length, 1, 'shown once'); assert.match(h, /Combined view/);
  assert.match(h, /<span class="bd" title="set diabetes">Diabetes<\/span>/); assert.match(h, /Chronic kidney disease<\/span>/);
  await w.eval("lgToggle('diabetes')"); assert.match(calls[calls.length - 1], /context=ckd(&|$)/);
  await w.eval("lgToggle('all')"); assert.ok(!/context=/.test(calls[calls.length - 1]));
  const n = calls.length; await w.eval("lgToggle('<bad>')"); assert.equal(calls.length, n, 'unknown key sends nothing');
});

test('switching context keeps the date range; clicking a chip goes through the delegated listener; labels are escaped', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); const b = ctxBody(u); b.available = [{ key: 'diabetes', label: '<b>D</b>' }, AV[1]]; return res(200, b); });
  as(w, ['cases:read']); withCase(w, 7); w.eval("LG.from='2025-01-01'"); await w.eval('longitudinalLoad()');
  assert.ok(!box(w).includes('<b>D</b>'));
  w.document.querySelector('[data-act="longCtx"][data-arg="ckd"]').click();
  await new Promise(r => setTimeout(r, 50));
  assert.match(calls[calls.length - 1], /from=2025-01-01.*context=ckd/);
});

const series = () => body([
  E({ key: 'observation:1', sourceId: 1, at: '2025-01-10T08:00:00Z', effectiveAt: '2025-01-10T08:00:00Z', value: 7.1, scope: 'condition', contexts: [M('diabetes', 'Diabetes')] }),
  E({ key: 'observation:2', sourceId: 2, at: '2025-06-10T08:00:00Z', effectiveAt: '2025-06-10T08:00:00Z', value: 999, status: 'entered_in_error', inError: true }),
  E({ key: 'observation:3', sourceId: 3, at: '2025-09-10T08:00:00Z', effectiveAt: '2025-09-10T08:00:00Z', value: 7.9, by: '<i>x</i>', scope: 'condition', contexts: [M('diabetes', 'Diabetes'), M('ckd', 'Chronic kidney disease')] }),
  E({ key: 'observation:4', sourceId: 4, at: '2026-01-10T08:00:00Z', effectiveAt: '2026-01-10T08:00:00Z', value: 8.2 })], { available: AV, counts: { all: 4, diabetes: 2, ckd: 1 } });

test('drawer: facts from the record and derived labels are apart; times apart; contexts with reasons; previous/next skip entered-in-error; escaped; no causal claim', async () => {
  const w = await page(async () => res(200, series()));
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  assert.ok(!box(w).includes('lg_drawer'), 'closed by default');
  w.document.querySelector('[data-act="longSelect"][data-arg="observation:3"]').click();
  await new Promise(r => setTimeout(r, 30));
  const h = box(w), d = w.document.getElementById('lg_drawer').innerHTML;
  assert.match(d, /From the record/); assert.match(d, /Worked out by this page/);
  assert.ok(d.indexOf('From the record') < d.indexOf('Worked out by this page'));
  assert.match(d, /7\.9 %/); assert.match(d, /Effective \(when true\): 2025-09-10 08:00/); assert.match(d, /Recorded \(when entered\): 2026-11-21 09:30|Recorded \(when entered\)/);
  assert.match(d, /Diabetes: set diabetes/); assert.match(d, /Chronic kidney disease: set ckd/);
  assert.match(d, /Previous: 7\.1 /); assert.ok(!/999/.test(d), 'entered in error is not a neighbour');
  assert.match(d, /Next: 8\.2 /);
  assert.match(d, /source observation #3/); assert.match(d, /data-act="longOpenCase"/);
  assert.ok(!d.includes('<i>x</i>')); assert.match(d, /nothing here says one caused another/);
  assert.match(d, /overall view/);
  assert.match(h, /aria-pressed="true"/);
});

test('drawer: neighbour button moves the selection; first and last say none; chosen context explains why; close and reload behave; error row is marked', async () => {
  const w = await page(async () => res(200, series()));
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  await w.eval("lgSelect('observation:1')");
  assert.match(box(w), /Previous: none among the loaded events/);
  w.document.querySelector('#lg_drawer [data-act="longSelect"]').click();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w.eval('LG.sel'), 'observation:3');
  await w.eval("LG.ctx=['ckd']; renderLongitudinal()");
  assert.match(w.document.getElementById('lg_drawer').innerHTML, /chosen context \(Chronic kidney disease\)/);
  await w.eval("lgSelect('observation:2')");
  assert.match(w.document.getElementById('lg_drawer').outerHTML, /border-left/); assert.match(w.document.getElementById('lg_drawer').innerHTML, /entered in error/);
  w.document.querySelector('[data-act="longClose"]').click(); await new Promise(r => setTimeout(r, 30));
  assert.equal(w.eval('LG.sel'), null); assert.ok(!box(w).includes('lg_drawer'));
  await w.eval("lgSelect('nope')"); assert.equal(w.eval('LG.sel'), null);
});

test('selected date: set by an event or a day heading, highlighted, counted per lane, kept across context switch, range change and drawer close; empty day says so; clear works', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, ctxBody(u)); });
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  assert.ok(!box(w).includes('lg_date'), 'no date by default');
  w.document.querySelector('[data-act="longDate"]').click(); await new Promise(r => setTimeout(r, 30));
  assert.equal(w.eval('LG.date'), '2026-11-20');
  let h = box(w);
  assert.match(h, /id="lg_seldate"/); assert.match(h, /aria-current="date"/);
  assert.match(h, /Records on that date in this view: 2/); assert.match(h, /Diabetes: 1/); assert.match(h, /Chronic kidney disease: 1/); assert.match(h, /Unmapped: 1/);
  await w.eval("lgToggle('ckd')");
  assert.equal(w.eval('LG.date'), '2026-11-20', 'kept across the view switch'); h = box(w);
  assert.match(h, /Records on that date in this view: 1/); assert.ok(!/Unmapped:/.test(h)); assert.match(h, /Chronic kidney disease: 1/);
  await w.eval("LG.from='2026-01-01'; longitudinalLoad(false)"); assert.equal(w.eval('LG.date'), '2026-11-20', 'kept across a range change');
  await w.eval("lgSelect('observation:2')"); w.document.querySelector('[data-act="longClose"]').click(); await new Promise(r => setTimeout(r, 30));
  assert.equal(w.eval('LG.date'), '2026-11-20', 'kept when the drawer closes');
  await w.eval("lgPickDate('2024-02-02')"); assert.match(box(w), /none in the loaded part of this view/);
  await w.eval("lgPickDate('<bad>')"); assert.equal(w.eval('LG.date'), null);
  await w.eval("lgPickDate('2026-11-20')"); w.document.querySelector('[data-act="longClearDate"]').click(); await new Promise(r => setTimeout(r, 30));
  assert.equal(w.eval('LG.date'), null); assert.ok(!box(w).includes('lg_date'));
});

test('selecting an event sets the date to that event\'s day; another patient clears the date', async () => {
  const w = await page(async () => res(200, series()));
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  await w.eval("lgSelect('observation:3')"); assert.equal(w.eval('LG.date'), '2025-09-10');
  w.document.querySelector('#lg_drawer [data-act="longSelect"]').click(); await new Promise(r => setTimeout(r, 30));
  assert.equal(w.eval('LG.date'), '2025-01-10', 'neighbour moves the date too');
  withCase(w, 8); await w.eval('longitudinalLoad()'); assert.equal(w.eval('LG.date'), null);
});

const trendBody = () => body([
  E({ key: 'observation:1', sourceId: 1, at: '2025-01-10T08:00:00Z', effectiveAt: '2025-01-10T08:00:00Z', value: 7.1 }),
  E({ key: 'observation:2', sourceId: 2, at: '2025-04-10T08:00:00Z', effectiveAt: '2025-04-10T08:00:00Z', value: null }),
  E({ key: 'observation:3', sourceId: 3, at: '2025-06-10T08:00:00Z', effectiveAt: '2025-06-10T08:00:00Z', value: 999, status: 'entered_in_error', inError: true }),
  E({ key: 'observation:4', sourceId: 4, at: '2025-09-10T08:00:00Z', effectiveAt: '2025-09-10T08:00:00Z', value: 7.9 }),
  E({ key: 'observation:5', sourceId: 5, at: '2025-10-10T08:00:00Z', effectiveAt: '2025-10-10T08:00:00Z', value: 'Unknown' }),
  E({ key: 'observation:6', sourceId: 6, at: '2025-11-10T08:00:00Z', effectiveAt: '2025-11-10T08:00:00Z', value: 53 , unit: 'mmol/mol' }),
  E({ key: 'observation:7', sourceId: 7, at: '2026-01-10T08:00:00Z', effectiveAt: '2026-01-10T08:00:00Z', value: 8.2 }),
  E({ key: 'observation:8', sourceId: 8, at: '2026-01-11T08:00:00Z', effectiveAt: '2026-01-11T08:00:00Z', fieldKey: 'sbp', value: 130, unit: 'mmHg' })]);

test('trend chart: one field and unit at a time (units never joined); no value, text and entered in error are left out and counted, never zero; fields with fewer than 2 points are not offered', async () => {
  const w = await page(async () => res(200, trendBody()));
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  assert.ok(!box(w).includes('lg_chart'), 'no chart until chosen');
  const opts = [...w.document.querySelectorAll('#lg_trend option')].map(o => o.value);
  assert.deepEqual(opts, ['', 'hba1c|%']); // hba1c in mmol/mol has 1 point, sbp has 1
  w.document.getElementById('lg_trend').value = 'hba1c|%';
  w.document.getElementById('lg_trend').dispatchEvent(new w.Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 30));
  const svg = w.document.getElementById('lg_chart');
  assert.ok(svg); assert.equal(svg.querySelectorAll('circle').length, 3, '7.1, 7.9, 8.2 only');
  const h = box(w);
  assert.ok(!/999/.test(svg.outerHTML) && !/>0</.test(svg.outerHTML), 'no error value, no zero');
  assert.match(h, /3 value\(s\) in %/); assert.match(h, /3 row\(s\) of this field and unit are not plotted/);
  assert.match(h, /does not start at zero/); assert.match(h, /does not show why it changed/);
  assert.ok(!/53/.test(svg.outerHTML), 'other unit never mixed in');
});

test('trend chart: a point opens the drawer and the selected date is marked; labels are escaped; nothing to plot gives a note, not a chart', async () => {
  const w = await page(async () => res(200, trendBody()));
  as(w, ['cases:read']); withCase(w, 7); await w.eval('longitudinalLoad()');
  w.eval("LG.trend='hba1c|%'; renderLongitudinal()");
  w.document.querySelector('#lg_chart circle[data-arg="observation:4"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w.eval('LG.sel'), 'observation:4'); assert.equal(w.eval('LG.date'), '2025-09-10');
  assert.ok(w.document.getElementById('lg_drawer')); assert.match(box(w), /stroke-dasharray/);
  const w2 = await page(async () => res(200, body([E({ fieldKey: '<img src=x onerror=alert(1)>' }), E({ key: 'observation:2', sourceId: 2, fieldKey: '<img src=x onerror=alert(1)>' })])));
  as(w2, ['cases:read']); withCase(w2, 7); await w2.eval('longitudinalLoad()');
  assert.equal(w2.document.querySelector('#longitudinalBox img'), null, 'no element is created from a field name'); assert.equal(w2.document.querySelector('#lg_trend option:nth-child(2)').textContent, '<img src=x onerror=alert(1)> (%)');
  const w3 = await page(async () => res(200, body([E()])));
  as(w3, ['cases:read']); withCase(w3, 7); await w3.eval('longitudinalLoad()');
  assert.match(box(w3), /no field has two or more plottable numeric values/); assert.ok(!box(w3).includes('<svg'));
});
