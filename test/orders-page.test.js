'use strict';
// Row R4c: the Orders screen (modules/87-orders.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '87-orders.js'), 'utf8');
const NAMES = ['renderOrdersNav', 'ordersLoad', 'renderOrders', 'orderAdd', 'orderStep', 'orderChangeSave'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('ordersBox').innerHTML;
const O = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, term_id: null, medication: 'Drug A', dose_text: '5 units', route_text: 'oral', frequency_text: 'daily', indication_text: null, status: 'active',
  replaces_order_id: null, row_version: 1, ordered_by: 'doc', ordered_at: '2026-11-26T10:00:00Z', ended_by: null, ended_at: null, end_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const TERM = { id: 5, code: 'demo.drug-a', version: 1, display: 'Drug A term', category: 'drug', status: 'published' };
const RW = ['orders:read', 'orders:write'];
const fill = (w, p, v) => Object.entries(v).forEach(([k, x]) => { w.document.getElementById(p + '_' + k).value = x; });
const sleep = () => new Promise(r => setTimeout(r, 20));

test('87-orders.js loads right after 86-values.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/87-orders.js'), l.indexOf('modules/86-values.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/87-orders.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /id="navOrders"[^>]*display:none/); assert.match(raw, /<div class="pane" id="orders">/);
});

test('the tab is hidden without orders:read; without a patient or permission no request is made; signing out clears the list', async () => {
  const calls = [], w = await page(async u => { calls.push(u); return res(200, { orders: [O()] }); });
  as(w, 'v', ['cases:read']); w.eval('renderOrdersNav()');
  assert.equal(w.document.getElementById('navOrders').style.display, 'none');
  await w.eval('ordersLoad()'); assert.deepEqual(calls, []);
  as(w, 'v', ['orders:read']); w.eval('renderOrdersNav()');
  assert.equal(w.document.getElementById('navOrders').style.display, '');
  withCase(w, null, null); await w.eval('ordersLoad()'); assert.deepEqual(calls, []);
  withCase(w, 7, null); await w.eval('ordersLoad()'); assert.deepEqual(calls, ['/api/patients/7/medication-orders']);
  assert.equal(w.eval('ORD.items.length'), 1);
  w.eval('Srv.user = null; renderOrdersNav()'); assert.equal(w.eval('ORD.items.length'), 0); assert.equal(w.eval('ORD.loaded'), false);
});

test('orders are shown escaped, with their status, source and history; a read-only role has no buttons or form', async () => {
  const w = await page(async () => res(200, { orders: [O({ medication: '<img src=x onerror=alert(1)>', ordered_by: '<i>u</i>', indication_text: 'pain' }),
    O({ id: 2, status: 'changed', ended_by: 'doc', ended_at: '2026-11-26T11:00:00Z', end_reason: 'dose' }), O({ id: 3, term_id: 5, replaces_order_id: 2 }),
    O({ id: 4, status: 'entered_in_error', error_by: 'doc', error_at: '2026-11-26T12:00:00Z', error_reason: 'wrong' })] }));
  as(w, 'v', ['orders:read']); withCase(w, 7, null); await w.eval('ordersLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img src=x'), 'escaped'); assert.match(h, /&lt;img/);
  for (const s of ['>active<', '>changed<', '>entered in error<', 'free text, not verified', 'local drug term', 'replaces order #2', 'Dose 5 units', 'route oral', 'for pain', 'Your role cannot change orders']) assert.ok(h.includes(s), s);
  assert.equal(w.document.querySelectorAll('[data-act=orderStop],[data-act=orderError],[data-act=orderChangeOpen],#of_name').length, 0);
});

test('buttons follow permission and status: stop and change only for active; entered in error for all but final rows; the form needs orders:write', async () => {
  const items = [O(), O({ id: 2, status: 'stopped', ended_by: 'd', ended_at: 'x', end_reason: 'r' }), O({ id: 3, status: 'entered_in_error', error_by: 'd', error_at: 'x', error_reason: 'r' })];
  const w = await page(async () => res(200, { orders: items }));
  as(w, 'doc', RW); withCase(w, 7, null); await w.eval('ordersLoad()');
  const d = w.document;
  assert.equal(d.querySelectorAll('[data-act=orderStop]').length, 1); assert.equal(d.querySelectorAll('[data-act=orderChangeOpen]').length, 1);
  assert.equal(d.querySelectorAll('[data-act=orderError]').length, 2); assert.ok(d.getElementById('of_name'));
  assert.equal(d.querySelector('[data-act=orderStop]').dataset.arg, '1');
});

test('"Show entered in error" asks for include=all', async () => {
  const calls = [], w = await page(async u => { calls.push(u); return res(200, { orders: [] }); });
  as(w, 'doc', RW); withCase(w, 7, null); await w.eval('ordersLoad()');
  w.eval('ORD.all = true'); await w.eval('ordersLoad()');
  assert.ok(calls.includes('/api/patients/7/medication-orders?include=all'), calls.join(','));
});

