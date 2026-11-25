'use strict';
// R1e: the assessment and plan block and its picker. Runs the real page in jsdom (no network, no database).
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
const FIELDS = [['ap_problem', 'text', true], ['ap_status', 'select', false], ['ap_ddx', 'text', false], ['ap_plan', 'text', true],
  ['ap_advice', 'text', false], ['ap_discussed', 'boolean', false], ['ap_fu_to', 'select', false], ['ap_fu_on', 'datetime', false]];
const buttons = p => [...p.d.querySelectorAll('#apList button')];
const set = p => p.ev('BUILTIN.find(x=>x.id==="ap_block")');

test('the set exists as a built-in; it passes the shared lint with no codes, doses or numbers, and needs no second reviewer', () => {
  const p = page(); assert.deepEqual(p.errors, []);
  assert.deepEqual(p.ev('AP_SETS.map(s=>s.id)'), ['ap_block']);
  const s = set(p); assert.ok(s, 'built-in');
  const r = lint(s, { scrub: false, bindingState: () => 'verified' });
  assert.equal(r.ok, true, JSON.stringify(r.findings)); assert.equal(r.needsTwoReviewers, false);
  assert.ok(s.fields.every(f => !('coding' in f) && !('bindings' in f) && !('unit' in f)), 'no codes or units (a code waits for R2)');
  assert.ok(s.fields.every(f => !/\d/.test(f.label + (f.options || []).join(' '))), 'no numbers (no thresholds)');
});

test('fields, types, order and repeat flags are as planned; the two select lists are fixed', () => {
  const p = page(), s = set(p);
  assert.deepEqual(s.fields.map(f => [f.id, f.type, !!f.repeat]), FIELDS);
  assert.deepEqual(s.fields.find(f => f.id === 'ap_status').options, ['Working diagnosis', 'Confirmed', 'Not yet clear']);
  assert.deepEqual(s.fields.find(f => f.id === 'ap_fu_to').options, ['Same clinic', 'Another clinic', 'Not needed', 'Not decided']);
  assert.ok(s.fields.every(f => f.id.startsWith('ap_')));
});

test('field ids are unique across every built-in set, so applied sets never clash', () => {
  const p = page();
  const seen = new Map(), clash = [];
  for (const s of p.ev('BUILTIN')) for (const f of s.fields) { if (seen.has(f.id)) clash.push(`${f.id}: ${seen.get(f.id)} and ${s.id}`); seen.set(f.id, s.id); }
  assert.deepEqual(clash, []);
});

test('the set is offered in the demo import, and the module loads right after 56-exam', () => {
  const p = page();
  const imp = p.ev('DEMO_IMPORT');
  assert.ok(imp.includes('ap_block'));
  assert.ok(imp.every(id => p.ev(`BUILTIN.some(b=>b.id==="${id}")`)), 'every demo-import id is a built-in');
  const l = localScripts();
  assert.equal(l.indexOf('modules/58-assessment.js'), l.indexOf('modules/56-exam.js') + 1);
});

test('the picker shows one button with no inline handler; a click applies the set and the button shows it as added', () => {
  const p = page();
  assert.equal(buttons(p).length, 1);
  assert.equal(p.d.getElementById('apPick').querySelector('[onclick],[onchange],[oninput]'), null, 'no inline handler (CSP)');
  assert.equal(buttons(p)[0].dataset.arg, 'ap_block');
  assert.match(buttons(p)[0].textContent, /^Assessment and plan$/);
  buttons(p)[0].click();
  assert.deepEqual(p.ev('CASE.applied.map(a=>a.setId)'), ['ap_block']);
  assert.match(p.d.getElementById('forms').textContent, /Other possibilities considered/);
  assert.equal(buttons(p)[0].disabled, true);
  assert.match(buttons(p)[0].textContent, /\(added\)/);
});

