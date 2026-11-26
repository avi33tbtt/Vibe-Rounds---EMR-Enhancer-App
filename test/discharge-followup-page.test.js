'use strict';
// Row R5g: discharge (modules/89-admissions.js) and follow-up after discharge (modules/89-followups.js) on the Orders tab. Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const fup = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-followups.js'), 'utf8');
const adm = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-admissions.js'), 'utf8');
const wire = fs.readFileSync(path.join(__dirname, '..', 'modules', '90-wire.js'), 'utf8');
const NAMES = ['fupLoad', 'renderFollowups', 'fupAdd', 'fupMove'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withCase = (w, patientId, serverId) => w.eval(`CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}`);
const fill = (w, id, v) => { w.document.getElementById(id).value = v; };
const sleep = () => new Promise(r => setTimeout(r, 20));
const RO = ['orders:read'], RW = ['orders:read', 'orders:write'];
const A = (o = {}) => ({ id: 1, patient_id: 7, origin_case_id: null, ward_text: 'Ward 3', reason_text: 'Fever', admitted_at: '2026-11-20T03:45:00Z', status: 'active', row_version: 4,
  recorded_by: 'doc', recorded_at: '2026-11-20T04:00:00Z', cancelled_by: null, cancelled_at: null, cancel_reason: null, error_by: null, error_at: null, error_reason: null,
  discharged_at: null, discharge_summary: null, discharge_condition: null, discharged_by: null, discharge_recorded_at: null, ...o });
const DISCHARGED = (o = {}) => A({ id: 2, status: 'discharged', discharged_at: '2026-11-24T08:00:00Z', discharge_summary: 'Recovered well', discharge_condition: 'Stable', discharged_by: 'doc', discharge_recorded_at: '2026-11-24T08:05:00Z', ...o });
const FU = (o = {}) => ({ id: 5, patient_id: 7, admission_id: 2, instruction_text: 'Review in clinic', where_text: 'OPD 4', follow_up_on: '2026-12-01', status: 'active', row_version: 3,
  recorded_by: 'doc', recorded_at: '2026-11-24T09:00:00Z', cancelled_by: null, cancelled_at: null, cancel_reason: null, error_by: null, error_at: null, error_reason: null, ...o });
const WHEN = '2026-11-24T10:30';
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { if (u === '/api/me') return res(401, {});   // boot probe: signed out, not counted
    calls.push({ u, m: opt && opt.method, b: opt && opt.body && JSON.parse(opt.body) });
    if (opt && opt.method === 'POST') return o.post ? o.post(u) : res(u.endsWith('/discharge') ? 200 : 201, {});
    if (u.includes('/followups')) return res(200, { followups: o.fups || [] });
    return res(200, { admissions: o.adms || [] }); };
  return { calls, f };
}
const abox = w => w.document.getElementById('admBox').innerHTML, fbox = w => w.document.getElementById('fupBox').innerHTML;
const posts = s => s.calls.filter(c => c.m === 'POST');

test('89-followups.js loads right after 89-mar.js, before 90-wire.js; nothing of it is inline; no inline handlers or storage; its box follows the MAR box in the Orders pane; the tab loads it; every action is wired', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/89-followups.js'), l.indexOf('modules/89-mar.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/89-followups.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(fup), 'missing: ' + n); }
  assert.ok(/function admDischarge\(/.test(adm) && !/function admDischarge\(/.test(inline));
  for (const m of [fup, adm]) { assert.ok(!/\son(click|change|input)=/i.test(m), 'no inline handlers'); assert.ok(!/localStorage|sessionStorage/.test(m), 'no browser storage'); }
  assert.match(raw, /<div class="pane" id="orders">[\s\S]*id="marBox"[\s\S]*id="fupBox"[\s\S]*<!-- MEDICATION HISTORY/);
  assert.match(raw, /marLoad\(\);fupLoad\(\)/, 'the Orders tab loads the follow-ups');
  for (const a of ['admDischarge', 'fupReload', 'fupAll', 'fupAdd', 'fupCancel', 'fupError']) assert.ok(new RegExp(`\\b${a}:`).test(wire), 'ACT entry: ' + a);
  for (const a of new Set([...fup.matchAll(/data-act="(\w+)"/g)].map(m => m[1]))) assert.ok(new RegExp(`\\b${a}:`).test(wire), 'unwired: ' + a);
});

