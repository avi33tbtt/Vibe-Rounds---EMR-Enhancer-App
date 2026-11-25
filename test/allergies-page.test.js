'use strict';
// Row R3d: the Allergies screen (modules/78-allergies.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '78-allergies.js'), 'utf8');
const NAMES = ['renderAllergiesNav', 'allergiesLoad', 'renderAllergies', 'allergyAdd', 'allergyStep'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('allergiesBox').innerHTML;
const P = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, substance: 'Penicillin', reaction: 'Rash', severity: 'moderate', onset_date: '2020-03-01', status: 'active', row_version: 1,
  recorded_by: 'doc', recorded_at: '2026-11-25T10:00:00Z', resolved_by: null, resolved_at: null, resolution_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const sleep = () => new Promise(r => setTimeout(r, 20));

test('78-allergies.js loads right after 77-allergies.js, before the inline script; nothing of it is inline; no inline handlers or storage', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/78-allergies.js'), l.indexOf('modules/77-allergies.js') + 1, l.join(', '));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n);
    assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing from the module: ' + n);
  }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /id="navAllergies"[^>]*display:none/);
  assert.match(raw, /<div class="pane" id="allergies">/);
});

test('the tab is hidden without allergies:read; without a patient or permission no request is made; signing out clears the list', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, { allergies: [P()] }); });
  calls.length = 0;   // the page's own start-up request (/api/me) is not ours
  as(w, 'v', ['cases:read']); w.eval('renderAllergiesNav()');
  assert.equal(w.document.getElementById('navAllergies').style.display, 'none');
  await w.eval('allergiesLoad()'); assert.deepEqual(calls, []);
  as(w, 'v', ['allergies:read']); w.eval('renderAllergiesNav()');
  assert.equal(w.document.getElementById('navAllergies').style.display, '');
  withCase(w, null, null); await w.eval('allergiesLoad()'); assert.deepEqual(calls, []);
  assert.match(box(w), /Open a registered patient/);
  withCase(w, 7, null); await w.eval('allergiesLoad()'); assert.deepEqual(calls, ['/api/patients/7/allergies']);
  assert.equal(w.eval('ALGY.items.length'), 1);
  w.eval('Srv.user = null; renderAllergiesNav()'); assert.equal(w.eval('ALGY.items.length'), 0); assert.equal(w.eval('ALGY.loaded'), false);
});

test('the list shows status, onset and who; escapes every text; failure and empty list do not crash', async () => {
  const w = await page(async () => res(200, { allergies: [P({ substance: '<img src=x onerror=alert(1)>', recorded_by: '<i>u</i>' }),
    P({ id: 2, status: 'resolved', onset_date: null, resolved_by: 'nur', resolved_at: '2026-11-25T11:00:00Z', resolution_reason: '<b>gone</b>' })] }));
  as(w, 'v', ['allergies:read']); withCase(w, 7, null); await w.eval('allergiesLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img') && !h.includes('<i>u') && !h.includes('<b>gone'), 'escaped');
  assert.match(h, />active</); assert.match(h, />resolved</); assert.match(h, /onset unknown/); assert.match(h, /Reaction Rash/); assert.match(h, />moderate</); assert.match(h, /Your role cannot change allergies/);
  const w2 = await page(async () => res(500, { error: 'boom' }));
  as(w2, 'v', ['allergies:read']); withCase(w2, 7, null); await w2.eval('allergiesLoad()');
  assert.match(box(w2), /could not be loaded/);
  const w3 = await page(async () => res(200, { allergies: [] }));
  as(w3, 'v', ['allergies:read']); withCase(w3, 7, null); await w3.eval('allergiesLoad()');
  assert.match(box(w3), /No allergies recorded/);
});

