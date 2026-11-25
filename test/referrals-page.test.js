'use strict';
// Row R4h-2: referrals on the Orders tab (modules/89-referrals.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-referrals.js'), 'utf8');
const NAMES = ['refLoad', 'renderReferrals', 'refAdd', 'refMove'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('refBox').innerHTML;
const F = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, destination_text: 'Cardiology clinic', reason_text: 'Needs review', priority: 'routine', status: 'active', row_version: 1,
  referred_by: 'doc', referred_at: '2026-11-26T10:00:00Z', cancelled_by: null, cancelled_at: null, cancel_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const RO = ['orders:read'], RW = ['orders:read', 'orders:write'];
const fill = (w, id, v) => { w.document.getElementById(id).value = v; };
const sleep = () => new Promise(r => setTimeout(r, 20));
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { calls.push({ u, m: opt && opt.method, b: opt && opt.body && JSON.parse(opt.body) });
    if (opt && opt.method === 'POST') return o.post ? o.post(u) : res(201, {});
    return res(200, { referrals: o.items || [] }); };
  return { calls, f };
}

test('89-referrals.js loads right after 89-abnormal.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage; the box sits in the Orders pane', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/89-referrals.js'), l.indexOf('modules/89-abnormal.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/89-referrals.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /<div class="pane" id="orders">[\s\S]*id="abnBox"[\s\S]*id="refBox"[\s\S]*<!-- MEDICATION HISTORY/);
});

test('without orders:read or a patient no request is made and the box is empty; signing out clears the list', async () => {
  const s = server({ items: [F()] }), w = await page(s.f);
  as(w, 'v', ['cases:read']); await w.eval('refLoad()'); assert.deepEqual(s.calls, []); assert.equal(box(w), '');
  as(w, 'v', RO); withCase(w, null, null); await w.eval('refLoad()'); assert.deepEqual(s.calls, []);
  withCase(w, 7, null); await w.eval('refLoad()'); assert.deepEqual(s.calls.map(c => c.u), ['/api/patients/7/referrals']);
  assert.equal(w.eval('REF.items.length'), 1);
  w.eval('Srv.user = null; renderReferrals()'); assert.equal(w.eval('REF.items.length'), 0); assert.equal(box(w), '');
});

test('referrals are shown escaped with status, priority, reason and who and when; a read-only role has no form or buttons; "show entered in error" asks for include=all', async () => {
  const s = server({ items: [F({ destination_text: '<img src=x onerror=alert(1)>', reason_text: '<b>why</b>' }), F({ id: 2, status: 'cancelled', cancelled_by: 'doc', cancelled_at: 'x', cancel_reason: 'r1', priority: 'urgent' }),
    F({ id: 3, status: 'entered_in_error', error_by: 'doc', error_at: 'x', error_reason: 'r2' })] });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7, null); await w.eval('refLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>why'), 'escaped'); assert.match(h, /&lt;img/);
  for (const x of ['>active<', '>cancelled<', '>entered in error<', 'urgent', 'Reason: ', 'Referred by doc', 'Cancelled by doc', 'Marked in error by doc', 'Final:', 'Your role cannot change referrals']) assert.ok(h.includes(x), x);
  assert.equal(w.document.querySelectorAll('[data-act=refAdd],[data-act=refCancel],[data-act=refError],textarea').length, 0);
  w.eval('REF.all = true'); s.calls.length = 0; await w.eval('refLoad()');
  assert.ok(s.calls.some(c => c.u === '/api/patients/7/referrals?include=all'), s.calls.map(c => c.u).join(','));
});

test('buttons follow permission and status: cancel only for active; entered in error for all but final rows; the form needs orders:write', async () => {
  const s = server({ items: [F(), F({ id: 2, status: 'cancelled', cancelled_by: 'd', cancelled_at: 'x', cancel_reason: 'r' }), F({ id: 3, status: 'entered_in_error', error_by: 'd', error_at: 'x', error_reason: 'r' })] });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('refLoad()');
  const d = w.document;
  assert.equal(d.querySelectorAll('[data-act=refCancel]').length, 1); assert.equal(d.querySelectorAll('[data-act=refError]').length, 2);
  assert.ok(d.getElementById('rf_n_dest')); assert.equal(d.querySelector('[data-act=refCancel]').dataset.arg, '1');
});

