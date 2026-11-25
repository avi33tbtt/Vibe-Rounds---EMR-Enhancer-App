'use strict';
// Row R4g-3: abnormal results waiting for acknowledgement on the Orders tab (modules/89-abnormal.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-abnormal.js'), 'utf8');
const NAMES = ['abnLoad', 'renderAbnormal', 'abnAck'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}`);
const box = w => w.document.getElementById('abnBox').innerHTML;
const X = (o = {}) => ({ id: 5, order_id: 1, test_name: 'Test A', value_text: '9.9', unit_text: 'units', reference_text: '3 to 5', flag: 'abnormal', recorded_by: 'nurse',
  recorded_at: '2026-11-26T11:00:00Z', ack_id: null, acknowledged_by: null, acknowledged_at: null, ack_note: null, ...o });
const RO = ['results:read'], ACK = ['results:read', 'results:ack'];
const fill = (w, id, v) => { w.document.getElementById(id).value = v; };
const sleep = () => new Promise(r => setTimeout(r, 20));
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { calls.push({ u, m: opt && opt.method, b: opt && opt.body && JSON.parse(opt.body) });
    if (opt && opt.method === 'POST') return o.post ? o.post(u) : res(201, {});
    return res(200, { pending: o.pending || [], acknowledged: o.acknowledged || [] }); };
  return { calls, f };
}

test('89-abnormal.js loads right after 89-investigations.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage; the box sits in the Orders pane', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/89-abnormal.js'), l.indexOf('modules/89-investigations.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/89-abnormal.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /<div class="pane" id="orders">[\s\S]*id="invBox"[\s\S]*id="abnBox"[\s\S]*<!-- MEDICATION HISTORY/);
});

test('without results:read or a patient no request is made and the box is empty; signing out clears the lists', async () => {
  const s = server({ pending: [X()] }), w = await page(s.f);
  as(w, 'v', ['cases:read']); await w.eval('abnLoad()'); assert.deepEqual(s.calls, []); assert.equal(box(w), '');
  as(w, 'v', RO); withCase(w, null); await w.eval('abnLoad()'); assert.deepEqual(s.calls, []);
  withCase(w, 7); await w.eval('abnLoad()'); assert.deepEqual(s.calls.map(c => c.u), ['/api/patients/7/abnormal-results']);
  assert.equal(w.eval('ABN.pending.length'), 1);
  w.eval('Srv.user = null; renderAbnormal()'); assert.equal(w.eval('ABN.pending.length'), 0); assert.equal(box(w), '');
});

test('waiting and acknowledged results are shown as typed, escaped, with who and when; a role without results:ack has no button', async () => {
  const s = server({ pending: [X({ test_name: '<img src=x onerror=alert(1)>', value_text: '<b>9</b>' })],
    acknowledged: [X({ id: 6, ack_id: 2, acknowledged_by: 'doc', acknowledged_at: '2026-11-26T12:00:00Z', ack_note: 'seen <u>' })] });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7); await w.eval('abnLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>9') && !h.includes('<u>'), 'escaped');
  for (const x of ['Waiting for acknowledgement (1)', 'Acknowledged (1)', 'flagged abnormal by nurse', 'Acknowledged by doc', '2026-11-26 12:00', 'Your role cannot acknowledge']) assert.ok(h.includes(x), x);
  assert.equal(w.document.querySelectorAll('[data-act=abnAck],textarea').length, 0);
  as(w, 'doc', ACK); w.eval('renderAbnormal()');
  assert.equal(w.document.querySelectorAll('[data-act=abnAck]').length, 1); assert.equal(w.document.querySelector('[data-act=abnAck]').dataset.arg, '5');
});

test('empty lists say so; a load failure shows the server message', async () => {
  const w = await page(server().f); as(w, 'v', RO); withCase(w, 7); await w.eval('abnLoad()');
  assert.match(box(w), /None waiting/); assert.match(box(w), /None acknowledged yet/);
  const w2 = await page(async () => res(500, { error: 'x', message: 'Broke.' })); as(w2, 'v', RO); withCase(w2, 7); await w2.eval('abnLoad()');
  assert.match(box(w2), /could not be loaded: Broke/);
});

test('acknowledge sends only the note (nothing if blank), via the delegated click; the note draft survives a re-render; the list reloads', async () => {
  const s = server({ pending: [X()] }), w = await page(s.f); as(w, 'doc', ACK); withCase(w, 7); await w.eval('abnLoad()');
  fill(w, 'ab_n_5', 'half'); w.eval('renderAbnormal()'); assert.equal(w.document.getElementById('ab_n_5').value, 'half');
  s.calls.length = 0; fill(w, 'ab_n_5', ' Informed the family '); w.document.querySelector('[data-act=abnAck]').click(); await sleep(); await sleep();
  assert.deepEqual(s.calls.find(c => c.m === 'POST'), { u: '/api/investigation-results/5/acknowledge', m: 'POST', b: { note: 'Informed the family' } });
  assert.ok(s.calls.some(c => c.u === '/api/patients/7/abnormal-results'), 'reloaded');
  s.calls.length = 0; fill(w, 'ab_n_5', '   '); await w.eval("abnAck('5')");
  assert.deepEqual(s.calls.find(c => c.m === 'POST').b, {});
  assert.ok(!/recorded|acknowledged_by|username/.test(JSON.stringify(s.calls.map(c => c.b))));
});

test('without results:ack, with a bad id or an unlisted result, nothing is sent; a refusal shows the server message and a 409 reloads', async () => {
  let status = 409;
  const s = server({ pending: [X()], post: () => res(status, { error: 'already_acknowledged', message: 'This result was already acknowledged.' }) });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7); await w.eval('abnLoad()'); s.calls.length = 0;
  await w.eval("abnAck('5')"); assert.deepEqual(s.calls, []);
  as(w, 'doc', ACK); await w.eval("abnAck('5; DROP')"); await w.eval("abnAck('99')"); assert.deepEqual(s.calls, []);
  await w.eval("abnAck('5')"); assert.match(box(w), /already acknowledged/); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
  status = 403; s.calls.length = 0; await w.eval("abnAck('5')"); assert.match(box(w), /already acknowledged|permission/);
});

test('another patient or a sign-out while a request is in flight is ignored', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = server({ pending: [X()], post: async () => { await gate; return res(201, {}); } });
  const w = await page(s.f); as(w, 'doc', ACK); withCase(w, 7); await w.eval('abnLoad()'); s.calls.length = 0;
  const p = w.eval("abnAck('5')"); w.eval('Srv.user = null'); release(); await p; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after sign-out');
});