test('buttons follow permission and status: resolve only for active; entered in error is final and has no buttons; add form needs allergies:write', async () => {
  const items = [P({ id: 1 }), P({ id: 2, status: 'resolved', resolved_by: 'n', resolution_reason: 'ok' }), P({ id: 3, status: 'entered_in_error', error_by: 'n', error_reason: 'typo' })];
  const w = await page(async () => res(200, { allergies: items }));
  as(w, 'doc', ['allergies:read', 'allergies:write']); withCase(w, 7, null); await w.eval('allergiesLoad()');
  const d = w.document;
  assert.equal(d.querySelectorAll('[data-act=allergyResolve]').length, 1);
  assert.equal(d.querySelectorAll('[data-act=allergyError]').length, 2);
  assert.equal(d.querySelector('[data-act=allergyResolve]').dataset.arg, '1');
  assert.ok(d.getElementById('af_substance'));
  assert.match(box(w), /Final: an entry made in error/);
  as(w, 'v', ['allergies:read']); w.eval('renderAllergies()');
  assert.equal(d.querySelectorAll('[data-act=allergyResolve],[data-act=allergyError],#af_substance').length, 0);
});

test('"Show entered in error" asks the server for include=all', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, { allergies: [] }); });
  as(w, 'doc', ['allergies:read', 'allergies:write']); withCase(w, 7, null); await w.eval('allergiesLoad()');
  calls.length = 0;
  const cb = w.document.getElementById('af_all'); cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true })); await sleep();
  assert.deepEqual(calls, ['/api/patients/7/allergies?include=all']);
});

test('add sends only substance, reaction, severity, onsetDate and originCaseId (saved case only); a blank substance sends nothing; a bad severity is dropped; the server message is shown on refusal', async () => {
  const calls = [];
  let status = 201;
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) }); return o && o.method === 'POST' ? res(status, status === 201 ? { id: 5 } : { error: 'invalid', message: 'No way.' }) : res(200, { allergies: [] }); });
  as(w, 'doc', ['allergies:read', 'allergies:write']); withCase(w, 7, 12); await w.eval('allergiesLoad()'); calls.length = 0;
  await w.eval('allergyAdd()'); assert.deepEqual(calls, []); assert.match(box(w), /needs a substance/);
  w.document.getElementById('af_substance').value = ' Peanut '; w.document.getElementById('af_reaction').value = ' Hives '; w.document.getElementById('af_severity').value = 'severe'; w.document.getElementById('af_onset').value = '2021-05-02';
  await w.eval('allergyAdd()');
  const post = calls.find(c => c.m === 'POST');
  assert.equal(post.u, '/api/patients/7/allergies');
  assert.deepEqual(post.b, { substance: 'Peanut', reaction: 'Hives', severity: 'severe', onsetDate: '2021-05-02', originCaseId: 12 });
  assert.equal(w.document.getElementById('af_substance').value, '', 'form cleared');
  withCase(w, 7, null); calls.length = 0; status = 400;
  w.document.getElementById('af_substance').value = 'Asthma'; await w.eval('allergyAdd()');
  assert.deepEqual(calls.find(c => c.m === 'POST').b, { substance: 'Asthma' });
  assert.match(box(w), /No way\./);
});

test('resolve and entered in error need a reason, send only reason and the loaded rowVersion, and a 409 reloads with the server message', async () => {
  const calls = [];
  let status = 200;
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) });
    return o && o.method === 'POST' ? res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) : res(200, { allergies: [P({ row_version: 4 })] }); });
  as(w, 'doc', ['allergies:read', 'allergies:write']); withCase(w, 7, null); await w.eval('allergiesLoad()'); calls.length = 0;
  await w.eval("allergyStep('resolve','1')"); assert.deepEqual(calls, []); assert.match(box(w), /A reason is required/);
  w.document.getElementById('ar_1').value = 'Healed';
  await w.eval("allergyStep('resolve','1')");
  assert.deepEqual(calls[0], { u: '/api/allergies/1/resolve', m: 'POST', b: { reason: 'Healed', rowVersion: 4 } });
  calls.length = 0; status = 409;
  w.document.getElementById('ar_1').value = 'Typed wrongly';
  await w.eval("allergyStep('error','1')");
  assert.equal(calls[0].u, '/api/allergies/1/entered-in-error');
  assert.ok(calls.some(c => c.m === 'GET'), 'reloaded after the conflict');
  assert.match(box(w), /Changed by someone else/);
  calls.length = 0; await w.eval("allergyStep('bogus','1')"); await w.eval("allergyStep('resolve','1; DROP')"); assert.deepEqual(calls, []);
});
