'use strict';
// Chunk 03: unified create screen (SDC checkbox + code-system picker), AI bindings only for ticked systems, shared sdc.js.
// Runs the real page in jsdom with a mocked terminology server. No network, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { pageHtml } = require('./html');
const Sdc = require('../sdc');
const { genPrompt } = require('../ai');

const HTML = pageHtml();
const J = x => JSON.parse(JSON.stringify(x));   // values from the jsdom window have a different Object prototype
const SCT = 'http://snomed.info/sct', LOINC = 'http://loinc.org';

function page({ store = {}, tx = {} } = {}) {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
      w.fetch = async url => {
        url = String(url);
        if (url.startsWith('/api/')) return new Response('{}', { status: 401 });
        const u = new URL(url);
        const d = (tx.codes || {})[u.searchParams.get('system') + '|' + u.searchParams.get('code')];
        if (!d) return new Response(JSON.stringify({ resourceType: 'OperationOutcome' }), { status: 404 });
        return new Response(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'display', valueString: d }] }), { status: 200 });
      };
    } });
  const w = dom.window, d = w.document;
  return { w, d, errors, $: id => d.getElementById(id), ev: c => { const r = w.eval(c); return r === undefined ? r : JSON.parse(JSON.stringify(r)); } };
}
const tick = (p, key, on) => { const i = p.d.querySelector(`#o_sys [data-sys=${key}]`); i.checked = on; i.dispatchEvent(new p.w.Event('change')); };
const none = p => { const i = p.$('o_none'); i.checked = true; i.dispatchEvent(new p.w.Event('change')); };
const sdcBox = (p, on) => { p.$('o_sdc').checked = on; p.$('o_sdc').dispatchEvent(new p.w.Event('change')); };
// Fill one field block of the manual create form.
function field(p, blk, { id, label, type = 'text', extra = '', rep = false, pol, polSys = [], binds = [] }) {
  blk.querySelector('.f-id').value = id; blk.querySelector('.f-label').value = label;
  blk.querySelector('.f-type').value = type; blk.querySelector('.f-extra').value = extra; blk.querySelector('.f-rep').checked = rep;
  if (pol) { const s = blk.querySelector('.f-pol'); s.value = pol; s.dispatchEvent(new p.w.Event('change', { bubbles: true })); }
  polSys.forEach(k => { const c = blk.querySelector(`.f-polsys [data-k=${k}]`); c.checked = true; c.dispatchEvent(new p.w.Event('change', { bubbles: true })); });
  blk.querySelectorAll('.f-binds .bind').forEach(r => r.remove());
  binds.forEach(b => { p.w.addBindRow(blk, b); });
  p.w.polRefresh(blk);
}
function create(p, { id, title, fields }) {
  p.$('c_id').value = id; p.$('c_title').value = title;
  p.$('c_fields').innerHTML = '';
  fields.forEach(f => { p.w.addFieldRow(); const blk = p.$('c_fields').lastElementChild; field(p, blk, f); });
  p.w.saveElement();
  return p.ev(`REGISTRY.find(s=>s.id===${JSON.stringify(id)})||null`);
}

test('page loads, shares one sdc.js, and the picker defaults to SNOMED + LOINC', () => {
  const p = page();
  assert.deepEqual(p.errors, []);
  assert.equal(typeof p.w.EmrSdc.buildQuestionnaire, 'function');
  assert.deepEqual(p.ev('CS_PICK'), ['snomed', 'loinc']);
  assert.equal(p.$('o_sdc').checked, false);
  assert.ok([...p.d.querySelectorAll('#o_sys label')].map(l => l.textContent.trim()).some(t => /^None/.test(t)));
});

