'use strict';
// Row R3f: the Medications screen (modules/79-medications.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '79-medications.js'), 'utf8');
const NAMES = ['renderMedicationsNav', 'medicationsLoad', 'renderMedications', 'medicationAdd', 'medicationStep'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('medicationsBox').innerHTML;
const P = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, medication: 'Metformin', dose_text: '500 mg', frequency_text: 'twice daily', start_date: '2020-03-01', status: 'active', row_version: 1,
  recorded_by: 'doc', recorded_at: '2026-11-25T10:00:00Z', stopped_by: null, stopped_at: null, stop_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const sleep = () => new Promise(r => setTimeout(r, 20));

test('79-medications.js loads right after 78-allergies.js, before the inline script; nothing of it is inline; no inline handlers or storage', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/79-medications.js'), l.indexOf('modules/78-allergies.js') + 1, l.join(', '));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n);
    assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing from the module: ' + n);
  }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /id="navMedications"[^>]*display:none/);
  assert.match(raw, /<div class="pane" id="medications">/);
});

test('the tab is hidden without medications:read; without a patient or permission no request is made; signing out clears the list', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, { medications: [P()] }); });
  calls.length = 0;   // the page's own start-up request (/api/me) is not ours
  as(w, 'v', ['cases:read']); w.eval('renderMedicationsNav()');
  assert.equal(w.document.getElementById('navMedications').style.display, 'none');
  await w.eval('medicationsLoad()'); assert.deepEqual(calls, []);
  as(w, 'v', ['medications:read']); w.eval('renderMedicationsNav()');
  assert.equal(w.document.getElementById('navMedications').style.display, '');
  withCase(w, null, null); await w.eval('medicationsLoad()'); assert.deepEqual(calls, []);
  assert.match(box(w), /Open a registered patient/);
  withCase(w, 7, null); await w.eval('medicationsLoad()'); assert.deepEqual(calls, ['/api/patients/7/medications']);
  assert.equal(w.eval('MEDH.items.length'), 1);
  w.eval('Srv.user = null; renderMedicationsNav()'); assert.equal(w.eval('MEDH.items.length'), 0); assert.equal(w.eval('MEDH.loaded'), false);
});

test('the list shows status, start and who; escapes every text; failure and empty list do not crash', async () => {
  const w = await page(async () => res(200, { medications: [P({ medication: '<img src=x onerror=alert(1)>', recorded_by: '<i>u</i>' }),
    P({ id: 2, status: 'stopped', start_date: null, stopped_by: 'nur', stopped_at: '2026-11-25T11:00:00Z', stop_reason: '<b>gone</b>' })] }));
  as(w, 'v', ['medications:read']); withCase(w, 7, null); await w.eval('medicationsLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img') && !h.includes('<i>u') && !h.includes('<b>gone'), 'escaped');
  assert.match(h, />active</); assert.match(h, />stopped</); assert.match(h, /start unknown/); assert.match(h, /Dose 500 mg/); assert.match(h, /frequency twice daily/); assert.match(h, /Your role cannot change medications/);
  const w2 = await page(async () => res(500, { error: 'boom' }));
  as(w2, 'v', ['medications:read']); withCase(w2, 7, null); await w2.eval('medicationsLoad()');
  assert.match(box(w2), /could not be loaded/);
  const w3 = await page(async () => res(200, { medications: [] }));
  as(w3, 'v', ['medications:read']); withCase(w3, 7, null); await w3.eval('medicationsLoad()');
  assert.match(box(w3), /No medications recorded/);
});

