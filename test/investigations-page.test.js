'use strict';
// Row R4g-2: investigation orders, specimens and results on the Orders tab (modules/89-investigations.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-investigations.js'), 'utf8');
const NAMES = ['invLoad', 'renderInvest', 'invAdd', 'invMove', 'invSpec', 'invResult', 'invCorSave'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('invBox').innerHTML;
const O = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, term_id: null, test_name: 'Test A', priority: 'routine', clinical_info: null, status: 'active', row_version: 1,
  ordered_by: 'doc', ordered_at: '2026-11-26T10:00:00Z', cancelled_by: null, cancelled_at: null, cancel_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const SP = (o = {}) => ({ id: 3, order_id: 1, specimen_type: 'Serum', collected_at: '2026-11-26T09:00:00Z', recorded_by: 'nurse', recorded_at: '2026-11-26T09:05:00Z', ...o });
const RS = (o = {}) => ({ id: 5, order_id: 1, specimen_id: 3, value_text: '4.1', unit_text: 'units', reference_text: '3 to 5', flag: 'not_stated', replaces_result_id: null, correction_reason: null,
  recorded_by: 'nurse', recorded_at: '2026-11-26T11:00:00Z', replaced: false, ...o });
const TERM = { id: 5, code: 'demo.test-a', version: 1, display: 'Test A term', category: 'test', status: 'published' };
const RO = ['orders:read', 'results:read'], RW = ['orders:read', 'orders:write', 'results:read', 'results:write'], NURSE = ['orders:read', 'results:read', 'results:write'];
const fill = (w, id, v) => { w.document.getElementById(id).value = v; };
const sleep = () => new Promise(r => setTimeout(r, 20));
// A fake server: lists, results and POST answers; records every call.
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { calls.push({ u, m: opt && opt.method, b: opt && opt.body && JSON.parse(opt.body) });
    if (opt && opt.method === 'POST') return o.post ? o.post(u) : res(201, {});
    if (u.startsWith('/api/local-terms')) return res(200, { terms: o.terms || [] });
    if (/\/results$/.test(u)) return res(200, { specimens: o.specimens || [], results: o.results || [] });
    return res(200, { orders: o.orders || [] }); };
  return { calls, f };
}

test('89-investigations.js loads right after 88-reconcile.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage; the box sits in the Orders pane', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/89-investigations.js'), l.indexOf('modules/88-reconcile.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/89-investigations.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /<div class="pane" id="orders">[\s\S]*id="reconcileBox"[\s\S]*id="invBox"[\s\S]*<!-- MEDICATION HISTORY/);
});

test('without orders:read or a patient no request is made and the box is empty; signing out clears the lists', async () => {
  const s = server({ orders: [O()] }), w = await page(s.f);
  as(w, 'v', ['cases:read']); await w.eval('invLoad()'); assert.deepEqual(s.calls, []); assert.equal(box(w), '');
  as(w, 'v', RO); withCase(w, null, null); await w.eval('invLoad()'); assert.deepEqual(s.calls, []);
  withCase(w, 7, null); await w.eval('invLoad()'); assert.deepEqual(s.calls.map(c => c.u), ['/api/patients/7/investigation-orders']);
  assert.equal(w.eval('INV.items.length'), 1);
  w.eval('Srv.user = null; renderInvest()'); assert.equal(w.eval('INV.items.length'), 0); assert.equal(box(w), '');
});

test('orders are shown escaped with status, priority and who and when; a read-only role has no form or buttons; "show entered in error" asks for include=all', async () => {
  const s = server({ orders: [O({ test_name: '<img src=x onerror=alert(1)>', clinical_info: '<b>info</b>' }), O({ id: 2, status: 'cancelled', cancelled_by: 'doc', cancelled_at: 'x', cancel_reason: 'r1', priority: 'urgent' }),
    O({ id: 3, status: 'entered_in_error', error_by: 'doc', error_at: 'x', error_reason: 'r2' })] });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7, null); await w.eval('invLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>info'), 'escaped'); assert.match(h, /&lt;img/);
  for (const x of ['>active<', '>cancelled<', '>entered in error<', 'urgent', 'free text, not verified', 'Ordered by doc', 'Cancelled by doc', 'Marked in error by doc', 'Final:', 'Your role cannot change orders']) assert.ok(h.includes(x), x);
  assert.equal(w.document.querySelectorAll('[data-act=invAdd],[data-act=invCancel],[data-act=invError],textarea').length, 0);
  w.eval('INV.all = true'); s.calls.length = 0; await w.eval('invLoad()');
  assert.ok(s.calls.some(c => c.u === '/api/patients/7/investigation-orders?include=all'), s.calls.map(c => c.u).join(','));
});