test('discharge form: only for an active admission and orders:write; a discharged row shows time in UTC, summary, condition and who, escaped; the entered-in-error button stays', async () => {
  const s = server({ adms: [A(), DISCHARGED({ discharge_summary: '<img src=x onerror=alert(1)>', discharge_condition: '<b>ok</b>' })] });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('admLoad()');
  const h = abox(w), d = w.document;
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>ok'), 'escaped'); assert.match(h, /&lt;img/);
  for (const x of ['>discharged<', 'Discharged 2026-11-24 08:00 UTC', 'recorded by doc', 'Summary: ', 'Condition: ']) assert.ok(h.includes(x), x);
  assert.equal(d.querySelectorAll('[data-act=admDischarge]').length, 1, 'one active admission, one discharge form');
  assert.equal(d.querySelector('[data-act=admDischarge]').dataset.arg, '1');
  assert.ok(d.getElementById('ad_d_when1') && d.getElementById('ad_d_sum1') && d.getElementById('ad_d_cond1'));
  assert.equal(d.querySelectorAll('[data-act=admError]').length, 2);
  const w2 = await page(s.f); as(w2, 'v', RO); withCase(w2, 7, null); await w2.eval('admLoad()');
  assert.equal(w2.document.querySelectorAll('[data-act=admDischarge],#ad_d_sum1').length, 0, 'read-only role: no discharge form');
  assert.match(abox(w2), /Discharged 2026-11-24 08:00 UTC/, 'but the discharge is visible');
});

test('discharge sends only time (exact moment), summary, optional condition and the loaded rowVersion; nothing is sent when time or summary is missing, in the future or before the admission', async () => {
  const s = server({ adms: [A()] });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('admLoad()'); s.calls.length = 0;
  await w.eval("admDischarge('1')"); assert.deepEqual(s.calls, []); assert.match(abox(w), /needs the time and a summary/);
  fill(w, 'ad_d_sum1', 'Fine'); fill(w, 'ad_d_when1', `${new Date().getFullYear() + 1}-01-01T10:00`); await w.eval("admDischarge('1')");
  assert.deepEqual(s.calls, []); assert.match(abox(w), /cannot be recorded as happening in the future/);
  fill(w, 'ad_d_when1', '2026-11-19T09:00'); await w.eval("admDischarge('1')");
  assert.deepEqual(s.calls, []); assert.match(abox(w), /cannot be before the admission/);
  fill(w, 'ad_d_when1', WHEN); fill(w, 'ad_d_sum1', ' Recovered '); await w.eval("admDischarge('1')");
  assert.deepEqual(posts(s)[0], { u: '/api/admissions/1/discharge', m: 'POST', b: { dischargedAt: new Date(WHEN).toISOString(), summary: 'Recovered', rowVersion: 4 } }, 'no condition key when blank');
  fill(w, 'ad_d_cond1', ' Stable '); await w.eval("admDischarge('1')");
  assert.equal(posts(s)[1].b.condition, 'Stable');
  assert.ok(!/discharged_by|username|recorded_by/.test(JSON.stringify(posts(s).map(c => c.b))), 'no user field is ever sent');
  await sleep(); await sleep();   // the follow-up reload after a successful discharge settles first
  s.calls.length = 0; await w.eval("admDischarge('1; DROP')"); await w.eval("admDischarge('99')"); assert.deepEqual(s.calls, []);
});

