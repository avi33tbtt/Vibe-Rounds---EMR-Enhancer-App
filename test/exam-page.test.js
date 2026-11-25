'use strict';
// R1d: structured examination sets and the examination picker. Runs the real page in jsdom (no network, no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const Ajv2020 = require('ajv/dist/2020');
const { lint } = require('../lint');
const { buildEnvelope } = require('../envelope');
const { pageHtml, localScripts } = require('./html');
const HTML = pageHtml();

function page() {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.fetch = async () => new Response('{}', { status: 401 }); w.confirm = () => true; } });
  const w = dom.window;
  return { w, d: w.document, errors, ev: code => { const r = w.eval(code); return r === undefined ? r : JSON.parse(JSON.stringify(r)); } };
}
const IDS = ['ex_general', 'ex_cvs', 'ex_resp', 'ex_abdomen', 'ex_neuro'];
const PREFIX = { ex_general: 'exg_', ex_cvs: 'exc_', ex_resp: 'exr_', ex_abdomen: 'exa_', ex_neuro: 'exn_' };
const ANS = ['Not examined', 'Nothing abnormal found', 'Abnormal finding'];
const buttons = p => [...p.d.querySelectorAll('#exList button')];

test('five examination sets exist as built-ins; each passes the shared lint with no codes, doses or numbers, and needs no second reviewer', () => {
  const p = page(); assert.deepEqual(p.errors, []);
  assert.deepEqual(p.ev('EXAM_SETS.map(s=>s.id)'), IDS);
  for (const id of IDS) {
    const s = p.ev(`BUILTIN.find(x=>x.id==="${id}")`);
    assert.ok(s, id + ' is a built-in');
    const r = lint(s, { scrub: false, bindingState: () => 'verified' });
    assert.equal(r.ok, true, id + ': ' + JSON.stringify(r.findings));
    assert.equal(r.needsTwoReviewers, false, id);
    assert.ok(s.fields.every(f => !('coding' in f) && !('bindings' in f) && !('unit' in f)), id + ' carries no codes or units');
    assert.ok(s.fields.every(f => !/\d/.test(f.label + (f.options || []).join(' '))), id + ' has no numbers (no thresholds)');
  }
});

test('every finding is a select with the same three answers in order; each set ends with one text field; ids carry the set prefix', () => {
  const p = page();
  for (const id of IDS) {
    const s = p.ev(`BUILTIN.find(x=>x.id==="${id}")`), x = PREFIX[id];
    const findings = s.fields.slice(0, -1), last = s.fields[s.fields.length - 1];
    assert.ok(findings.length >= 5, id);
    for (const f of findings) { assert.equal(f.type, 'select', f.id); assert.deepEqual(f.options, ANS, f.id); }
    assert.equal(last.type, 'text'); assert.equal(last.id, x + 'details');
    assert.ok(s.fields.every(f => f.id.startsWith(x)), id);
    assert.equal(s.fields.filter(f => f.type === 'text').length, 1, id);
  }
});

test('field ids of the examination sets are unique across every built-in set, so applied sets never clash', () => {
  const p = page();
  const seen = new Map(), clash = [];
  for (const s of p.ev('BUILTIN')) for (const f of s.fields) { if (seen.has(f.id)) clash.push(`${f.id}: ${seen.get(f.id)} and ${s.id}`); seen.set(f.id, s.id); }
  assert.deepEqual(clash, []);
});

test('the examination sets are offered in the demo import, and the module loads right after 54-adaptive', () => {
  const p = page();
  const imp = p.ev('DEMO_IMPORT');
  for (const id of IDS) assert.ok(imp.includes(id), id);
  assert.ok(imp.every(id => p.ev(`BUILTIN.some(b=>b.id==="${id}")`)), 'every demo-import id is a built-in');
  const l = localScripts();
  assert.equal(l.indexOf('modules/56-exam.js'), l.indexOf('modules/54-adaptive.js') + 1);
});