test('buttons follow permission and status: cancel only for active; entered in error for all but final rows; the form needs orders:write', async () => {
  const s = server({ orders: [O(), O({ id: 2, status: 'cancelled', cancelled_by: 'd', cancelled_at: 'x', cancel_reason: 'r' }), O({ id: 3, status: 'entered_in_error', error_by: 'd', error_at: 'x', error_reason: 'r' })] });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('invLoad()');
  const d = w.document;
  assert.equal(d.querySelectorAll('[data-act=invCancel]').length, 1); assert.equal(d.querySelectorAll('[data-act=invError]').length, 2);
  assert.ok(d.getElementById('iv_n_name')); assert.equal(d.querySelector('[data-act=invCancel]').dataset.arg, '1');
  as(w, 'nurse', NURSE); w.eval('renderInvest()');
  assert.equal(d.querySelectorAll('[data-act=invCancel],[data-act=invError],#iv_n_name').length, 0, 'a nurse cannot order or cancel');
});

test('only published test terms are offered; a picked term is sent as termId alone; add sends only the typed fields; nothing is sent without a test; the server message is shown', async () => {
  let status = 201;
  const s = server({ terms: [TERM, { ...TERM, id: 6, category: 'drug', display: 'A drug' }, { ...TERM, id: 8, status: 'retired', display: 'Old' }],
    post: () => res(status, status === 201 ? {} : { error: 'invalid', message: 'Nope from server.' }) });
  const w = await page(s.f); as(w, 'doc', [...RW, 'terms:read']); withCase(w, 7, 12); await w.eval('invLoad()');
  assert.deepEqual([...w.document.getElementById('iv_n_term').options].map(o => o.value), ['', '5']);
  s.calls.length = 0; await w.eval('invAdd()'); assert.deepEqual(s.calls, []); assert.match(box(w), /needs a test/);
  fill(w, 'iv_n_name', ' typed '); fill(w, 'iv_n_term', '5'); fill(w, 'iv_n_pri', 'urgent'); fill(w, 'iv_n_info', ' fever '); await w.eval('invAdd()');
  const post = s.calls.find(c => c.m === 'POST');
  assert.equal(post.u, '/api/patients/7/investigation-orders');
  assert.deepEqual(post.b, { termId: 5, priority: 'urgent', clinicalInfo: 'fever', originCaseId: 12 });
  assert.equal(w.document.getElementById('iv_n_name').value, '', 'form cleared');
  s.calls.length = 0; fill(w, 'iv_n_name', ' Free test '); await w.eval('invAdd()');
  assert.deepEqual(s.calls.find(c => c.m === 'POST').b, { testName: 'Free test', originCaseId: 12 });
  status = 400; fill(w, 'iv_n_name', 'x'); await w.eval('invAdd()'); assert.match(box(w), /Nope from server/);
  const w2 = await page(server().f); as(w2, 'doc', RW); withCase(w2, 7, null); await w2.eval('invLoad()');
  assert.equal(w2.document.getElementById('iv_n_term'), null, 'no term permission: free text only');
});

