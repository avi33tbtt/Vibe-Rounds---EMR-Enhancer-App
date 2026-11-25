'use strict';
// Row R3b: the Problems screen (modules/77-problems.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '77-problems.js'), 'utf8');
const NAMES = ['renderProblemsNav', 'problemsLoad', 'renderProblems', 'problemAdd', 'problemStep'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('problemsBox').innerHTML;
const P = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, label: 'Type 2 diabetes', onset_date: '2020-03-01', status: 'active', row_version: 1,
  recorded_by: 'doc', recorded_at: '2026-11-25T10:00:00Z', resolved_by: null, resolved_at: null, resolution_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const sleep = () => new Promise(r => setTimeout(r, 20));

test('77-problems.js loads right after 75-terms.js, before the inline script; nothing of it is inline; no inline handlers or storage', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/77-problems.js'), l.indexOf('modules/75-terms.js') + 1, l.join(', '));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n);
    assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing from the module: ' + n);
  }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /id="navProblems"[^>]*display:none/);
  assert.match(raw, /<div class="pane" id="problems">/);
});

test('the tab is hidden without problems:read; without a patient or permission no request is made; signing out clears the list', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, { problems: [P()] }); });
  calls.length = 0;   // the page's own start-up request (/api/me) is not ours
  as(w, 'v', ['cases:read']); w.eval('renderProblemsNav()');
  assert.equal(w.document.getElementById('navProblems').style.display, 'none');
  await w.eval('problemsLoad()'); assert.deepEqual(calls, []);
  as(w, 'v', ['problems:read']); w.eval('renderProblemsNav()');
  assert.equal(w.document.getElementById('navProblems').style.display, '');
  withCase(w, null, null); await w.eval('problemsLoad()'); assert.deepEqual(calls, []);
  assert.match(box(w), /Open a registered patient/);
  withCase(w, 7, null); await w.eval('problemsLoad()'); assert.deepEqual(calls, ['/api/patients/7/problems']);
  assert.equal(w.eval('PROB.items.length'), 1);
  w.eval('Srv.user = null; renderProblemsNav()'); assert.equal(w.eval('PROB.items.length'), 0); assert.equal(w.eval('PROB.loaded'), false);
});

test('the list shows status, onset and who; escapes every text; failure and empty list do not crash', async () => {
  const w = await page(async () => res(200, { problems: [P({ label: '<img src=x onerror=alert(1)>', recorded_by: '<i>u</i>' }),
    P({ id: 2, status: 'resolved', onset_date: null, resolved_by: 'nur', resolved_at: '2026-11-25T11:00:00Z', resolution_reason: '<b>gone</b>' })] }));
  as(w, 'v', ['problems:read']); withCase(w, 7, null); await w.eval('problemsLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img') && !h.includes('<i>u') && !h.includes('<b>gone'), 'escaped');
  assert.match(h, />active</); assert.match(h, />resolved</); assert.match(h, /Onset unknown/); assert.match(h, /Your role cannot change problems/);
  const w2 = await page(async () => res(500, { error: 'boom' }));
  as(w2, 'v', ['problems:read']); withCase(w2, 7, null); await w2.eval('problemsLoad()');
  assert.match(box(w2), /could not be loaded/);
  const w3 = await page(async () => res(200, { problems: [] }));
  as(w3, 'v', ['problems:read']); withCase(w3, 7, null); await w3.eval('problemsLoad()');
  assert.match(box(w3), /No problems recorded/);
});