test('one copy: the page and Node (the server) build the identical Questionnaire and QuestionnaireResponse', () => {
  const p = page();
  const set = { id: 'same', title: 'Same', version: 2, desc: 'd', fields: [
    { id: 'hr', label: 'Heart rate', type: 'number', unit: 'bpm', repeat: true },
    { id: 'st', label: 'Status', type: 'select', options: ['A', 'B'], required: true },
    { id: 'w', label: 'Weight', type: 'number', unit: 'kg', path: [{ linkId: 'g1', text: 'Group' }], linkId: 'w1' }] };
  const env = { known: () => null, codings: () => [], now: () => 'T' };
  assert.deepEqual(J(p.w.buildQuestionnaire(J(set))), Sdc.buildQuestionnaire(set, env));
  const q = Sdc.buildQuestionnaire(set, env);
  assert.deepEqual(JSON.parse(JSON.stringify(p.w.EmrSdc.sdcToSet(q, { known: () => null, now: () => 'T' }))), JSON.parse(JSON.stringify(Sdc.sdcToSet(q, env))));
  const ctx = { values: { st: 'A', w: '70' }, rows: () => [{ value: '80' }, { value: '90' }], pid: 'Patient/1', author: 'x', now: 'T' };
  assert.deepEqual(JSON.parse(JSON.stringify(p.w.EmrSdc.buildQR(set, ctx))), Sdc.buildQR(set, ctx));
  assert.equal(q.item.find(i => i.linkId === 'hr').repeats, true);   // serial values need repeats:true
});

test('AI prompt names only the ticked systems; with None it asks for no codes at all', () => {
  const p = page();
  // the browser sends only the whitelisted payload; the system prompt is built from it on the server (ai.js)
  const sysText = () => genPrompt(J(p.w.aiPayload('gen', 'Sepsis', '')).systems);
  assert.deepEqual(J(p.w.aiPayload('gen', 'Sepsis', '').systems), ['snomed', 'loinc']);
  tick(p, 'snomed', false); tick(p, 'loinc', false); tick(p, 'icd10', true);
  assert.deepEqual(J(p.w.aiPayload('gen', 'Sepsis', '').systems), ['icd10']);
  assert.match(sysText(), /Allowed systems ONLY: icd10/);
  assert.doesNotMatch(sysText(), /snomed|loinc|LOINC|SNOMED/);
  tick(p, 'icd10', false); tick(p, 'local', true);   // Local is never proposed by AI
  assert.deepEqual(J(p.w.aiPayload('gen', 'Sepsis', '').systems), []);
  assert.match(sysText(), /do NOT include codes or bindings/); assert.doesNotMatch(sysText(), /"bindings"/);
  none(p);
  assert.deepEqual(p.ev('CS_PICK'), []);
  assert.match(sysText(), /do NOT include codes or bindings/);
  assert.match(p.$('o_note').textContent, /uncoded/);
  assert.deepEqual(Object.keys(J(p.w.aiPayload('gen', 'Sepsis', ''))).sort(), ['diagnosis', 'systems']);   // still a whitelist
});

test('generated bindings: only ticked systems survive, tagged llm, empty when unsure, same verify step', async () => {
  const p = page({ tx: { codes: { [SCT + '|91302008']: 'Sepsis', [LOINC + '|2345-7']: 'Glucose [Mass/volume] in Serum or Plasma' } } });
  const raw = { title: 'Sepsis', fields: [
    { label: 'Dx', type: 'text', bindings: [{ system: 'snomed', code: '91302008', display: 'Sepsis' }, { system: 'icd10', code: 'A41.9', display: 'Sepsis, unspecified' }] },
    { label: 'Glucose', type: 'number', bindings: [{ system: 'loinc', code: '2345-7', display: 'Glucose [Mass/volume] in Serum or Plasma' }, { system: 'snomed', code: '', display: '' }] },
    { label: 'Unsure', type: 'text', bindings: [] },
    { label: 'Old shape', type: 'text', coding: { system: 'snomed', code: '1', display: 'x' } }] };
  const set = JSON.parse(JSON.stringify(p.w.normaliseGenerated(raw, 'Sepsis', ['snomed', 'loinc'], 'llm')));
  assert.deepEqual(set.fields[0].bindings, [{ system: 'snomed', code: '91302008', display: 'Sepsis', source: 'llm' }]);   // ICD-10 not ticked: dropped
  assert.equal(p.ev('GEN_DROPPED'), 1 + 0);   // counted for the last set normalised
  assert.equal(set.fields[1].bindings[0].source, 'llm'); assert.equal(set.fields[1].bindings.length, 1);
  assert.equal(set.fields[2].bindings, undefined);   // empty if unsure
  assert.equal(set.fields[3].bindings[0].source, 'llm');   // legacy coding shape still accepted, still tagged
  const none = JSON.parse(JSON.stringify(p.w.normaliseGenerated(raw, 'Sepsis', [], 'llm')));
  assert.ok(none.fields.every(f => !f.bindings));
  // proposals are unverified until the same verify step runs
  p.w.eval('LAST_GENERATED=' + JSON.stringify(set));
  assert.equal(p.ev('bst(LAST_GENERATED.fields[0].bindings[0])'), 'unverified');
  await p.w.verifyGenerated();
  assert.equal(p.ev('bst(LAST_GENERATED.fields[0].bindings[0])'), 'verified');
  assert.equal(p.ev('bst(LAST_GENERATED.fields[3].bindings[0])'), 'unverified');   // code 1 not on the server
});