test('buttons follow permission and status: stop only for active; entered in error is final and has no buttons; add form needs medications:write', async () => {
  const items = [P({ id: 1 }), P({ id: 2, status: 'stopped', stopped_by: 'n', stop_reason: 'ok' }), P({ id: 3, status: 'entered_in_error', error_by: 'n', error_reason: 'typo' })];
  const w = await page(async () => res(200, { medications: items }));
  as(w, 'doc', ['medications:read', 'medications:write']); withCase(w, 7, null); await w.eval('medicationsLoad()');
  const d = w.document;
  assert.equal(d.querySelectorAll('[data-act=medicationStop]').length, 1);
  assert.equal(d.querySelectorAll('[data-act=medicationError]').length, 2);
  assert.equal(d.querySelector('[data-act=medicationStop]').dataset.arg, '1');
  assert.ok(d.getElementById('mf_medication'));
  assert.match(box(w), /Final: an entry made in error/);
  as(w, 'v', ['medications:read']); w.eval('renderMedications()');
  assert.equal(d.querySelectorAll('[data-act=medicationStop],[data-act=medicationError],#mf_medication').length, 0);
});

test('"Show entered in error" asks the server for include=all', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, { medications: [] }); });
  as(w, 'doc', ['medications:read', 'medications:write']); withCase(w, 7, null); await w.eval('medicationsLoad()');
  calls.length = 0;
  const cb = w.document.getElementById('mf_all'); cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true })); await sleep();
  assert.deepEqual(calls, ['/api/patients/7/medications?include=all']);
});

test('add sends only medication, doseText, frequencyText, startDate and originCaseId (saved case only); a blank medication sends nothing; blank dose and frequency are left out; the server message is shown on refusal', async () => {
  const calls = [];
  let status = 201;
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) }); return o && o.method === 'POST' ? res(status, status === 201 ? { id: 5 } : { error: 'invalid', message: 'No way.' }) : res(200, { medications: [] }); });
  as(w, 'doc', ['medications:read', 'medications:write']); withCase(w, 7, 12); await w.eval('medicationsLoad()'); calls.length = 0;
  await w.eval('medicationAdd()'); assert.deepEqual(calls, []); assert.match(box(w), /needs a medication/);
  w.document.getElementById('mf_medication').value = ' Aspirin '; w.document.getElementById('mf_dose').value = ' 75 mg '; w.document.getElementById('mf_frequency').value = ' once daily '; w.document.getElementById('mf_start').value = '2021-05-02';
  await w.eval('medicationAdd()');
  const post = calls.find(c => c.m === 'POST');
  assert.equal(post.u, '/api/patients/7/medications');
  assert.deepEqual(post.b, { medication: 'Aspirin', doseText: '75 mg', frequencyText: 'once daily', startDate: '2021-05-02', originCaseId: 12 });
  assert.equal(w.document.getElementById('mf_medication').value, '', 'form cleared');
  withCase(w, 7, null); calls.length = 0; status = 400;
  w.document.getElementById('mf_medication').value = 'Insulin'; await w.eval('medicationAdd()');
  assert.deepEqual(calls.find(c => c.m === 'POST').b, { medication: 'Insulin' });
  assert.match(box(w), /No way\./);
});

test('stop and entered in error need a reason, send only reason and the loaded rowVersion, and a 409 reloads with the server message', async () => {
  const calls = [];
  let status = 200;
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) });
    return o && o.method === 'POST' ? res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) : res(200, { medications: [P({ row_version: 4 })] }); });
  as(w, 'doc', ['medications:read', 'medications:write']); withCase(w, 7, null); await w.eval('medicationsLoad()'); calls.length = 0;
  await w.eval("medicationStep('stop','1')"); assert.deepEqual(calls, []); assert.match(box(w), /A reason is required/);
  w.document.getElementById('mr_1').value = 'Healed';
  await w.eval("medicationStep('stop','1')");
  assert.deepEqual(calls[0], { u: '/api/medications/1/stop', m: 'POST', b: { reason: 'Healed', rowVersion: 4 } });
  calls.length = 0; status = 409;
  w.document.getElementById('mr_1').value = 'Typed wrongly';
  await w.eval("medicationStep('error','1')");
  assert.equal(calls[0].u, '/api/medications/1/entered-in-error');
  assert.ok(calls.some(c => c.m === 'GET'), 'reloaded after the conflict');
  assert.match(box(w), /Changed by someone else/);
  calls.length = 0; await w.eval("medicationStep('bogus','1')"); await w.eval("medicationStep('stop','1; DROP')"); assert.deepEqual(calls, []);
});
