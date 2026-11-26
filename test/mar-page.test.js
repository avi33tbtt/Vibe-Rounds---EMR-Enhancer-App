'use strict';
// Row R5e: medication administration record on the Orders tab (modules/89-mar.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-mar.js'), 'utf8');
const NAMES = ['marLoad', 'renderMar', 'marAdd', 'marError'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}`);
const box = w => w.document.getElementById('marBox').innerHTML;
const A = (o = {}) => ({ id: 1, patient_id: 7, order_id: 5, medication: 'Drug A', outcome: 'given', administered_at: '2026-11-20T03:45:00Z', dose_text: null, reason_text: null, note_text: null,
  status: 'recorded', row_version: 1, recorded_by: 'nurse', recorded_at: '2026-11-26T10:00:00Z', error_by: null, error_at: null, error_reason: null, ...o });
const ORDERS = [{ id: 5, medication: 'Drug A', status: 'active' }, { id: 6, medication: 'Drug B', status: 'stopped' }];
const RO = ['mar:read'], RW = ['mar:read', 'mar:write', 'orders:read'];
const fill = (w, id, v) => { w.document.getElementById(id).value = v; };
const sleep = () => new Promise(r => setTimeout(r, 20));
const WHEN = '2026-11-20T09:30';
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { calls.push({ u, m: opt && opt.method, b: opt && opt.body && JSON.parse(opt.body) });
    if (u === '/api/me') return res(401, {});   // the page's boot check: signed out, so the tests set the user themselves
    if (opt && opt.method === 'POST') return o.post ? o.post(u) : res(201, {});
    if (u.includes('/medication-orders')) return res(200, { orders: o.orders || ORDERS });
    return res(200, { administrations: o.items || [] }); };
  return { calls, f };
}

test('89-mar.js loads right after 89-admissions.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage; the box sits in the Orders pane after the admissions box', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/89-mar.js'), l.indexOf('modules/89-admissions.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/89-mar.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /<div class="pane" id="orders">[\s\S]*id="admBox"[\s\S]*id="marBox"[\s\S]*<!-- MEDICATION HISTORY/);
  assert.match(raw, /admLoad\(\);marLoad\(\)/, 'the Orders tab loads the administration record');
});

test('without mar:read or a patient no request is made and the box is empty; signing out clears the list', async () => {
  const s = server({ items: [A()] }), w = await page(s.f);
  as(w, 'v', ['cases:read']); await w.eval('marLoad()'); assert.deepEqual(s.calls.filter(c => c.u !== '/api/me'), []); assert.equal(box(w), '');
  as(w, 'v', RO); withCase(w, null); await w.eval('marLoad()'); assert.deepEqual(s.calls.filter(c => c.u !== '/api/me'), []);
  withCase(w, 7); await w.eval('marLoad()'); assert.deepEqual(s.calls.map(c => c.u).filter(u => u !== '/api/me'), ['/api/patients/7/administrations']);
  assert.equal(w.eval('MAR.items.length'), 1);
  w.eval('Srv.user = null; renderMar()'); assert.equal(w.eval('MAR.items.length'), 0); assert.equal(box(w), '');
});

test('entries are shown escaped with outcome, time in UTC, dose, reason, note and who and when; a read-only role has no form or buttons; "show entered in error" asks for include=all', async () => {
  const s = server({ items: [A({ medication: '<img src=x onerror=alert(1)>', dose_text: '<b>5</b>', note_text: 'n1' }), A({ id: 2, outcome: 'held', reason_text: 'r1' }),
    A({ id: 3, status: 'entered_in_error', error_by: 'doc', error_at: 'x', error_reason: 'r2' })] });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7); await w.eval('marLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>5'), 'escaped'); assert.match(h, /&lt;img/);
  for (const x of ['>given<', '>held<', '>entered in error<', 'given at 2026-11-20 03:45 UTC', 'Dose given: ', 'Reason: r1', 'Note: n1', 'Recorded by nurse', 'Marked in error by doc', 'Final:', 'Your role cannot change']) assert.ok(h.includes(x), x);
  assert.equal(w.document.getElementById('marBox').querySelectorAll('[data-act=marAdd],[data-act=marError],textarea').length, 0);
  assert.ok(!s.calls.some(c => c.u.includes('/medication-orders')), 'a read-only role does not fetch orders');
  w.eval('MAR.all = true'); s.calls.length = 0; await w.eval('marLoad()');
  assert.ok(s.calls.some(c => c.u === '/api/patients/7/administrations?include=all'), s.calls.map(c => c.u).join(','));
});

test('the form needs mar:write and offers only ACTIVE orders; "entered in error" shows for every row that is not final', async () => {
  const s = server({ items: [A(), A({ id: 3, status: 'entered_in_error', error_by: 'd', error_at: 'x', error_reason: 'r' })] });
  const w = await page(s.f); as(w, 'nurse', RW); withCase(w, 7); await w.eval('marLoad()');
  const d = w.document, opts = [...d.querySelectorAll('#mr_n_order option')].map(o => o.textContent);
  assert.deepEqual(opts, ['choose the active order (required)', 'Drug A']);
  assert.equal(d.querySelectorAll('[data-act=marError]').length, 1); assert.equal(d.querySelector('[data-act=marError]').dataset.arg, '1');
  as(w, 'x', ['mar:read', 'mar:write']); w.eval('renderMar()'); assert.match(box(w), /cannot see the medication orders/);
});

test('add sends only the typed fields; given takes a dose, held or refused needs a reason and sends no dose; nothing is sent without order and time or with a future time; the server message is shown; the form clears on success', async () => {
  let status = 201;
  const s = server({ items: [], post: () => (status === 201 ? res(201, {}) : res(409, { message: 'An administration is already recorded for this order at that moment.' })) });
  const w = await page(s.f); as(w, 'nurse', RW); withCase(w, 7); await w.eval('marLoad()');
  const posts = () => s.calls.filter(c => c.m === 'POST');
  w.eval('marAdd()'); await sleep(); assert.equal(posts().length, 0); assert.match(box(w), /needs the medication order/);
  fill(w, 'mr_n_order', '5'); fill(w, 'mr_n_when', '2999-01-01T09:30'); w.eval('marAdd()'); await sleep(); assert.equal(posts().length, 0); assert.match(box(w), /cannot be recorded in the future/);
  fill(w, 'mr_n_when', WHEN); fill(w, 'mr_n_dose', ' 2 tablets '); fill(w, 'mr_n_note', 'with food');
  status = 409; w.eval('marAdd()'); await sleep(); await sleep();
  assert.equal(posts().length, 1); assert.deepEqual(Object.keys(posts()[0].b).sort(), ['administeredAt', 'dose', 'note', 'orderId', 'outcome']);
  assert.equal(posts()[0].b.orderId, 5); assert.equal(posts()[0].b.dose, '2 tablets'); assert.equal(posts()[0].b.administeredAt, new Date(WHEN).toISOString());
  assert.match(box(w), /already recorded for this order/);
  status = 201; w.eval('marAdd()'); await sleep(); await sleep();
  assert.equal(posts().length, 2); assert.equal(w.document.getElementById('mr_n_dose').value, '');
  // held: reason required, no dose field, sends reason only
  fill(w, 'mr_n_order', '5'); fill(w, 'mr_n_out', 'held'); w.document.getElementById('mr_n_out').dispatchEvent(new w.Event('change', { bubbles: true })); await sleep();
  assert.ok(!w.document.getElementById('mr_n_dose') && w.document.getElementById('mr_n_reason'));
  fill(w, 'mr_n_when', WHEN); w.eval('marAdd()'); await sleep(); assert.equal(posts().length, 2); assert.match(box(w), /reason is required/);
  fill(w, 'mr_n_reason', 'patient asleep'); w.eval('marAdd()'); await sleep(); await sleep();
  assert.equal(posts().length, 3); assert.deepEqual(Object.keys(posts()[2].b).sort(), ['administeredAt', 'orderId', 'outcome', 'reason']); assert.equal(posts()[2].b.outcome, 'held');
});

test('entered in error needs a reason, asks to confirm, sends only reason and the loaded row version, and reloads on a 409', async () => {
  let status = 200;
  const s = server({ items: [A({ row_version: 4 })], post: () => (status === 200 ? res(200, {}) : res(409, { message: 'Reload it and try again.' })) });
  const w = await page(s.f); as(w, 'nurse', RW); withCase(w, 7); await w.eval('marLoad()');
  const posts = () => s.calls.filter(c => c.m === 'POST');
  w.eval("marError('1')"); await sleep(); assert.equal(posts().length, 0); assert.match(box(w), /A reason is required/);
  fill(w, 'mr_r1', 'wrong patient'); let asked = 0; w.confirm = () => { asked++; return false; };
  w.eval("marError('1')"); await sleep(); assert.equal(asked, 1); assert.equal(posts().length, 0);
  w.confirm = () => true; status = 409; s.calls.length = 0; w.eval("marError('1')"); await sleep(); await sleep();
  assert.equal(posts()[0].u, '/api/administrations/1/entered-in-error'); assert.deepEqual(posts()[0].b, { reason: 'wrong patient', rowVersion: 4 });
  assert.ok(s.calls.some(c => c.m !== 'POST' && c.u.endsWith('/administrations')), 'reloaded after the 409'); assert.match(box(w), /Reload it and try again/);
  w.eval("marError('abc')"); await sleep(); assert.equal(posts().length, 1);
});
