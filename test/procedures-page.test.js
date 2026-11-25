'use strict';
// Row R4i-2: procedures on the Orders tab (modules/89-procedures.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-procedures.js'), 'utf8');
const NAMES = ['prcLoad', 'renderProcedures', 'prcAdd', 'prcMove'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const box = w => w.document.getElementById('prcBox').innerHTML;
const F = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, procedure_text: 'Lumbar puncture', performed_at: '2026-11-20T03:45:00Z', outcome_text: null, status: 'active', row_version: 1,
  recorded_by: 'doc', recorded_at: '2026-11-26T10:00:00Z', cancelled_by: null, cancelled_at: null, cancel_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const RO = ['orders:read'], RW = ['orders:read', 'orders:write'];
const fill = (w, id, v) => { w.document.getElementById(id).value = v; };
const sleep = () => new Promise(r => setTimeout(r, 20));
const WHEN = '2026-11-20T09:30';
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { calls.push({ u, m: opt && opt.method, b: opt && opt.body && JSON.parse(opt.body) });
    if (opt && opt.method === 'POST') return o.post ? o.post(u) : res(201, {});
    return res(200, { procedures: o.items || [] }); };
  return { calls, f };
}

test('89-procedures.js loads right after 89-referrals.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage; the box sits in the Orders pane after the referrals box', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/89-procedures.js'), l.indexOf('modules/89-referrals.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/89-procedures.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /<div class="pane" id="orders">[\s\S]*id="refBox"[\s\S]*id="prcBox"[\s\S]*<!-- MEDICATION HISTORY/);
  assert.match(raw, /abnLoad\(\);refLoad\(\);prcLoad\(\)/, 'the Orders tab loads procedures');
});

test('without orders:read or a patient no request is made and the box is empty; signing out clears the list', async () => {
  const s = server({ items: [F()] }), w = await page(s.f);
  as(w, 'v', ['cases:read']); await w.eval('prcLoad()'); assert.deepEqual(s.calls, []); assert.equal(box(w), '');
  as(w, 'v', RO); withCase(w, null, null); await w.eval('prcLoad()'); assert.deepEqual(s.calls, []);
  withCase(w, 7, null); await w.eval('prcLoad()'); assert.deepEqual(s.calls.map(c => c.u), ['/api/patients/7/procedures']);
  assert.equal(w.eval('PRC.items.length'), 1);
  w.eval('Srv.user = null; renderProcedures()'); assert.equal(w.eval('PRC.items.length'), 0); assert.equal(box(w), '');
});

test('procedures are shown escaped with status, performed time in UTC, outcome and who and when; a read-only role has no form or buttons; "show entered in error" asks for include=all', async () => {
  const s = server({ items: [F({ procedure_text: '<img src=x onerror=alert(1)>', outcome_text: '<b>fine</b>' }), F({ id: 2, status: 'cancelled', cancelled_by: 'doc', cancelled_at: 'x', cancel_reason: 'r1' }),
    F({ id: 3, status: 'entered_in_error', error_by: 'doc', error_at: 'x', error_reason: 'r2' })] });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7, null); await w.eval('prcLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>fine'), 'escaped'); assert.match(h, /&lt;img/);
  for (const x of ['>active<', '>cancelled<', '>entered in error<', 'Performed 2026-11-20 03:45 UTC', 'Outcome: ', 'Recorded by doc', 'Cancelled by doc', 'Marked in error by doc', 'Final:', 'Your role cannot change procedures']) assert.ok(h.includes(x), x);
  assert.equal(w.document.querySelectorAll('[data-act=prcAdd],[data-act=prcCancel],[data-act=prcError],textarea').length, 0);
  w.eval('PRC.all = true'); s.calls.length = 0; await w.eval('prcLoad()');
  assert.ok(s.calls.some(c => c.u === '/api/patients/7/procedures?include=all'), s.calls.map(c => c.u).join(','));
});

test('buttons follow permission and status: cancel only for active; entered in error for all but final rows; the form needs orders:write', async () => {
  const s = server({ items: [F(), F({ id: 2, status: 'cancelled', cancelled_by: 'd', cancelled_at: 'x', cancel_reason: 'r' }), F({ id: 3, status: 'entered_in_error', error_by: 'd', error_at: 'x', error_reason: 'r' })] });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('prcLoad()');
  const d = w.document;
  assert.equal(d.querySelectorAll('[data-act=prcCancel]').length, 1); assert.equal(d.querySelectorAll('[data-act=prcError]').length, 2);
  assert.ok(d.getElementById('pc_n_name')); assert.equal(d.querySelector('[data-act=prcCancel]').dataset.arg, '1');
});

