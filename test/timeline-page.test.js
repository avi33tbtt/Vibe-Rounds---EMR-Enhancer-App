'use strict';
// Row R3h: the Timeline screen (modules/79-timeline.js). Server data only, read only; the server decides, the page shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '79-timeline.js'), 'utf8');
const NAMES = ['renderTimelineNav', 'timelineLoad', 'renderTimeline', 'tlQuery', 'tlWhat'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, perms) => w.eval(`Srv.user = ${JSON.stringify({ username: 'u', role: 'x', perms })}`);
const withCase = (w, patientId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}`);
const box = w => w.document.getElementById('timelineBox').innerHTML;
const E = (o = {}) => ({ kind: 'observation', sourceId: 1, caseId: 3, at: '2026-11-20T08:00:00Z', effectiveAt: '2026-11-20T08:00:00Z', recordedAt: '2026-11-21T09:30:00Z',
  status: 'final', by: 'doc', fieldKey: 'glu', valueType: 'number', value: 7.5, unit: 'mmol/L', appliedSetId: 1, sourceType: 'manual', correctsId: null, ...o });
const body = (events, o = {}) => ({ events, total: events.length, limit: 100, offset: 0, hiddenInError: 0, truncated: false, ...o });

test('79-timeline.js loads right after 79-medications.js, before the inline script; nothing inline; no handlers, storage or writes', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/79-timeline.js'), l.indexOf('modules/79-medications.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/79-timeline.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n);
    assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing from the module: ' + n);
  }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.ok(!/api\('(POST|PUT|PATCH|DELETE)'/.test(mod), 'read only');
  assert.match(raw, /id="navTimeline"[^>]*display:none/);
  assert.match(raw, /<div class="pane" id="timeline">/);
});

test('tab hidden without cases:read; without a patient or permission no request is made; signing out clears', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, body([E()])); });
  calls.length = 0;
  as(w, ['medications:read']); w.eval('renderTimelineNav()');
  assert.equal(w.document.getElementById('navTimeline').style.display, 'none');
  await w.eval('timelineLoad()'); assert.deepEqual(calls, []);
  as(w, ['cases:read']); w.eval('renderTimelineNav()');
  assert.equal(w.document.getElementById('navTimeline').style.display, '');
  withCase(w, null); await w.eval('timelineLoad()'); assert.deepEqual(calls, []);
  assert.match(box(w), /Open a registered patient/);
  withCase(w, 7); await w.eval('timelineLoad()'); assert.deepEqual(calls, ['/api/patients/7/timeline?limit=100&offset=0']);
  assert.equal(w.eval('TL.events.length'), 1);
  w.eval('Srv.user = null; renderTimelineNav()'); assert.equal(w.eval('TL.events.length'), 0); assert.equal(w.eval('TL.loaded'), false);
});

test('events are grouped by day, show effective and recorded time apart, who, case and source; every text is escaped', async () => {
  const w = await page(async () => res(200, body([
    E({ fieldKey: '<img src=x onerror=alert(1)>', by: '<i>u</i>' }),
    E({ kind: 'problem', sourceId: 4, at: '2026-11-20T10:00:00Z', effectiveAt: '2025-01-01', recordedAt: '2026-11-20T10:00:00Z', label: '<b>Asthma</b>', status: 'active', value: undefined }),
    E({ kind: 'note', sourceId: 'n1', at: '2026-11-22T12:00:00Z', effectiveAt: '2026-11-22T12:00:00Z', status: 'signed' })])));
  as(w, ['cases:read']); withCase(w, 7); await w.eval('timelineLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img') && !h.includes('<i>u') && !h.includes('<b>Asthma'), 'escaped');
  assert.equal((h.match(/<h4/g) || []).length, 2);
  assert.match(h, /Effective 2026-11-20 08:00 · recorded 2026-11-21 09:30/);
  assert.match(h, /Effective 2025-01-01/);
  assert.match(h, /7\.5 mmol\/L/); assert.match(h, /case #3/); assert.match(h, /source observation #1/);
  assert.match(h, /Signed note/);
  assert.ok(!/<button[^>]*timelineMore/.test(h), 'all loaded, no more button');
});

test('entered in error: hidden count shown by default; with the box ticked the request asks for it and the row is struck through', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, u.includes('includeErrors=1') ? body([E({ status: 'entered_in_error' })]) : body([E()], { hiddenInError: 2 })); });
  as(w, ['cases:read']); withCase(w, 7); await w.eval('timelineLoad()');
  assert.match(box(w), /2 entered-in-error row\(s\) are hidden/);
  w.eval('TL.errs = true'); await w.eval('timelineLoad()');
  assert.match(calls[calls.length - 1], /includeErrors=1/);
  assert.match(box(w), /line-through/); assert.match(box(w), />entered in error</);
});

test('date range goes into the query only when it is a real date; load more appends the next page; failure and empty list do not crash', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, { events: [E({ sourceId: calls.length })], total: 2, limit: 100, offset: 0, hiddenInError: 0, truncated: true }); });
  as(w, ['cases:read']); withCase(w, 7);
  w.eval(`TL.from = '2026-01-01'; TL.to = 'junk'`); await w.eval('timelineLoad()');
  assert.equal(calls[calls.length - 1], '/api/patients/7/timeline?limit=100&offset=0&from=2026-01-01');
  assert.match(box(w), /may be incomplete/); assert.match(box(w), /Load more \(1 of 2\)/);
  await w.eval('timelineLoad(true)');
  assert.match(calls[calls.length - 1], /offset=1/); assert.equal(w.eval('TL.events.length'), 2);
  const w2 = await page(async () => res(500, { error: 'boom' }));
  as(w2, ['cases:read']); withCase(w2, 7); await w2.eval('timelineLoad()');
  assert.match(box(w2), /could not be loaded/);
  const w3 = await page(async () => res(200, body([])));
  as(w3, ['cases:read']); withCase(w3, 7); await w3.eval('timelineLoad()');
  assert.match(box(w3), /Nothing recorded/);
});

test('the Apply, Load more and checkbox actions are wired in ACT', () => {
  const wire = fs.readFileSync(path.join(__dirname, '..', 'modules', '90-wire.js'), 'utf8');
  for (const a of ['timelineReload', 'timelineMore', 'timelineErrors']) assert.match(wire, new RegExp(a + ':'));
});