test('demo generation respects the picker too (and keeps bindings that the old code dropped)', async () => {
  const p = page({ store: { vr_set: JSON.stringify({ d: true }) } });
  p.w.eval('Object.assign(AI, { on: true, canUse: true, configured: true })');   // as the server would report it for a doctor
  p.$('gen_dx').value = 'Diabetic ketoacidosis'; await p.w.generate();
  const withDefault = p.ev('LAST_GENERATED').fields.reduce((n, f) => n + (f.bindings || []).length, 0);
  assert.ok(withDefault > 0, 'default picker keeps SNOMED/LOINC demo bindings');
  assert.match(p.$('genSummary').textContent, /DKA|ketoacidosis/i);
  none(p); await p.w.generate();
  const set = p.ev('LAST_GENERATED');
  assert.ok(set.fields.every(f => !(f.bindings || []).length));
  assert.match(p.$('genSummary').textContent, /uncoded/);
  assert.match(p.$('genBind').textContent, /uncoded/);
});

test('SDC mode lists what a Questionnaire cannot express before generating; the box is off by default', () => {
  const p = page({ store: { vr_set: JSON.stringify({ d: false }) } });
  p.w.eval('Object.assign(AI, { on: true, canUse: true, configured: true })');
  p.w.callAI = () => new Promise(() => {});   // a model call that is still waiting (e.g. the preview dialog is open)
  assert.equal(p.$('sdcLimits').style.display, 'none');
  sdcBox(p, true);
  const t = p.$('sdcLimits').textContent;
  assert.equal(p.$('sdcLimits').style.display, 'block');
  assert.match(t, /enableWhen/); assert.match(t, /calculatedExpression/); assert.match(t, /Value-set options/);
  p.$('gen_dx').value = 'Diabetic ketoacidosis';
  p.w.generate();
  assert.match(p.$('genStatus').textContent, /enableWhen.*calculated.*value-set/i);   // shown before anything is generated
  sdcBox(p, false);
  assert.equal(p.$('sdcLimits').style.display, 'none');
});

