'use strict';
// R1f: quick and detailed mode (display only). Runs the real page in jsdom (no network, no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { pageHtml, localScripts } = require('./html');
const HTML = pageHtml();

function page() {
  const errors = [], calls = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.fetch = async (u) => { calls.push(String(u)); return new Response('{}', { status: 401 }); }; w.confirm = () => true; } });
  const w = dom.window;
  return { w, d: w.document, errors, calls, ev: code => { const r = w.eval(code); return r === undefined ? r : JSON.parse(JSON.stringify(r)); } };
}
const labels = p => [...p.d.querySelectorAll('#forms label')].map(l => l.textContent);
const has = (p, text) => labels(p).some(t => t.includes(text));
const HIDDEN9 = ['Onset and duration', 'Past medical and surgical history', 'Family and social history', 'Review of systems', 'General examination',
  'Systemic examination', 'Results and reports reviewed today', 'Differential diagnosis', 'Investigations ordered'];
const SHOWN11 = ['Visit type', 'Presenting complaint(s)', 'History of present illness', 'Current medicines', 'Allergies', 'Impression / working diagnosis',
  'Treatment and prescriptions', 'Advice and counselling given', 'Warning signs explained', 'Disposition', 'Follow-up (when and with whom)'];
const pressed = (p, id) => p.d.getElementById(id).getAttribute('aria-pressed');

test('every QUICK_FIELDS entry names a built-in set and real fields of it; opd_visit keeps 13 of its 22', () => {
  const p = page(); assert.deepEqual(p.errors, []);
  const q = p.ev('QUICK_FIELDS');
  assert.deepEqual(Object.keys(q), ['opd_visit']);
  for (const [sid, ids] of Object.entries(q)) {
    const s = p.ev(`BUILTIN.find(b=>b.id==="${sid}")`); assert.ok(s, sid);
    const have = s.fields.map(f => f.id);
    for (const id of ids) assert.ok(have.includes(id), `${sid}.${id} is a real field`);
    assert.equal(new Set(ids).size, ids.length, 'no repeated id');
  }
  assert.equal(q.opd_visit.length, 13); assert.equal(p.ev('BUILTIN.find(b=>b.id==="opd_visit").fields.length'), 22);
});

test('the default is Detailed: nothing is hidden until someone clicks Quick', () => {
  const p = page(); p.w.applySet('opd_visit');
  assert.equal(p.ev('MODE.quick'), false);
  assert.equal(pressed(p, 'modeDetailed'), 'true'); assert.equal(pressed(p, 'modeQuick'), 'false');
  for (const t of HIDDEN9) assert.ok(has(p, t), t);
  assert.doesNotMatch(p.d.getElementById('forms').textContent, /Quick view/);
});

test('Quick leaves off 9 questions of the OPD visit and says so; the R1c held-back follow-ups stay held; Detailed brings all back', () => {
  const p = page(); p.w.applySet('opd_visit');
  p.d.getElementById('modeQuick').click();
  assert.equal(p.ev('MODE.quick'), true);
  assert.equal(pressed(p, 'modeQuick'), 'true'); assert.equal(pressed(p, 'modeDetailed'), 'false');
  for (const t of HIDDEN9) assert.equal(has(p, t), false, t + ' is left off');
  for (const t of SHOWN11) assert.ok(has(p, t), t + ' stays');
  assert.match(p.d.getElementById('forms').textContent, /Quick view: 9 more questions are not shown/);
  assert.equal(has(p, 'Allergy details'), false, 'R1c still holds the follow-up until its parent answer asks for it');
  assert.equal(has(p, 'Referral (to whom and why)'), false);
  p.d.querySelector('#forms [data-act="setMode"][data-arg="detailed"]').click();
  assert.equal(p.ev('MODE.quick'), false);
  for (const t of HIDDEN9) assert.ok(has(p, t), t + ' is back');
});

test('R1c still works on top: in Quick, the allergy detail question appears once the parent answer asks for it', () => {
  const p = page(); p.w.applySet('opd_visit'); p.d.getElementById('modeQuick').click();
  p.w.setVal('opd_allergy', 'Known (describe in the details field)');
  assert.ok(has(p, 'Allergy details'));
});