test('add sends only the typed fields (destination, reason, priority if chosen, the open case); nothing is sent without both texts; the server message is shown; the form clears on success', async () => {
  let status = 201;
  const s = server({ post: () => res(status, status === 201 ? {} : { error: 'invalid', message: 'Nope from server.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, 12); await w.eval('refLoad()'); s.calls.length = 0;
  await w.eval('refAdd()'); assert.deepEqual(s.calls, []); assert.match(box(w), /needs who it is to and a reason/);
  fill(w, 'rf_n_dest', 'Clinic'); await w.eval('refAdd()'); assert.deepEqual(s.calls, []);
  fill(w, 'rf_n_dest', ' Cardiology '); fill(w, 'rf_n_why', ' Chest pain '); await w.eval('refAdd()');
  const post = s.calls.find(c => c.m === 'POST');
  assert.equal(post.u, '/api/patients/7/referrals');
  assert.deepEqual(post.b, { destination: 'Cardiology', reason: 'Chest pain', originCaseId: 12 });
  assert.equal(w.document.getElementById('rf_n_dest').value, '', 'form cleared');
  s.calls.length = 0; fill(w, 'rf_n_dest', 'A'); fill(w, 'rf_n_why', 'B'); fill(w, 'rf_n_pri', 'urgent'); await w.eval('refAdd()');
  assert.deepEqual(s.calls.find(c => c.m === 'POST').b, { destination: 'A', reason: 'B', priority: 'urgent', originCaseId: 12 });
  status = 400; fill(w, 'rf_n_dest', 'A'); fill(w, 'rf_n_why', 'B'); await w.eval('refAdd()'); assert.match(box(w), /Nope from server/);
  assert.ok(!/referred_by|username/.test(JSON.stringify(s.calls.map(c => c.b))), 'no user field is ever sent');
});

test('cancel and entered in error need a reason, confirm, and send only reason and rowVersion; a stale answer shows the message and reloads', async () => {
  let status = 200;
  const s = server({ items: [F({ row_version: 4 })], post: () => res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('refLoad()'); s.calls.length = 0;
  await w.eval("refMove('cancel','1')"); assert.deepEqual(s.calls, []); assert.match(box(w), /A reason is required/);
  fill(w, 'rf_r1', ' Duplicate '); w.document.querySelector('[data-act=refCancel]').click(); await sleep(); await sleep();   // delegated click through ACT
  assert.deepEqual(s.calls.find(c => c.m === 'POST'), { u: '/api/referrals/1/cancel', m: 'POST', b: { reason: 'Duplicate', rowVersion: 4 } });
  s.calls.length = 0; fill(w, 'rf_r1', 'Mistake'); await w.eval("refMove('error','1')");
  assert.equal(s.calls.find(c => c.m === 'POST').u, '/api/referrals/1/entered-in-error');
  status = 409; s.calls.length = 0; fill(w, 'rf_r1', 'x'); await w.eval("refMove('cancel','1')");
  assert.match(box(w), /Changed by someone else/); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
  s.calls.length = 0; await w.eval("refMove('bogus','1')"); await w.eval("refMove('cancel','1; DROP')"); await w.eval("refMove('cancel','99')"); assert.deepEqual(s.calls, []);
});

test('typed drafts survive a re-render; a sign-out or another patient while a request is in flight is ignored', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = server({ items: [F()], post: async () => { await gate; return res(201, {}); } });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('refLoad()');
  fill(w, 'rf_n_dest', 'half'); fill(w, 'rf_r1', 'half reason'); w.eval('renderReferrals()');
  assert.equal(w.document.getElementById('rf_n_dest').value, 'half'); assert.equal(w.document.getElementById('rf_r1').value, 'half reason');
  fill(w, 'rf_n_dest', 'A'); fill(w, 'rf_n_why', 'B'); s.calls.length = 0;
  const p = w.eval('refAdd()'); w.eval('Srv.user = null'); release(); await p; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after sign-out');
  as(w, 'doc', RW); w.eval('CASE.patientId = 8'); s.calls.length = 0;
  const p2 = w.eval('refAdd()'); w.eval('CASE.patientId = 9'); await p2; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after another patient was opened');
});
