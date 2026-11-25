'use strict';
// R1c: adaptive history (display logic only). Runs the real page in jsdom (no network, no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { pageHtml, localScripts } = require('./html');
const HTML = pageHtml();
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '54-adaptive.js'), 'utf8');

function page() {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.fetch = async () => new Response('{}', { status: 401 }); w.confirm = () => true; } });
  const w = dom.window;
  return { w, d: w.document, errors, ev: code => { const r = w.eval(code); return r === undefined ? r : JSON.parse(JSON.stringify(r)); },
    shown: fid => !!dom.window.document.getElementById('f_' + fid),
    pick: (fid, v) => { const el = dom.window.document.getElementById('f_' + fid); el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); } };
}
const KNOWN = 'Known (describe in the details field)';

test('R1c: every rule points at real fields of ONE built-in set; the parent is a select or yes/no; the answers are real options', () => {
  const p = page(); assert.deepEqual(p.errors, []);
  const rules = p.ev('ADAPT_RULES'), sets = p.ev('BUILTIN');
  assert.ok(rules.length >= 3);
  for (const r of rules) {
    const s = sets.find(x => x.fields.some(f => f.id === r.child));
    assert.ok(s, r.child + ' exists');
    const par = s.fields.find(f => f.id === r.parent);
    assert.ok(par, r.parent + ' is in the same set as ' + r.child);
    assert.ok(['select', 'boolean'].includes(par.type), r.parent);
    for (const a of r.when) assert.ok(par.type === 'boolean' ? ['Yes', 'No'].includes(a) : par.options.includes(a), `${r.parent}: ${a}`);
    assert.notEqual(r.child, r.parent);
  }
  assert.equal(new Set(rules.map(r => r.child)).size, rules.length, 'one rule per follow-up');
});

test('R1c: no complaint-set question is ever gated (neither as a follow-up nor as a parent)', () => {
  const p = page();
  const cc = new Set(p.ev('COMPLAINT_SETS.flatMap(s=>s.fields.map(f=>f.id))'));
  for (const r of p.ev('ADAPT_RULES')) { assert.ok(!cc.has(r.child), r.child); assert.ok(!cc.has(r.parent), r.parent); }
});

test('R1c: the referral question is held back until the disposition is Referred, then shown, then held back again if empty', () => {
  const p = page();
  p.w.applySet('pw_opd');
  assert.equal(p.shown('opd_dispo'), true); assert.equal(p.shown('opd_referral'), false);
  assert.match(p.d.getElementById('forms').textContent, /2 follow-up questions are hidden/);
  p.pick('opd_dispo', 'Referred');
  assert.equal(p.shown('opd_referral'), true);
  p.pick('opd_dispo', 'Home with advice');
  assert.equal(p.shown('opd_referral'), false);
});

test('R1c: allergy details follow the allergy answer in the OPD note and the IPD admission note', () => {
  const p = page();
  p.w.applySet('pw_opd'); p.w.applySet('pw_ipd');
  assert.equal(p.shown('opd_allergy_detail'), false); assert.equal(p.shown('adm_allergy_detail'), false);
  p.pick('opd_allergy', KNOWN); assert.equal(p.shown('opd_allergy_detail'), true); assert.equal(p.shown('adm_allergy_detail'), false);
  p.pick('adm_allergy', KNOWN); assert.equal(p.shown('adm_allergy_detail'), true);
  p.pick('opd_allergy', 'None known'); assert.equal(p.shown('opd_allergy_detail'), false);
});

test('R1c: a follow-up that already holds a recorded value stays visible even when the parent answer changes', () => {
  const p = page();
  p.w.applySet('pw_opd');
  p.pick('opd_dispo', 'Referred'); p.pick('opd_referral', 'Cardiology clinic');
  p.pick('opd_dispo', 'Home with advice');
  assert.equal(p.shown('opd_referral'), true, 'recorded text is never hidden');
  assert.equal(p.d.getElementById('f_opd_referral').value, 'Cardiology clinic');
});

test('R1c: "Show all questions" shows every follow-up and can be switched off again; the note only appears on a card that hides something', () => {
  const p = page();
  p.w.applySet('pw_opd');
  const box = () => p.d.querySelector('input[data-act="adaptAll"]');
  assert.ok(box());
  box().checked = true; box().dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.equal(p.shown('opd_referral'), true); assert.equal(p.shown('opd_allergy_detail'), true);
  assert.match(p.d.getElementById('forms').textContent, /Show all questions/);
  assert.equal(box().checked, true);
  box().checked = false; box().dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.equal(p.shown('opd_referral'), false);
  const q = page(); q.w.applySet('cc_fever');
  assert.equal(q.d.querySelector('input[data-act="adaptAll"]'), null, 'a card with nothing hidden has no note');
});

test('R1c: signed-in answers are read by their per-set key, an explicit Unknown or an entered-in-error row keeps the question visible, and a foreign parent is ignored', () => {
  const p = page();
  const set = `{fields:[{id:'opd_dispo'},{id:'opd_referral'}]}`;
  const a = `{srvAs:9,srvSet:5,setId:'opd_visit'}`;
  p.w.eval(`CASE.values={'5:opd_dispo':'Referred'};CASE.vunk={};CASE.vbad={}`);
  assert.equal(p.ev(`adaptHidden(${set},{id:'opd_referral'},${a})`), false, 'parent answer read by key set:field');
  p.w.eval(`CASE.values={'5:opd_dispo':'Home with advice'}`);
  assert.equal(p.ev(`adaptHidden(${set},{id:'opd_referral'},${a})`), true);
  p.w.eval(`CASE.vunk={'5:opd_referral':true}`);
  assert.equal(p.ev(`adaptHidden(${set},{id:'opd_referral'},${a})`), false, 'explicit Unknown stays visible');
  p.w.eval(`CASE.vunk={};CASE.vbad={'5:opd_referral':[{id:1}]}`);
  assert.equal(p.ev(`adaptHidden(${set},{id:'opd_referral'},${a})`), false, 'an entered-in-error row stays visible');
  p.w.eval(`CASE.vbad={}`);
  assert.equal(p.ev(`adaptHidden({fields:[{id:'opd_referral'}]},{id:'opd_referral'},${a})`), false, 'parent not in the set: ignored');
});

test('R1c: the module loads after 52-complaints and before the inline script; it adds no inline handler, no storage and no network call', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/54-adaptive.js'), l.indexOf('modules/52-complaints.js') + 1, l.join(', '));
  assert.ok(!/onclick=|onchange=|oninput=/.test(mod));
  assert.ok(!/localStorage|sessionStorage|fetch\(|api\(/.test(mod));
});