test('buttons follow permission and status: resolve only for active; entered in error is final and has no buttons; add form needs problems:write', async () => {
  const items = [P({ id: 1 }), P({ id: 2, status: 'resolved', resolved_by: 'n', resolution_reason: 'ok' }), P({ id: 3, status: 'entered_in_error', error_by: 'n', error_reason: 'typo' })];
  const w = await page(async () => res(200, { problems: items }));
  as(w, 'doc', ['problems:read', 'problems:write']); withCase(w, 7, null); await w.eval('problemsLoad()');
  const d = w.document;
  assert.equal(d.querySelectorAll('[data-act=problemResolve]').length, 1);
  assert.equal(d.querySelectorAll('[data-act=problemError]').length, 2);
  assert.equal(d.querySelector('[data-act=problemResolve]').dataset.arg, '1');
  assert.ok(d.getElementById('pf_label'));
  assert.match(box(w), /Final: an entry made in error/);
  as(w, 'v', ['problems:read']); w.eval('renderProblems()');
  assert.equal(d.querySelectorAll('[data-act=problemResolve],[data-act=problemError],#pf_label').length, 0);
});

test('"Show entered in error" asks the server for include=all', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, { problems: [] }); });
  as(w, 'doc', ['problems:read', 'problems:write']); withCase(w, 7, null); await w.eval('problemsLoad()');
  calls.length = 0;
  const cb = w.document.getElementById('pf_all'); cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true })); await sleep();
  assert.deepEqual(calls, ['/api/patients/7/problems?include=all']);
});

test('add sends only label, onsetDate and originCaseId (saved case only); a blank label sends nothing; the server message is shown on refusal', async () => {
  const calls = [];
  let status = 201;
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) }); return o && o.method === 'POST' ? res(status, status === 201 ? { id: 5 } : { error: 'invalid', message: 'No way.' }) : res(200, { problems: [] }); });
  as(w, 'doc', ['problems:read', 'problems:write']); withCase(w, 7, 12); await w.eval('problemsLoad()'); calls.length = 0;
  await w.eval('problemAdd()'); assert.deepEqual(calls, []); assert.match(box(w), /needs a label/);
  w.document.getElementById('pf_label').value = ' Hypertension '; w.document.getElementById('pf_onset').value = '2021-05-02';
  await w.eval('problemAdd()');
  const post = calls.find(c => c.m === 'POST');
  assert.equal(post.u, '/api/patients/7/problems');
  assert.deepEqual(post.b, { label: 'Hypertension', onsetDate: '2021-05-02', originCaseId: 12 });
  assert.equal(w.document.getElementById('pf_label').value, '', 'form cleared');
  withCase(w, 7, null); calls.length = 0; status = 400;
  w.document.getElementById('pf_label').value = 'Asthma'; await w.eval('problemAdd()');
  assert.deepEqual(calls.find(c => c.m === 'POST').b, { label: 'Asthma' });
  assert.match(box(w), /No way\./);
});

test('resolve and entered in error need a reason, send only reason and the loaded rowVersion, and a 409 reloads with the server message', async () => {
  const calls = [];
  let status = 200;
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) });
    return o && o.method === 'POST' ? res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) : res(200, { problems: [P({ row_version: 4 })] }); });
  as(w, 'doc', ['problems:read', 'problems:write']); withCase(w, 7, null); await w.eval('problemsLoad()'); calls.length = 0;
  await w.eval("problemStep('resolve','1')"); assert.deepEqual(calls, []); assert.match(box(w), /A reason is required/);
  w.document.getElementById('pr_1').value = 'Healed';
  await w.eval("problemStep('resolve','1')");
  assert.deepEqual(calls[0], { u: '/api/problems/1/resolve', m: 'POST', b: { reason: 'Healed', rowVersion: 4 } });
  calls.length = 0; status = 409;
  w.document.getElementById('pr_1').value = 'Typed wrongly';
  await w.eval("problemStep('error','1')");
  assert.equal(calls[0].u, '/api/problems/1/entered-in-error');
  assert.ok(calls.some(c => c.m === 'GET'), 'reloaded after the conflict');
  assert.match(box(w), /Changed by someone else/);
  calls.length = 0; await w.eval("problemStep('bogus','1')"); await w.eval("problemStep('resolve','1; DROP')"); assert.deepEqual(calls, []);
});