test('with no set available, the picker says so instead of inventing one; a hostile title is shown as text, never markup', () => {
  const p = page();
  p.w.eval('REGISTRY.length=0'); p.w.renderAP();
  assert.equal(buttons(p).length, 0);
  assert.match(p.d.getElementById('apList').textContent, /not available/);
  p.w.eval('REGISTRY.push({id:"ap_evil",kind:"template",title:"<img src=x onerror=alert(1)>",fields:[]})'); p.w.renderAP();
  assert.equal(p.d.querySelector('#apList img'), null);
  assert.match(p.d.getElementById('apList').textContent, /<img src=x/);
});

test('values are recorded through the page (local mode) with the same typing rules as the server path; an unlisted word is refused', () => {
  const p = page();
  p.w.applySet('ap_block');
  p.w.setVal('ap_status', 'Confirmed'); p.w.setVal('ap_fu_to', 'Not decided');
  assert.deepEqual(['ap_status', 'ap_fu_to'].map(k => p.ev(`CASE.values.${k}`)), ['Confirmed', 'Not decided']);
  p.w.eval('window.__f=BUILTIN.find(b=>b.id==="ap_block").fields');
  assert.deepEqual(p.ev('toTyped(__f.find(f=>f.id==="ap_status"),"Working diagnosis")'), { v: 'Working diagnosis' });
  assert.ok(p.ev('toTyped(__f.find(f=>f.id==="ap_status"),"Certain")').err, 'an unlisted word is refused');
  assert.match(p.ev('toTyped(__f.find(f=>f.id==="ap_fu_on"),"2026-12-01T09:00").v'), /^2026-12-01T/);
});

test('a repeating problem list keeps every row, newest first', () => {
  const p = page();
  p.w.applySet('ap_block');
  p.w.addRow('ap_problem', 'first problem'); p.w.addRow('ap_problem', 'second problem'); p.w.addRow('ap_plan', 'a plan item');
  assert.deepEqual(p.ev('allRows("ap_problem").map(r=>r.value)'), ['second problem', 'first problem']);
  assert.deepEqual(p.ev('allRows("ap_plan").map(r=>r.value)'), ['a plan item']);
});

test('context impact: the envelope carries the selects, boolean and datetime and withholds all text; the result validates', () => {
  const p = page(), def = set(p);
  const C = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', f), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(C('manifest.schema.json'));
  const validate = ajv.compile(C('context-envelope.schema.json'));
  const T1 = 'Probable viral illness, said Quentin', T2 = 'Rest and fluids at home';
  let n = 0;
  const o = (field_key, value_type, value_json) => ({ id: ++n, applied_set_id: 7, field_key, value_type, value_json, unit_display: null,
    effective_at: '2026-11-23T07:30:00.000Z', recorded_at: '2026-11-23T07:31:00.000Z', source_type: 'clinician', status: 'final', corrects_id: null, recorded_role: 'doctor' });
  const env = buildEnvelope({
    caseRow: { id: 5, patient_name: 'Zelda Hargrove', mrn: 'CTX-1', title: 't', narrative: 'n' },
    pins: { sets: [{ id: 7, slug: 'ap_block', version: 1, definition_json: def, state: 'active' }], pathways: [] },
    observations: [o('ap_problem', 'text', T1), o('ap_plan', 'text', T2), o('ap_status', 'select', 'Working diagnosis'), o('ap_discussed', 'boolean', true), o('ap_fu_on', 'datetime', '2026-12-01T09:00:00Z')],
    events: [], exportedAt: new Date('2026-11-23T08:00:00.000Z'), producerVersion: '0.1.0', refSecret: 'test-secret-test-secret-test-secret-1234' });
  assert.equal(validate(env), true, JSON.stringify(validate.errors));
  const bytes = JSON.stringify(env);
  assert.ok(bytes.includes('Working diagnosis') && bytes.includes('2026-12-01'), 'select and datetime flow');
  assert.equal(bytes.includes(T1) || bytes.includes(T2) || bytes.includes('Quentin'), false, 'free text is withheld');
  assert.equal(env['x-emr'].withheld.narrativeObservations, 2);
});