test('the picker lists five buttons with no inline handler; a click applies the set and the button shows it as added', () => {
  const p = page();
  assert.equal(buttons(p).length, 5);
  assert.equal(p.d.getElementById('exPick').querySelector('[onclick],[onchange],[oninput]'), null, 'no inline handler (CSP)');
  assert.deepEqual(buttons(p).map(b => b.dataset.arg), IDS);
  assert.match(buttons(p)[0].textContent, /^General$/);
  buttons(p)[0].click();
  assert.deepEqual(p.ev('CASE.applied.map(a=>a.setId)'), ['ex_general']);
  assert.match(p.d.getElementById('forms').textContent, /Lymph glands/);
  assert.equal(buttons(p)[0].disabled, true);
  assert.match(buttons(p)[0].textContent, /\(added\)/);
});

test('with no examination set available, the picker says so instead of inventing any', () => {
  const p = page();
  p.w.eval('REGISTRY.length=0');
  p.w.renderExam();
  assert.equal(buttons(p).length, 0);
  assert.match(p.d.getElementById('exList').textContent, /No examination sets are available/);
});

test('a hostile title from another source is shown as text, never markup', () => {
  const p = page();
  p.w.eval('REGISTRY.push({id:"ex_evil",kind:"template",title:"Examination: <img src=x onerror=alert(1)>",fields:[]})');
  p.w.renderExam();
  assert.equal(p.d.querySelector('#exList img'), null);
  assert.match(p.d.getElementById('exList').textContent, /<img src=x/);
});

test('a finding is recorded through the page (local mode) with the same typing rules as the server path; an unlisted word is refused', () => {
  const p = page();
  p.w.applySet('ex_abdomen');
  p.w.setVal('exa_tender', 'Abnormal finding'); p.w.setVal('exa_bowel', 'Not examined');
  assert.deepEqual(['exa_tender', 'exa_bowel'].map(k => p.ev(`CASE.values.${k}`)), ['Abnormal finding', 'Not examined']);
  p.w.eval('window.__f=BUILTIN.find(b=>b.id==="ex_abdomen").fields');
  assert.deepEqual(p.ev('toTyped(__f.find(f=>f.id==="exa_tender"),"Nothing abnormal found")'), { v: 'Nothing abnormal found' });
  assert.ok(p.ev('toTyped(__f.find(f=>f.id==="exa_tender"),"Normal")').err, 'an unlisted word is refused');
});

test('two examination sets applied together keep separate values', () => {
  const p = page();
  p.w.applySet('ex_cvs'); p.w.applySet('ex_resp');
  p.w.setVal('exc_murmur', 'Abnormal finding'); p.w.setVal('exr_breath', 'Nothing abnormal found');
  assert.deepEqual([p.ev('CASE.values.exc_murmur'), p.ev('CASE.values.exr_breath')], ['Abnormal finding', 'Nothing abnormal found']);
});

test('context impact: the envelope carries the select findings and withholds the details text as narrative; the result validates', () => {
  const p = page();
  const def = p.ev('BUILTIN.find(b=>b.id==="ex_general")');
  const C = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', f), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(C('manifest.schema.json'));
  const validate = ajv.compile(C('context-envelope.schema.json'));
  const FREE = 'Looks pale around the eyes, said Quentin';
  let n = 0;
  const o = (field_key, value_type, value_json) => ({ id: ++n, applied_set_id: 7, field_key, value_type, value_json, unit_display: null,
    effective_at: '2026-11-23T07:30:00.000Z', recorded_at: '2026-11-23T07:31:00.000Z', source_type: 'clinician', status: 'final', corrects_id: null, recorded_role: 'doctor' });
  const env = buildEnvelope({
    caseRow: { id: 5, patient_name: 'Zelda Hargrove', mrn: 'CTX-1', title: 't', narrative: 'n' },
    pins: { sets: [{ id: 7, slug: 'ex_general', version: 1, definition_json: def, state: 'active' }], pathways: [] },
    observations: [o('exg_pallor', 'select', 'Abnormal finding'), o('exg_hydr', 'select', 'Not examined'), o('exg_details', 'text', FREE)],
    events: [], exportedAt: new Date('2026-11-23T08:00:00.000Z'), producerVersion: '0.1.0', refSecret: 'test-secret-test-secret-test-secret-1234' });
  assert.equal(validate(env), true, JSON.stringify(validate.errors));
  const bytes = JSON.stringify(env);
  assert.ok(bytes.includes('Abnormal finding') && bytes.includes('Not examined'), 'select findings flow');
  assert.equal(bytes.includes(FREE) || bytes.includes('Quentin'), false, 'details text is withheld');
  assert.equal(env['x-emr'].withheld.narrativeObservations, 1);
});