test('a refused or stale discharge shows the server message; a 409 reloads; a successful one reloads the admissions and the follow-ups', async () => {
  let status = 409;
  const s = server({ adms: [A()], post: () => res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('admLoad()');
  fill(w, 'ad_d_sum1', 'x'); fill(w, 'ad_d_when1', WHEN); s.calls.length = 0; await w.eval("admDischarge('1')");
  assert.match(abox(w), /Changed by someone else/); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
  status = 200; fill(w, 'ad_d_sum1', 'x'); fill(w, 'ad_d_when1', WHEN); s.calls.length = 0; await w.eval("admDischarge('1')"); await sleep(); await sleep();
  assert.ok(s.calls.some(c => c.u === '/api/patients/7/admissions'), 'admissions reloaded'); assert.ok(s.calls.some(c => c.u === '/api/patients/7/followups'), 'follow-ups reloaded');
});

test('without orders:read or a patient no request is made and the box is empty; signing out clears the list', async () => {
  const s = server({ fups: [FU()], adms: [DISCHARGED()] }), w = await page(s.f);
  as(w, 'v', ['cases:read']); await w.eval('fupLoad()'); assert.deepEqual(s.calls, []); assert.equal(fbox(w), '');
  as(w, 'v', RO); withCase(w, null, null); await w.eval('fupLoad()'); assert.deepEqual(s.calls, []);
  withCase(w, 7, null); await w.eval('fupLoad()'); assert.deepEqual(s.calls.map(c => c.u), ['/api/patients/7/followups', '/api/patients/7/admissions']);
  assert.equal(w.eval('FUP.items.length'), 1);
  w.eval('Srv.user = null; renderFollowups()'); assert.equal(w.eval('FUP.items.length'), 0); assert.equal(fbox(w), '');
});

test('follow-ups are shown escaped with status, day, place, admission and who and when; a read-only role has no form or buttons; "show entered in error" asks for include=all', async () => {
  const s = server({ adms: [DISCHARGED()], fups: [FU({ instruction_text: '<img src=x onerror=alert(1)>', where_text: '<b>x</b>' }), FU({ id: 6, status: 'cancelled', cancelled_by: 'doc', cancelled_at: 'x', cancel_reason: 'r1', follow_up_on: null, where_text: null }),
    FU({ id: 7, status: 'entered_in_error', error_by: 'doc', error_at: 'x', error_reason: 'r2' })] });
  const w = await page(s.f); as(w, 'v', RO); withCase(w, 7, null); await w.eval('fupLoad()');
  const h = fbox(w);
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>x</b>'), 'escaped'); assert.match(h, /&lt;img/);
  for (const x of ['>active<', '>cancelled<', '>entered in error<', 'Planned day 2026-12-01', 'No day set', 'After Ward 3 (discharged 2026-11-24)', 'Recorded by doc', 'Cancelled by doc', 'Marked in error by doc', 'Final:', 'Your role cannot change follow-ups']) assert.ok(h.includes(x), x);
  assert.equal(w.document.getElementById('fupBox').querySelectorAll('[data-act=fupAdd],[data-act=fupCancel],[data-act=fupError],textarea,input[id^=fu_n]').length, 0);
  w.eval('FUP.all = true'); s.calls.length = 0; await w.eval('fupLoad()');
  assert.ok(s.calls.some(c => c.u === '/api/patients/7/followups?include=all'), s.calls.map(c => c.u).join(','));
});

test('the add form needs orders:write and a discharged admission; only discharged admissions are offered; buttons follow status', async () => {
  const s = server({ adms: [A(), DISCHARGED(), A({ id: 3, status: 'cancelled' })], fups: [FU(), FU({ id: 6, status: 'cancelled', cancelled_by: 'd', cancelled_at: 'x', cancel_reason: 'r' }), FU({ id: 7, status: 'entered_in_error', error_by: 'd', error_at: 'x', error_reason: 'r' })] });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('fupLoad()');
  const d = w.document, opts = [...d.querySelectorAll('#fu_n_adm option')];
  assert.deepEqual(opts.map(o => o.value), ['2']); assert.ok(d.getElementById('fu_n_instr'));
  assert.equal(d.querySelectorAll('[data-act=fupCancel]').length, 1); assert.equal(d.querySelectorAll('[data-act=fupError]').length, 2);
  const s2 = server({ adms: [A()] }), w2 = await page(s2.f); as(w2, 'doc', RW); withCase(w2, 7, null); await w2.eval('fupLoad()');
  assert.equal(w2.document.getElementById('fu_n_adm'), null); assert.match(fbox(w2), /no discharged admission/);
});

test('add sends only the typed fields to the chosen admission; nothing is sent without an instruction; the server message is shown; the form clears on success; a 409 reloads', async () => {
  let status = 201;
  const s = server({ adms: [DISCHARGED()], post: () => res(status, status === 201 ? {} : { error: status === 409 ? 'not_discharged' : 'invalid', message: 'Nope from server.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('fupLoad()'); s.calls.length = 0;
  await w.eval('fupAdd()'); assert.deepEqual(s.calls, []); assert.match(fbox(w), /needs a discharged admission and an instruction/);
  fill(w, 'fu_n_instr', ' Review in clinic '); await w.eval('fupAdd()');
  assert.deepEqual(posts(s)[0], { u: '/api/admissions/2/followups', m: 'POST', b: { instruction: 'Review in clinic' } }, 'blank place and day are not sent');
  assert.equal(w.document.getElementById('fu_n_instr').value, '', 'form cleared');
  fill(w, 'fu_n_instr', 'Wound check'); fill(w, 'fu_n_where', ' OPD 4 '); fill(w, 'fu_n_on', '2026-12-01'); await w.eval('fupAdd()');
  assert.deepEqual(posts(s)[1].b, { instruction: 'Wound check', where: 'OPD 4', followUpOn: '2026-12-01' });
  status = 400; fill(w, 'fu_n_instr', 'A'); await w.eval('fupAdd()'); assert.match(fbox(w), /Nope from server/);
  status = 409; s.calls.length = 0; fill(w, 'fu_n_instr', 'A'); await w.eval('fupAdd()'); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
  assert.ok(!/recorded_by|username/.test(JSON.stringify(posts(s).map(c => c.b))), 'no user field is ever sent');
});

test('cancel and entered in error need a reason, confirm, and send only reason and rowVersion; a stale answer shows the message and reloads', async () => {
  let status = 200;
  const s = server({ adms: [DISCHARGED()], fups: [FU({ row_version: 6 })], post: () => res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) });
  const w = await page(s.f); as(w, 'doc', RW); withCase(w, 7, null); await w.eval('fupLoad()'); s.calls.length = 0;
  await w.eval("fupMove('cancel','5')"); assert.deepEqual(s.calls, []); assert.match(fbox(w), /A reason is required/);
  fill(w, 'fu_r5', ' Patient declined '); w.document.querySelector('[data-act=fupCancel]').click(); await sleep(); await sleep();   // delegated click through ACT
  assert.deepEqual(posts(s)[0], { u: '/api/followups/5/cancel', m: 'POST', b: { reason: 'Patient declined', rowVersion: 6 } });
  s.calls.length = 0; fill(w, 'fu_r5', 'Mistake'); await w.eval("fupMove('error','5')");
  assert.equal(posts(s)[0].u, '/api/followups/5/entered-in-error');
  status = 409; s.calls.length = 0; fill(w, 'fu_r5', 'x'); await w.eval("fupMove('cancel','5')");
  assert.match(fbox(w), /Changed by someone else/); assert.ok(s.calls.some(c => c.m !== 'POST'), 'reloaded');
  s.calls.length = 0; await w.eval("fupMove('bogus','5')"); await w.eval("fupMove('cancel','5; DROP')"); await w.eval("fupMove('cancel','99')"); assert.deepEqual(s.calls, []);
});