test('add sends only the typed fields (name, exact moment with offset, outcome if typed, the open case); nothing is sent without name and time, or with a future time; the server message is shown; the form clears on success', async () => {
  let status = 201;
  const s = server({ post: () => res(status, status === 201 ? {} : { error: 'invalid', message: 'Nope from server.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, 12); await w.eval('prcLoad()'); s.calls.length = 0;
  await w.eval('prcAdd()'); assert.deepEqual(s.calls, []); assert.match(box(w), /needs what was done and when/);
  fill(w, 'pc_n_name', 'Chest drain'); await w.eval('prcAdd()'); assert.deepEqual(s.calls, []);
  fill(w, 'pc_n_when', `${new Date().getFullYear() + 1}-01-01T10:00`); await w.eval('prcAdd()'); assert.deepEqual(s.calls, []); assert.match(box(w), /cannot be recorded as done in the future/);
  fill(w, 'pc_n_name', ' Lumbar puncture '); fill(w, 'pc_n_when', WHEN); await w.eval('prcAdd()');
  const post = s.calls.find(c => c.m === 'POST');
  assert.equal(post.u, '/api/patients/7/procedures');
  assert.deepEqual(post.b, { procedure: 'Lumbar puncture', performedAt: new Date(WHEN).toISOString(), originCaseId: 12 });
  assert.equal(w.document.getElementById('pc_n_name').value, '', 'form cleared');
  s.calls.length = 0; fill(w, 'pc_n_name', 'A'); fill(w, 'pc_n_when', WHEN); fill(w, 'pc_n_out', ' Clear fluid '); await w.eval('prcAdd()');
  assert.deepEqual(s.calls.find(c => c.m === 'POST').b, { procedure: 'A', performedAt: new Date(WHEN).toISOString(), outcome: 'Clear fluid', originCaseId: 12 });
  status = 400; fill(w, 'pc_n_name', 'A'); fill(w, 'pc_n_when', WHEN); await w.eval('prcAdd()'); assert.match(box(w), /Nope from server/);
  assert.ok(!/recorded_by|username/.test(JSON.stringify(s.calls.map(c => c.b))), 'no user field is ever sent');
});

test('cancel and entered in error need a reason, confirm, and send only reason and rowVersion; a stale answer shows the message and reloads', async () => {
  let status = 200;
  const s = server({ items: [F({ row_version: 4 })], post: () => res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('prcLoad()'); s.calls.length = 0;
  await w.eval("prcMove('cancel','1')"); assert.deepEqual(s.calls, []); assert.match(box(w), /A reason is required/);
  fill(w, 'pc_r1', ' Duplicate '); w.document.querySelector('[data-act=prcCancel]').click(); await sleep(); await sleep();   // delegated click through ACT
  assert.deepEqual(s.calls.find(c => c.m === 'POST'), { u: '/api/procedures/1/cancel', m: 'POST', b: { reason: 'Duplicate', rowVersion: 4 } });
  s.calls.length = 0; fill(w, 'pc_r1', 'Mistake'); await w.eval("prcMove('error','1')");
  assert.equal(s.calls.find(c => c.m === 'POST').u, '/api/procedures/1/entered-in-error');
  status = 409; s.calls.length = 0; fill(w, 'pc_r1', 'x'); await w.eval("prcMove('cancel','1')");
  assert.match(box(w), /Changed by someone else/); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
  s.calls.length = 0; await w.eval("prcMove('bogus','1')"); await w.eval("prcMove('cancel','1; DROP')"); await w.eval("prcMove('cancel','99')"); assert.deepEqual(s.calls, []);
});

test('typed drafts survive a re-render; a sign-out or another patient while a request is in flight is ignored', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = server({ items: [F()], post: async () => { await gate; return res(201, {}); } });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('prcLoad()');
  fill(w, 'pc_n_name', 'half'); fill(w, 'pc_r1', 'half reason'); w.eval('renderProcedures()');
  assert.equal(w.document.getElementById('pc_n_name').value, 'half'); assert.equal(w.document.getElementById('pc_r1').value, 'half reason');
  fill(w, 'pc_n_name', 'A'); fill(w, 'pc_n_when', WHEN); s.calls.length = 0;
  const p = w.eval('prcAdd()'); w.eval('Srv.user = null'); release(); await p; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after sign-out');
  as(w, 'doc', RW); w.eval('CASE.patientId = 8'); fill(w, 'pc_n_when', WHEN); s.calls.length = 0;
  const p2 = w.eval('prcAdd()'); w.eval('CASE.patientId = 9'); await p2; await sleep();
  assert.deepEqual(s.calls.map(c => c.m), ['POST'], 'no reload after another patient was opened');
});
