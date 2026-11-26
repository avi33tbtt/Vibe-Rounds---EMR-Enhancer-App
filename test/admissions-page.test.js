'use strict';
// Row R5b: admissions on the Orders tab (modules/89-admissions.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-admissions.js'), 'utf8');
const NAMES = ['admLoad', 'renderAdmissions', 'admAdd', 'admMove'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('admBox').innerHTML;
const F = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, ward_text: 'Ward 3', reason_text: 'Fever', admitted_at: '2026-11-20T03:45:00Z', status: 'active', row_version: 1,
  recorded_by: 'doc', recorded_at: '2026-11-26T10:00:00Z', cancelled_by: null, cancelled_at: null, cancel_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const RO = ['orders:read'], RW = ['orders:read', 'orders:write'];
const fill = (w, id, v) => { w.document.getElementById(id).value = v; };
const sleep = () => new Promise(r => setTimeout(r, 20));
const WHEN = '2026-11-20T09:30';
const ended = (id, st, extra) => F({ id, status: st, ...extra });
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { if (u === '/api/me') return res(401, {});   // boot probe: signed out, not counted
    calls.push({ u, m: opt && opt.method, b: opt && opt.body && JSON.parse(opt.body) });
    if (opt && opt.method === 'POST') return o.post ? o.post(u) : res(201, {});
    return res(200, { admissions: o.items || [] }); };
  return { calls, f };
}

test('89-admissions.js loads right after 89-procedures.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage; the box sits in the Orders pane after the procedures box', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/89-admissions.js'), l.indexOf('modules/89-procedures.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/89-admissions.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /<div class="pane" id="orders">[\s\S]*id="prcBox"[\s\S]*id="admBox"[\s\S]*<!-- MEDICATION HISTORY/);
  assert.match(raw, /prcLoad\(\);admLoad\(\)/, 'the Orders tab loads admissions');
});

test('without orders:read or a patient no request is made and the box is empty; signing out clears the list', async () => {
  const s = server({ items: [F()] }), w = await page(s.f);
  as(w, 'v', ['cases:read']); await w.eval('admLoad()'); assert.deepEqual(s.calls, []); assert.equal(box(w), '');
  as(w, 'v', RO); withCase(w, null, null); await w.eval('admLoad()'); assert.deepEqual(s.calls, []);
  withCase(w, 7, null); await w.eval('admLoad()'); assert.deepEqual(s.calls.map(c => c.u), ['/api/patients/7/admissions']);
  assert.equal(w.eval('ADM.items.length'), 1);
  w.eval('Srv.user = null; renderAdmissions()'); assert.equal(w.eval('ADM.items.length'), 0); assert.equal(box(w), '');
});

test('admissions are shown escaped with status, admitted time in UTC, reason and who and when; a read-only role has no form or buttons; "show entered in error" asks for include=all', async () => {
  const s = server({ items: [F({ ward_text: '<img src=x onerror=alert(1)>', reason_text: '<b>fine</b>' }), ended(2, 'cancelled', { cancelled_by: 'doc', cancelled_at: 'x', cancel_reason: 'r1' }),
    ended(3, 'entered_in_error', { error_by: 'doc', error_at: 'x', error_reason: 'r2' })] });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7, null); await w.eval('admLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>fine'), 'escaped'); assert.match(h, /&lt;img/);
  for (const x of ['>active<', '>cancelled<', '>entered in error<', 'Admitted 2026-11-20 03:45 UTC', 'Reason: ', 'Recorded by doc', 'Cancelled by doc', 'Marked in error by doc', 'Final:', 'Your role cannot change admissions']) assert.ok(h.includes(x), x);
  assert.equal(w.document.getElementById('admBox').querySelectorAll('[data-act=admAdd],[data-act=admCancel],[data-act=admError],textarea').length, 0);
  w.eval('ADM.all = true'); s.calls.length = 0; await w.eval('admLoad()');
  assert.ok(s.calls.some(c => c.u === '/api/patients/7/admissions?include=all'), s.calls.map(c => c.u).join(','));
});

test('buttons follow permission and status: cancel only for active; entered in error for all but final rows; the form needs orders:write and is hidden while an admission is active', async () => {
  const s = server({ items: [F(), ended(2, 'cancelled', { cancelled_by: 'd', cancelled_at: 'x', cancel_reason: 'r' }), ended(3, 'entered_in_error', { error_by: 'd', error_at: 'x', error_reason: 'r' })] });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('admLoad()');
  const d = w.document;
  assert.equal(d.querySelectorAll('[data-act=admCancel]').length, 1); assert.equal(d.querySelectorAll('[data-act=admError]').length, 2);
  assert.equal(d.querySelector('[data-act=admCancel]').dataset.arg, '1');
  assert.equal(d.getElementById('ad_n_ward'), null, 'no form while active'); assert.match(box(w), /already|has an active admission/);
  const s2 = server({ items: [ended(2, 'cancelled', { cancelled_by: 'd', cancelled_at: 'x', cancel_reason: 'r' })] }), w2 = await page(s2.f);
  as(w2, 'doc', RW); withCase(w2, 7, null); await w2.eval('admLoad()'); assert.ok(w2.document.getElementById('ad_n_ward'), 'form when none is active');
  const s3 = server({ items: [] }), w3 = await page(s3.f); as(w3, 'v', RO); withCase(w3, 7, null); await w3.eval('admLoad()'); assert.equal(w3.document.getElementById('ad_n_ward'), null);
});

