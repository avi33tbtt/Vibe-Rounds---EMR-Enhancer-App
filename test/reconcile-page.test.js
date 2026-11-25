'use strict';
// Row R4d-2: medication reconciliation on the Orders tab (modules/88-reconcile.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '88-reconcile.js'), 'utf8');
const NAMES = ['reconcileLoad', 'renderReconcile', 'reconcileStep'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('reconcileBox').innerHTML;
const H = (o = {}) => ({ id: 1, medication: 'History drug', dose_text: '5 mg', frequency_text: 'daily', start_date: '2020-01-01', status: 'active', row_version: 1, decision: null, ...o });
const OR = (o = {}) => ({ id: 9, medication: 'Order drug', dose_text: '10 mg', route_text: 'oral', frequency_text: 'bd', indication_text: null, status: 'active', row_version: 1, ...o });
const RW = ['orders:read', 'orders:write'];
const data = (h, o) => async () => res(200, { history: h, orders: o });

test('88-reconcile.js loads right after 87-orders.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage; the box sits in the Orders pane', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/88-reconcile.js'), l.indexOf('modules/87-orders.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/88-reconcile.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /<div class="pane" id="orders">[\s\S]*id="reconcileBox"[\s\S]*<!-- MEDICATION HISTORY/);
});

test('without orders:read or a patient no request is made and the box is empty; signing out clears the lists', async () => {
  const calls = [], w = await page(async u => { calls.push(u); return res(200, { history: [H()], orders: [] }); });
  as(w, 'v', ['cases:read']); await w.eval('reconcileLoad()'); assert.deepEqual(calls, []); assert.equal(box(w), '');
  as(w, 'v', ['orders:read']); withCase(w, null, null); await w.eval('reconcileLoad()'); assert.deepEqual(calls, []);
  withCase(w, 7, null); await w.eval('reconcileLoad()'); assert.deepEqual(calls, ['/api/patients/7/medication-reconciliation']);
  assert.equal(w.eval('REC.history.length'), 1);
  w.eval('Srv.user = null; renderReconcile()'); assert.equal(w.eval('REC.history.length'), 0); assert.equal(box(w), '');
});

test('history and orders are shown side by side, escaped, with the latest decision; a read-only role has no form or buttons', async () => {
  const w = await page(data([H({ medication: '<img src=x onerror=alert(1)>' }), H({ id: 2, medication: 'Second', decision: { decision: 'continue', order_id: 9, reason: 'covered <b>', decided_by: 'doc', decided_at: '2026-11-26T10:00:00Z' } })],
    [OR({ medication: '<i>o</i>' })]));
  as(w, 'v', ['orders:read']); withCase(w, 7, null); await w.eval('reconcileLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img src=x') && !h.includes('<i>o</i>') && !h.includes('<b>covered'), 'escaped');
  for (const s of ['Active orders', 'Not reconciled yet', 'Latest decision', 'covered by order #9', 'by doc', 'dose 10 mg', 'Your role cannot record']) assert.ok(h.includes(s), s);
  assert.equal(w.document.querySelectorAll('[data-act=reconcileStop],[data-act=reconcileContinue],[data-act=reconcileNotTaken],textarea').length, 0);
});

test('with orders:write each item has a reason box and Stop and Not taken; Continue and the order picker only when an active order exists', async () => {
  const w = await page(data([H()], []));
  as(w, 'doc', RW); withCase(w, 7, null); await w.eval('reconcileLoad()');
  assert.match(box(w), /No active orders/); assert.equal(w.document.querySelectorAll('[data-act=reconcileContinue]').length, 0);
  assert.equal(w.document.querySelectorAll('[data-act=reconcileStop],[data-act=reconcileNotTaken]').length, 2);
  const w2 = await page(data([H()], [OR()]));
  as(w2, 'doc', RW); withCase(w2, 7, null); await w2.eval('reconcileLoad()');
  assert.equal(w2.document.querySelectorAll('[data-act=reconcileContinue]').length, 1); assert.ok(w2.document.getElementById('rc_o_1'));
  assert.deepEqual([...w2.document.getElementById('rc_o_1').options].map(o => o.value), ['', '9']);
  const w3 = await page(data([], [])); as(w3, 'doc', RW); withCase(w3, 7, null); await w3.eval('reconcileLoad()');
  assert.match(box(w3), /No active medications on the recorded list/);
});