test('a recorded value, an explicit Unknown and an entered-in-error row are never hidden in Quick', () => {
  const p = page(); p.w.applySet('opd_visit');
  p.w.setVal('opd_ros', 'cough for a week');
  p.w.eval('CASE.vunk=CASE.vunk||{};CASE.vunk["opd_pmh"]=true;CASE.vbad=CASE.vbad||{};CASE.vbad["opd_fsh"]=[{id:1,value:"x",errorReason:"wrong"}]');
  p.d.getElementById('modeQuick').click();
  assert.ok(has(p, 'Review of systems'), 'recorded value stays');
  assert.ok(has(p, 'Past medical and surgical history'), 'Unknown stays');
  assert.ok(has(p, 'Family and social history'), 'entered-in-error row stays');
  for (const t of ['Onset and duration', 'General examination', 'Differential diagnosis']) assert.equal(has(p, t), false, t);
  assert.match(p.d.getElementById('forms').textContent, /Quick view: 6 more questions are not shown/);
});

test('a repeating field with any row is never hidden in Quick (rows live in an array, not a plain value)', () => {
  const p = page();
  p.w.eval('QUICK_FIELDS.vitals=["hr"]');   // a temporary entry so a repeating set can be tested
  p.w.applySet('vitals'); p.w.addRow('bp_sys', '120');
  p.d.getElementById('modeQuick').click();
  assert.ok(has(p, 'Heart rate'), 'listed');
  assert.ok(has(p, 'Systolic BP'), 'has a row, so it stays');
  assert.equal(has(p, 'Temperature'), false, 'no row and not listed: left off');
  p.w.addRow('temp', '37');
  assert.ok(has(p, 'Temperature'), 'a new row makes it visible at once');
});

test('a set with no entry is untouched in Quick (the IPD sets keep every question, including the safety checklist)', () => {
  const p = page(); p.d.getElementById('modeQuick').click();
  for (const id of ['ipd_admission', 'ipd_progress', 'ipd_discharge', 'cc_fever', 'ex_general', 'ap_block']) p.w.applySet(id);
  for (const id of ['ipd_admission', 'ipd_discharge', 'cc_fever', 'ex_general', 'ap_block']) {
    const s = p.ev(`BUILTIN.find(b=>b.id==="${id}")`);
    for (const f of s.fields) {
      if (p.ev(`!!adaptRule("${f.id}")`)) continue;   // held back by R1c's own rule, not by Quick mode
      assert.ok(has(p, f.label.slice(0, 30)), id + ': ' + f.label);
    }
  }
  for (const t of ['Clot-prevention', 'Fall risk', 'Consent for admission', 'Escalation and resuscitation']) assert.ok(has(p, t), t);
  assert.doesNotMatch(p.d.getElementById('forms').textContent, /Quick view/);
});

test('an entry that names no real field of the set is ignored', () => {
  const p = page();
  p.w.eval('QUICK_FIELDS.basic_emr=["nope"]'); p.w.applySet('basic_emr'); p.d.getElementById('modeQuick').click();
  assert.ok(has(p, 'Past medical history') && has(p, 'Examination findings'));
});

test('the switch has no inline handler, uses the delegated action, and changing mode makes no request and writes nothing to storage', () => {
  const p = page(); p.w.applySet('opd_visit');
  assert.equal(p.d.getElementById('modeBar').querySelector('[onclick],[onchange],[oninput]'), null, 'no inline handler (CSP)');
  assert.deepEqual([...p.d.querySelectorAll('#modeBar button')].map(b => b.dataset.act), ['setMode', 'setMode']);
  const keys = () => JSON.stringify(Object.keys(p.w.localStorage).sort()) + JSON.stringify(Object.keys(p.w.sessionStorage).sort());
  const before = keys(), n = p.calls.length;
  p.d.getElementById('modeQuick').click(); p.d.getElementById('modeDetailed').click(); p.d.getElementById('modeQuick').click();
  assert.equal(p.calls.length, n, 'no request');
  assert.equal(keys(), before, 'no storage key written');
  assert.doesNotMatch(p.w.eval('(0,Object.values)(localStorage).join("|")'), /quick/i);
});

test('the module loads right after 58-assessment and before 60-library', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/59-mode.js'), l.indexOf('modules/58-assessment.js') + 1);
  assert.equal(l.indexOf('modules/60-library.js'), l.indexOf('modules/59-mode.js') + 1);
});