test('add sends only the typed fields (ward, exact moment with offset, reason, the open case); nothing is sent when a field is missing or the time is in the future; the server message is shown; the form clears on success', async () => {
  let status = 201;
  const s = server({ post: () => res(status, status === 201 ? {} : { error: 'invalid', message: 'Nope from server.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, 12); await w.eval('admLoad()'); s.calls.length = 0;
  await w.eval('admAdd()'); assert.deepEqual(s.calls, []); assert.match(box(w), /needs the ward or unit, the time and the reason/);
  fill(w, 'ad_n_ward', 'Ward 3'); fill(w, 'ad_n_reason', 'Fever'); await w.eval('admAdd()'); assert.deepEqual(s.calls, []);
  fill(w, 'ad_n_when', `${new Date().getFullYear() + 1}-01-01T10:00`); await w.eval('admAdd()'); assert.deepEqual(s.calls, []); assert.match(box(w), /cannot be recorded as happening in the future/);
  fill(w, 'ad_n_ward', ' Ward 3 '); fill(w, 'ad_n_reason', ' Fever '); fill(w, 'ad_n_when', WHEN); await w.eval('admAdd()');
  const post = s.calls.find(c => c.m === 'POST');
  assert.equal(post.u, '/api/patients/7/admissions');
  assert.deepEqual(post.b, { ward: 'Ward 3', admittedAt: new Date(WHEN).toISOString(), reason: 'Fever', originCaseId: 12 });
  assert.equal(w.document.getElementById('ad_n_ward').value, '', 'form cleared');
  status = 400; fill(w, 'ad_n_ward', 'A'); fill(w, 'ad_n_reason', 'B'); fill(w, 'ad_n_when', WHEN); await w.eval('admAdd()'); assert.match(box(w), /Nope from server/);
  assert.ok(!/recorded_by|username/.test(JSON.stringify(s.calls.map(c => c.b))), 'no user field is ever sent');
});

test('a 409 on add (already admitted) shows the server message and reloads', async () => {
  const s = server({ post: () => res(409, { error: 'already_admitted', message: 'Already has an active admission.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('admLoad()');
  fill(w, 'ad_n_ward', 'A'); fill(w, 'ad_n_reason', 'B'); fill(w, 'ad_n_when', WHEN); s.calls.length = 0; await w.eval('admAdd()');
  assert.match(box(w), /Already has an active admission/); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
});

test('cancel and entered in error need a reason, confirm, and send only reason and rowVersion; a stale answer shows the message and reloads', async () => {
  let status = 200;
  const s = server({ items: [F({ row_version: 4 })], post: () => res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('admLoad()'); s.calls.length = 0;
  await w.eval("admMove('cancel','1')"); assert.deepEqual(s.calls, []); assert.match(box(w), /A reason is required/);
  fill(w, 'ad_r1', ' Duplicate '); w.document.querySelector('[data-act=admCancel]').click(); await sleep(); await sleep();   // delegated click through ACT
  assert.deepEqual(s.calls.find(c => c.m === 'POST'), { u: '/api/admissions/1/cancel', m: 'POST', b: { reason: 'Duplicate', rowVersion: 4 } });
  s.calls.length = 0; fill(w, 'ad_r1', 'Mistake'); await w.eval("admMove('error','1')");
  assert.equal(s.calls.find(c => c.m === 'POST').u, '/api/admissions/1/entered-in-error');
  status = 409; s.calls.length = 0; fill(w, 'ad_r1', 'x'); await w.eval("admMove('cancel','1')");
  assert.match(box(w), /Changed by someone else/); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
  s.calls.length = 0; await w.eval("admMove('bogus','1')"); await w.eval("admMove('cancel','1; DROP')"); await w.eval("admMove('cancel','99')"); assert.deepEqual(s.calls, []);
});

test('typed drafts survive a re-render; a sign-out or another patient while a request is in flight is ignored', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = server({ items: [F()], post: async () => { await gate; return res(201, {}); } });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('admLoad()');
  fill(w, 'ad_r1', 'half reason'); w.eval('renderAdmissions()');
  assert.equal(w.document.getElementById('ad_r1').value, 'half reason');
  w.eval('ADM.items = []; renderAdmissions()'); fill(w, 'ad_n_ward', 'half'); w.eval('renderAdmissions()'); assert.equal(w.document.getElementById('ad_n_ward').value, 'half');
  fill(w, 'ad_n_ward', 'A'); fill(w, 'ad_n_reason', 'B'); fill(w, 'ad_n_when', WHEN); s.calls.length = 0;
  const p = w.eval('admAdd()'); w.eval('Srv.user = null'); release(); await p; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after sign-out');
  as(w, 'doc', RW); w.eval('CASE.patientId = 8; ADM.items = []'); w.eval('renderAdmissions()'); fill(w, 'ad_n_ward', 'A'); fill(w, 'ad_n_reason', 'B'); fill(w, 'ad_n_when', WHEN); s.calls.length = 0;
  const p2 = w.eval('admAdd()'); w.eval('CASE.patientId = 9'); await p2; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after another patient was opened');
});