test('a decision needs a reason; continue needs a picked order; the request carries only the allowed fields; the list reloads after', async () => {
  const calls = [];
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) });
    return o && o.method === 'POST' ? res(201, {}) : res(200, { history: [H()], orders: [OR()] }); });
  as(w, 'doc', RW); withCase(w, 7, null); await w.eval('reconcileLoad()'); calls.length = 0;
  await w.eval("reconcileStep('stop','1')"); assert.deepEqual(calls, []); assert.match(box(w), /A reason is required/);
  w.document.getElementById('rc_r_1').value = ' not needed ';
  await w.eval("reconcileStep('continue','1')"); assert.deepEqual(calls, []); assert.match(box(w), /pick one/);
  assert.equal(w.document.getElementById('rc_r_1').value, ' not needed ', 'the typed reason survives a refusal');
  w.document.getElementById('rc_o_1').value = '9'; await w.eval("reconcileStep('continue','1')");
  assert.deepEqual(calls[0], { u: '/api/patients/7/medication-reconciliation', m: 'POST', b: { medicationId: 1, decision: 'continue', reason: 'not needed', orderId: 9 } });
  assert.ok(calls.some(c => c.m !== 'POST'), 'reloaded');
  calls.length = 0; w.document.getElementById('rc_r_1').value = 'never took'; await w.eval("reconcileStep('not_taken','1')");
  assert.deepEqual(calls[0].b, { medicationId: 1, decision: 'not_taken', reason: 'never took' });
  calls.length = 0; w.document.getElementById('rc_r_1').value = 'ok'; await w.eval("reconcileStep('stop','1')");
  assert.deepEqual(calls[0].b, { medicationId: 1, decision: 'stop', reason: 'ok' });
});

test('a server refusal shows its message under the item; 409 reloads; bad arguments and a read-only role send nothing', async () => {
  const calls = []; let status = 400;
  const w = await page(async (u, o) => { calls.push(o && o.method || 'GET'); return o && o.method === 'POST' ? res(status, { error: 'x', message: 'Server says no.' }) : res(200, { history: [H()], orders: [] }); });
  as(w, 'doc', RW); withCase(w, 7, null); await w.eval('reconcileLoad()'); calls.length = 0;
  w.document.getElementById('rc_r_1').value = 'r'; await w.eval("reconcileStep('stop','1')");
  assert.match(box(w), /Server says no/); assert.deepEqual(calls, ['POST']);
  status = 409; calls.length = 0; await w.eval("reconcileStep('stop','1')"); assert.deepEqual(calls, ['POST', 'GET']);
  calls.length = 0; await w.eval("reconcileStep('bogus','1')"); await w.eval("reconcileStep('stop','1; DROP')"); await w.eval("reconcileStep('stop','77')");
  as(w, 'v', ['orders:read']); await w.eval("reconcileStep('stop','1')"); assert.deepEqual(calls, []);
});

test('delegated clicks reach the right decision through ACT', async () => {
  const calls = [];
  const w = await page(async (u, o) => { calls.push(o && o.body && JSON.parse(o.body)); return o && o.method === 'POST' ? res(201, {}) : res(200, { history: [H()], orders: [] }); });
  as(w, 'doc', RW); withCase(w, 7, null); await w.eval('reconcileLoad()'); calls.length = 0;
  w.document.getElementById('rc_r_1').value = 'why'; w.document.querySelector('[data-act=reconcileNotTaken]').click(); await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(calls[0], { medicationId: 1, decision: 'not_taken', reason: 'why' });
});