test('same screen creates a set WITHOUT and WITH SDC; the Questionnaire is stored with the set', () => {
  const p = page();
  const fields = [{ id: 'hr', label: 'Heart rate', type: 'number', extra: 'bpm', rep: true, binds: [{ system: 'loinc', code: '8867-4', display: 'Heart rate' }] },
    { id: 'st', label: 'Status', type: 'select', extra: 'A,B', binds: [] }];
  const plain = create(p, { id: 'plain_set', title: 'Plain', fields });
  assert.equal(plain.sdc, undefined); assert.equal(plain.questionnaire, undefined);
  sdcBox(p, true);
  const withSdc = create(p, { id: 'sdc_set', title: 'With SDC', fields });
  assert.equal(withSdc.sdc.authored, true);
  assert.deepEqual(J(withSdc.sdc.limitations), ['enableWhen', 'calculated', 'valueSet']);
  assert.equal(withSdc.questionnaire.resourceType, 'Questionnaire');
  assert.deepEqual(withSdc.questionnaire.item.map(i => i.linkId), ['hr', 'st']);
  assert.deepEqual(withSdc.fields, plain.fields);   // the internal set is identical either way
  // deterministic: rebuilding from the stored set gives the stored Questionnaire
  assert.deepEqual(J(p.w.buildQuestionnaire(p.w.eval('getSet("sdc_set")'))), withSdc.questionnaire);
  assert.equal(withSdc.questionnaire.item[0].repeats, true);
  // unverified LOINC code is not written as Coding, so the item has no code
  assert.equal(withSdc.questionnaire.item[0].code, undefined);
  // editing and saving with the box unticked takes the authoring off again
  p.w.editCustom('sdc_set'); assert.equal(p.$('o_sdc').checked, true);
  sdcBox(p, false); p.w.saveElement();
  const after = p.ev('REGISTRY.find(s=>s.id==="sdc_set")');
  assert.equal(after.sdc, undefined); assert.equal(after.questionnaire, undefined);
});

test('imported Questionnaires keep their behaviour: box is shown ticked and locked when editing one', () => {
  const p = page();
  const q = { resourceType: 'Questionnaire', title: 'Imp', url: 'http://x/q', version: '1', item: [{ linkId: 'a', text: 'A', type: 'string' }] };
  p.$('q_json').value = JSON.stringify(q); p.w.importQ();
  const id = p.ev('REGISTRY.find(s=>s.sdc&&s.sdc.url==="http://x/q").id');
  p.w.editCustom(id);
  assert.equal(p.$('o_sdc').checked, true); assert.equal(p.$('o_sdc').disabled, true);
  p.w.saveElement();   // unchanged fields: still the original Questionnaire, not marked modified
  assert.equal(p.ev(`getSet(${JSON.stringify(id)}).sdc.modified`), undefined);
  assert.deepEqual(J(p.w.buildQuestionnaire(p.w.getSet(id))), q);
});

test('uncoded set: flagged "uncoded", still usable (apply, enter values, bundle)', () => {
  const p = page();
  none(p);
  const set = create(p, { id: 'unc', title: 'Uncoded set', fields: [{ id: 'note1', label: 'Free note', type: 'text', binds: [] }, { id: 'hr', label: 'Rate', type: 'number', extra: 'bpm', binds: [] }] });
  assert.ok(set.fields.every(f => !f.bindings));
  p.d.querySelector('[data-t=lib]').click();
  assert.match(p.$('libList').textContent, /Uncoded set[\s\S]*uncoded/);
  assert.match(p.$('customList').textContent, /uncoded/);
  p.w.applySet('unc');
  assert.equal(p.ev('isApplied("unc")'), true);
  p.w.setVal('hr', '88');
  p.w.buildBundle();
  const b = JSON.parse(p.$('bj').textContent);
  const o = b.entry.map(e => e.resource).find(r => r.resourceType === 'Observation' && r.code.text === 'Rate');
  assert.ok(o); assert.equal(o.code.coding, undefined);   // no code, nothing invented
  assert.match(p.d.getElementById('forms').innerHTML || p.d.body.innerHTML, /uncoded/);
});