test('cancel and entered in error need a reason, confirm, and send only reason and rowVersion; a stale answer shows the message and reloads', async () => {
  let status = 200;
  const s = server({ orders: [O({ row_version: 4 })], post: () => res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('invLoad()'); s.calls.length = 0;
  await w.eval("invMove('cancel','1')"); assert.deepEqual(s.calls, []); assert.match(box(w), /A reason is required/);
  fill(w, 'iv_r1', ' Duplicate '); await w.eval("invMove('cancel','1')");
  assert.deepEqual(s.calls[0], { u: '/api/investigation-orders/1/cancel', m: 'POST', b: { reason: 'Duplicate', rowVersion: 4 } });
  s.calls.length = 0; fill(w, 'iv_r1', 'Mistake'); await w.eval("invMove('error','1')");
  assert.equal(s.calls[0].u, '/api/investigation-orders/1/entered-in-error');
  status = 409; s.calls.length = 0; fill(w, 'iv_r1', 'x'); await w.eval("invMove('cancel','1')");
  assert.match(box(w), /Changed by someone else/); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
  s.calls.length = 0; await w.eval("invMove('bogus','1')"); await w.eval("invMove('cancel','1; DROP')"); assert.deepEqual(s.calls, []);
});

test('specimens and results load only when opened; they are shown as typed, escaped; replaced results are struck and kept; the flag is only what the recorder chose', async () => {
  const s = server({ orders: [O()], specimens: [SP({ specimen_type: '<i>Serum</i>' })],
    results: [RS({ id: 5, replaced: true, value_text: '<b>9</b>', flag: 'abnormal' }), RS({ id: 6, value_text: '4.2', replaces_result_id: 5, correction_reason: 'typo <u>', flag: 'normal' })] });
  const w = await page(s.f); as(w, 'nurse', NURSE); withCase(w, 7, null); await w.eval('invLoad()');
  assert.ok(!s.calls.some(c => /\/results$/.test(c.u)), 'nothing fetched before it is opened');
  w.document.querySelector('[data-act=invOpen]').click(); await sleep(); await sleep();   // delegated click through ACT
  assert.ok(s.calls.some(c => c.u === '/api/investigation-orders/1/results'));
  const h = box(w);
  assert.ok(!h.includes('<i>Serum') && !h.includes('<b>9') && !h.includes('<u>'), 'escaped');
  for (const x of ['Serum', 'collected 2026-11-26 09:00', 'recorded by nurse', 'flagged abnormal by the recorder', 'flagged normal by the recorder', 'Replaced by a later result', 'replaces result #5: typo', 'text-decoration:line-through']) assert.ok(h.includes(x), x);
  assert.equal(w.document.querySelectorAll('[data-act=invCorOpen]').length, 1, 'only the current (not replaced) result can be corrected');
  assert.equal(w.document.querySelector('[data-act=invCorOpen]').dataset.arg, '6');
  w.document.querySelector('[data-act=invOpen]').click(); await sleep(); assert.ok(!box(w).includes('Specimens'), 'hidden again');
});

test('a viewer can read results but has no record or correct forms; an order that is not active takes no new specimens or results; no results:read hides the buttons', async () => {
  const s = server({ orders: [O(), O({ id: 2, status: 'cancelled', cancelled_by: 'd', cancelled_at: 'x', cancel_reason: 'r' })], specimens: [SP()], results: [RS()] });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7, null); await w.eval('invLoad()'); await w.eval("invOpen('1')");
  assert.ok(box(w).includes('4.1')); assert.equal(w.document.querySelectorAll('[data-act=invSpec],[data-act=invResult],[data-act=invCorOpen]').length, 0);
  as(w, 'nurse', NURSE); await w.eval("invOpen('2')"); w.eval('renderInvest()');
  assert.equal(w.document.querySelectorAll('[data-act=invSpec]').length, 1, 'only the active order has the forms');
  as(w, 'x', ['orders:read']); w.eval('renderInvest()'); assert.equal(w.document.querySelectorAll('[data-act=invOpen]').length, 0);
});

test('record specimen and result send only the typed fields (no recorder, no flag unless chosen); empty value or type sends nothing; server message is shown', async () => {
  let status = 201;
  const s = server({ orders: [O()], specimens: [SP()], post: () => res(status, status === 201 ? {} : { error: 'order_not_active', message: 'Order is not active.' }) });
  const w = await page(s.f); as(w, 'nurse', NURSE); withCase(w, 7, null); await w.eval('invLoad()'); await w.eval("invOpen('1')"); s.calls.length = 0;
  await w.eval("invSpec('1')"); await w.eval("invResult('1')"); assert.deepEqual(s.calls, []); assert.match(box(w), /specimen type is required|value is required/);
  fill(w, 'iv_s1', ' Plasma '); await w.eval("invSpec('1')");
  assert.deepEqual(s.calls.find(c => c.m === 'POST'), { u: '/api/investigation-orders/1/specimens', m: 'POST', b: { specimenType: 'Plasma' } });
  s.calls.length = 0; fill(w, 'iv_a1_v', ' 7.5 '); await w.eval("invResult('1')");
  assert.deepEqual(s.calls.find(c => c.m === 'POST').b, { valueText: '7.5' }, 'no flag, unit or specimen unless chosen');
  s.calls.length = 0; fill(w, 'iv_a1_v', '8'); fill(w, 'iv_a1_u', 'mg'); fill(w, 'iv_a1_r', '1 to 9'); fill(w, 'iv_a1_f', 'abnormal'); fill(w, 'iv_a1_s', '3'); await w.eval("invResult('1')");
  assert.deepEqual(s.calls.find(c => c.m === 'POST').b, { valueText: '8', unitText: 'mg', referenceText: '1 to 9', flag: 'abnormal', specimenId: 3 });
  status = 409; fill(w, 'iv_a1_v', '9'); await w.eval("invResult('1')"); assert.match(box(w), /Order is not active/);
  const bad = JSON.stringify(s.calls.map(c => c.b)); assert.ok(!/recorded_by|recordedBy|username/.test(bad));
});

test('correct: opens blank for a current result; needs a value and a reason; sends the new fields and the reason only; cancel closes it', async () => {
  const s = server({ orders: [O()], specimens: [SP()], results: [RS()] });
  const w = await page(s.f); as(w, 'nurse', NURSE); withCase(w, 7, null); await w.eval('invLoad()'); await w.eval("invOpen('1')"); s.calls.length = 0;
  assert.equal(w.document.getElementById('iv_c5_v'), null);
  w.document.querySelector('[data-act=invCorOpen]').click(); await sleep();
  assert.ok(w.document.getElementById('iv_c5_v')); assert.equal(w.document.getElementById('iv_c5_v').value, '');
  await w.eval("invCorSave('5')"); assert.deepEqual(s.calls, []); assert.match(box(w), /A value is required/);
  fill(w, 'iv_c5_v', '4.5'); await w.eval("invCorSave('5')"); assert.deepEqual(s.calls, []); assert.match(box(w), /A reason is required/);
  fill(w, 'iv_c5_x', ' Typing slip '); fill(w, 'iv_c5_f', 'normal'); await w.eval("invCorSave('5')");
  assert.deepEqual(s.calls.find(c => c.m === 'POST'), { u: '/api/investigation-results/5/correct', m: 'POST', b: { valueText: '4.5', flag: 'normal', reason: 'Typing slip' } });
  assert.equal(w.eval('INV.cor'), null, 'closed after success');
  w.eval('invCorOpen("5")'); w.eval('invCorCancel()'); assert.equal(w.eval('INV.cor'), null);
  s.calls.length = 0; await w.eval("invCorSave('5; DROP')"); await w.eval("invCorSave('99')"); assert.deepEqual(s.calls, []);
});

test('typed drafts survive a re-render; another patient or a sign-out while a request is in flight is ignored', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = server({ orders: [O()], post: async () => { await gate; return res(201, {}); } });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('invLoad()');
  fill(w, 'iv_n_name', 'half typed'); fill(w, 'iv_r1', 'half reason'); w.eval('renderInvest()');
  assert.equal(w.document.getElementById('iv_n_name').value, 'half typed'); assert.equal(w.document.getElementById('iv_r1').value, 'half reason');
  fill(w, 'iv_n_name', 'a test'); s.calls.length = 0;
  const p = w.eval('invAdd()'); w.eval('Srv.user = null'); release(); await p; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after sign-out');
  as(w, 'doc', RW); w.eval('CASE.patientId = 8'); s.calls.length = 0;
  const p2 = w.eval('invAdd()'); w.eval('CASE.patientId = 9'); await p2; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after another patient was opened');
});