test('only published drug terms are offered; a picked term is sent as termId alone, without the typed name', async () => {
  const calls = [];
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) });
    if (u === '/api/local-terms?status=published') return res(200, { terms: [TERM, { ...TERM, id: 6, category: 'test', display: 'A test' }, { ...TERM, id: 8, status: 'retired', display: 'Old' }] });
    return o && o.method === 'POST' ? res(201, {}) : res(200, { orders: [] }); });
  as(w, 'doc', [...RW, 'terms:read']); withCase(w, 7, 12); await w.eval('ordersLoad()');
  const sel = w.document.getElementById('of_term'); assert.ok(sel);
  assert.deepEqual([...sel.options].map(o => o.value), ['', '5']);
  fill(w, 'of', { name: 'typed name', term: '5', dose: ' 1 tab ', route: ' oral ', freq: ' bd ' });
  calls.length = 0; await w.eval('orderAdd()');
  const post = calls.find(c => c.m === 'POST');
  assert.deepEqual(post.b, { termId: 5, doseText: '1 tab', routeText: 'oral', frequencyText: 'bd', originCaseId: 12 });
  const w2 = await page(async () => res(200, { orders: [] })); as(w2, 'doc', RW); withCase(w2, 7, null); await w2.eval('ordersLoad()');
  assert.equal(w2.document.getElementById('of_term'), null, 'no term permission: free text only');
});

test('add sends only the typed fields; missing name, dose, route or frequency send nothing; the server message is shown on refusal', async () => {
  const calls = []; let status = 201;
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) });
    return o && o.method === 'POST' ? res(status, status === 201 ? {} : { error: 'invalid', message: 'Nope from server.' }) : res(200, { orders: [] }); });
  as(w, 'doc', RW); withCase(w, 7, 12); await w.eval('ordersLoad()'); calls.length = 0;
  await w.eval('orderAdd()'); assert.deepEqual(calls, []); assert.match(box(w), /needs a medication/);
  fill(w, 'of', { name: 'Drug', dose: '1' }); await w.eval('orderAdd()'); assert.deepEqual(calls, []); assert.match(box(w), /needs a dose, a route and a frequency/);
  fill(w, 'of', { name: ' Drug ', dose: ' 1 ', route: ' oral ', freq: ' daily ', ind: ' pain ' }); await w.eval('orderAdd()');
  const post = calls.find(c => c.m === 'POST');
  assert.equal(post.u, '/api/patients/7/medication-orders');
  assert.deepEqual(post.b, { medication: 'Drug', doseText: '1', routeText: 'oral', frequencyText: 'daily', indicationText: 'pain', originCaseId: 12 });
  assert.equal(w.document.getElementById('of_name').value, '', 'form cleared');
  status = 400; fill(w, 'of', { name: 'Drug', dose: '1', route: 'r', freq: 'f' }); await w.eval('orderAdd()'); assert.match(box(w), /Nope from server/);
});

test('stop and entered in error need a reason, confirm, and send only reason and rowVersion; a stale answer reloads', async () => {
  const calls = []; let status = 200;
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) });
    return o && o.method === 'POST' ? res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) : res(200, { orders: [O({ row_version: 4 })] }); });
  as(w, 'doc', RW); withCase(w, 7, null); await w.eval('ordersLoad()'); calls.length = 0;
  await w.eval("orderStep('stop','1')"); assert.deepEqual(calls, []); assert.match(box(w), /A reason is required/);
  w.document.getElementById('or_1').value = ' Healed ';
  await w.eval("orderStep('stop','1')");
  assert.deepEqual(calls[0], { u: '/api/medication-orders/1/stop', m: 'POST', b: { reason: 'Healed', rowVersion: 4 } });
  calls.length = 0; w.document.getElementById('or_1').value = 'Mistake'; await w.eval("orderStep('error','1')");
  assert.equal(calls[0].u, '/api/medication-orders/1/entered-in-error');
  status = 409; calls.length = 0; w.document.getElementById('or_1').value = 'x'; await w.eval("orderStep('stop','1')");
  assert.match(box(w), /Changed by someone else/); assert.ok(calls.some(c => c.m !== 'POST'), 'reloaded');
  calls.length = 0; await w.eval("orderStep('bogus','1')"); await w.eval("orderStep('stop','1; DROP')"); assert.deepEqual(calls, []);
});

test('change: opens a blank form for an active order; needs a reason and a full new order; sends the new fields, the reason and rowVersion only', async () => {
  const calls = [];
  const w = await page(async (u, o) => { calls.push({ u, m: o && o.method, b: o && o.body && JSON.parse(o.body) });
    return o && o.method === 'POST' ? res(200, {}) : res(200, { orders: [O({ row_version: 3 })] }); });
  as(w, 'doc', RW); withCase(w, 7, 12); await w.eval('ordersLoad()'); calls.length = 0;
  assert.equal(w.document.getElementById('oc_name'), null);
  w.document.querySelector('[data-act=orderChangeOpen]').click(); await sleep();   // delegated click through ACT
  assert.ok(w.document.getElementById('oc_name')); assert.equal(w.document.getElementById('oc_name').value, '');
  await w.eval("orderChangeSave('1')"); assert.deepEqual(calls, []); assert.match(box(w), /A reason is required/);
  w.document.getElementById('or_1').value = 'Dose too low';
  await w.eval("orderChangeSave('1')"); assert.deepEqual(calls, []); assert.match(box(w), /needs a medication/);
  fill(w, 'oc', { name: 'Drug B', dose: '10', route: 'oral', freq: 'daily' });
  await w.eval("orderChangeSave('1')");
  assert.deepEqual(calls.find(c => c.m === 'POST'), { u: '/api/medication-orders/1/change', m: 'POST', b: { medication: 'Drug B', doseText: '10', routeText: 'oral', frequencyText: 'daily', reason: 'Dose too low', rowVersion: 3 } });
  assert.equal(w.eval('ORD.chg'), null, 'form closed after a successful change');
  w.eval('orderChangeOpen("1")'); w.eval('orderChangeCancel()'); assert.equal(w.eval('ORD.chg'), null);
});