test('multi-binding authoring: several rows per field survive save and edit; per-field custom and skip', () => {
  const p = page();
  const set = create(p, { id: 'multi', title: 'Multi', fields: [
    { id: 'glu', label: 'Glucose', type: 'number', extra: 'mg/dL', binds: [{ system: 'loinc', code: '2345-7', display: 'Glucose' }, { system: 'snomed', code: '33747003', display: 'Glucose measurement' }, { system: 'local', code: 'G1', display: 'Gluc local' }] },
    { id: 'dx', label: 'Diagnosis', type: 'text', pol: 'custom', polSys: ['icd10'], binds: [{ system: 'icd10', code: 'E11', display: 'T2DM' }] },
    { id: 'skipme', label: 'Skipped', type: 'text', pol: 'skip' },
    { id: 'nopol', label: 'Plain', type: 'text', binds: [] }] });
  const f = Object.fromEntries(set.fields.map(x => [x.id, x]));
  assert.deepEqual(f.glu.bindings.map(b => b.system), ['loinc', 'snomed', 'local']);
  assert.ok(f.glu.bindings.every(b => b.source === 'manual'));
  assert.deepEqual(f.dx.codingPolicy, { mode: 'custom', systems: ['icd10'] });
  assert.deepEqual(f.skipme.codingPolicy, { mode: 'skip' }); assert.equal(f.skipme.bindings, undefined);
  assert.equal(f.nopol.codingPolicy, undefined);
  // reopen: rows are rebuilt, nothing dropped; saving again changes nothing (no version bump)
  p.w.editCustom('multi');
  assert.equal(p.d.querySelectorAll('#c_fields .fblock')[0].querySelectorAll('.f-binds .bind').length, 3);
  assert.equal(p.d.querySelectorAll('#c_fields .fblock')[2].querySelector('.f-pol').value, 'skip');
  p.w.saveElement();
  const again = p.ev('REGISTRY.find(s=>s.id==="multi")');
  assert.equal(again.version, 1); assert.deepEqual(again.fields, set.fields);
  // Verified status for each binding is separate; role/policy warning for a system outside the field's choice
  p.w.editCustom('multi');
  const blk = p.d.querySelectorAll('#c_fields .fblock')[1];
  p.w.addBindRow(blk, { system: 'snomed', code: '44054006', display: 'T2DM' });
  assert.match(blk.textContent, /outside this field’s chosen systems/);
  // Skipping a field that has bindings warns that saving removes them, and does remove them
  const g = p.d.querySelectorAll('#c_fields .fblock')[0];
  g.querySelector('.f-pol').value = 'skip'; p.w.polChange(g.querySelector('.f-pol'));
  assert.match(g.querySelector('.f-polnote').textContent, /removes/);
  p.w.saveElement();
  const saved = p.ev('REGISTRY.find(s=>s.id==="multi")');
  assert.equal(saved.version, 2);
  assert.equal(saved.fields[0].bindings, undefined); assert.deepEqual(saved.fields[0].codingPolicy, { mode: 'skip' });
  assert.equal(saved.history[0].fields[0].bindings.length, 3);   // the earlier version keeps them
});

test('generated preview: per-field skip sets the proposal aside and un-ticking brings it back; commit adds SDC when ticked', () => {
  const p = page();
  const raw = { title: 'T', fields: [{ label: 'A', type: 'text', bindings: [{ system: 'snomed', code: '1', display: 'x' }] }, { label: 'B', type: 'text', bindings: [{ system: 'loinc', code: '2', display: 'y' }] }] };
  p.w.eval('LAST_GENERATED=normaliseGenerated(' + JSON.stringify(raw) + ',"T",["snomed","loinc"],"llm");renderGenPreview();$("genPreview").style.display="block"');
  assert.equal(p.ev('LAST_GENERATED.fields[0].bindings.length'), 1);
  p.w.genSkip('a', true);
  assert.equal(p.ev('LAST_GENERATED.fields[0].bindings'), undefined);
  assert.deepEqual(p.ev('LAST_GENERATED.fields[0].codingPolicy'), { mode: 'skip' });
  assert.match(p.$('genBind').textContent, /skipped/);
  p.w.genSkip('a', false);
  assert.equal(p.ev('LAST_GENERATED.fields[0].bindings.length'), 1); assert.equal(p.ev('LAST_GENERATED.fields[0].codingPolicy'), undefined);
  p.w.genSkip('b', true);
  sdcBox(p, true); p.w.saveGenerated();
  const s = p.ev('REGISTRY.find(s=>s.id==="gen_t")');
  assert.equal(s.sdc.authored, true); assert.equal(s.questionnaire.resourceType, 'Questionnaire');
  assert.deepEqual(s.fields[1].codingPolicy, { mode: 'skip' });
  assert.equal(JSON.stringify(s).includes('_proposed'), false);
});
