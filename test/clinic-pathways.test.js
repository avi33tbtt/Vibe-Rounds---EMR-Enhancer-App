'use strict';
// OPD and IPD pathways: one click to start a consult. Runs the real page in jsdom (no network, no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { lint } = require('../lint');
const HTML = require('./html').pageHtml();

function page() {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.fetch = async () => new Response('{}', { status: 401 }); w.confirm = () => true; } });
  const w = dom.window;
  return { w, d: w.document, errors, ev: code => { const r = w.eval(code); return r === undefined ? r : JSON.parse(JSON.stringify(r)); } };
}
const NEW_SETS = ['opd_visit', 'ipd_admission', 'ipd_progress', 'ipd_discharge'];
const PATHS = { pw_opd: ['opd_visit', 'vitals'], pw_ipd: ['ipd_admission', 'vitals', 'ipd_progress'], pw_ipd_discharge: ['ipd_discharge'] };

test('the OPD and IPD sets and pathways exist, every member exists, and the sets pass the shared lint (no codes, doses or rules)', () => {
  const p = page(); assert.deepEqual(p.errors, []);
  const ids = p.ev('BUILTIN.map(s=>s.id)');
  for (const id of NEW_SETS) assert.ok(ids.includes(id), id);
  for (const [id, members] of Object.entries(PATHS)) {
    assert.deepEqual(p.ev(`PATHWAYS.find(x=>x.id==="${id}").members`), members, id);
    for (const m of members) assert.ok(ids.includes(m), `${id} member ${m}`);
  }
  for (const id of NEW_SETS) {
    const s = p.ev(`BUILTIN.find(x=>x.id==="${id}")`);
    const r = lint(s, { scrub: false, bindingState: () => 'verified' });
    assert.equal(r.ok, true, id + ': ' + JSON.stringify(r.findings));
    assert.equal(r.needsTwoReviewers, false, id + ' carries no dose or rule');
    assert.ok(s.fields.every(f => !('coding' in f) && !('bindings' in f)), id + ' carries no codes');
  }
});

test('field ids of the new sets are unique across every built-in set, so applied sets never clash', () => {
  const p = page();
  const seen = new Map(), clash = [];
  for (const s of p.ev('BUILTIN')) for (const f of s.fields) { if (seen.has(f.id)) clash.push(`${f.id}: ${seen.get(f.id)} and ${s.id}`); seen.set(f.id, s.id); }
  assert.deepEqual(clash, []);
});

test('an empty case offers Start buttons for OPD and IPD; clicking one applies the whole pathway', () => {
  const p = page();
  const empty = p.d.getElementById('formEmpty');
  const btns = [...empty.querySelectorAll('button[data-act="applySet"]')];
  assert.deepEqual(btns.map(b => b.dataset.arg), ['pw_opd', 'pw_ipd']);
  assert.equal(empty.querySelector('[onclick]'), null, 'no inline handler (CSP)');
  btns[0].click();
  assert.deepEqual(p.ev('CASE.applied.map(a=>a.setId)'), ['opd_visit', 'vitals']);
  assert.ok(p.ev('CASE.applied.every(a=>a.fromPathway==="pw_opd")'));
  assert.equal(p.d.getElementById('formEmpty').style.display, 'none');
  assert.match(p.d.getElementById('forms').textContent, /Presenting complaint/);
});

test('IPD admission adds admission, vitals and progress notes; discharge is added later and the case keeps all of it', () => {
  const p = page();
  p.w.applySet('pw_ipd');
  assert.deepEqual(p.ev('CASE.applied.map(a=>a.setId)'), PATHS.pw_ipd);
  p.w.applySet('pw_ipd_discharge');
  assert.deepEqual(p.ev('CASE.applied.map(a=>a.setId)'), [...PATHS.pw_ipd, 'ipd_discharge']);
  const text = p.d.getElementById('forms').textContent;
  for (const t of ['Reason for admission', 'Subjective: how the patient is', 'Summary of hospital course']) assert.ok(text.includes(t), t);
});

test('"Suggest" on an empty case lists OPD and IPD first', () => {
  const p = page();
  let shown = '';
  p.w.prompt = m => { shown = m; return null; };
  p.w.suggest();
  const lines = shown.split('\n').filter(l => /^\d\./.test(l));
  assert.match(lines[0], /OPD consultation/); assert.match(lines[1], /IPD admission/);
});
