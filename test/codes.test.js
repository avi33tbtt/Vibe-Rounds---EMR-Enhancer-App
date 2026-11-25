'use strict';
// Chunk 02: code-system registry, bindings[] migration, per-system verification, FHIR export.
// Runs the real page in jsdom with a mocked terminology server (no network, no database needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = require('./html').pageHtml();
const LOINC = 'http://loinc.org', SCT = 'http://snomed.info/sct';

function page({ store = {}, tx = {} } = {}) {
  const calls = [], errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
      w.fetch = async url => {
        url = String(url);
        if (url.startsWith('/api/')) return new Response('{}', { status: 401 });
        calls.push(url);
        if (tx.down) throw new TypeError('network down');
        const u = new URL(url);
        const d = (tx.codes || {})[u.searchParams.get('system') + '|' + u.searchParams.get('code')];
        if (!d) return new Response(JSON.stringify({ resourceType: 'OperationOutcome' }), { status: 404 });
        return new Response(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'display', valueString: d }] }), { status: 200 });
      };
    } });
  return { w: dom.window, calls, errors, ev: code => { const r = dom.window.eval(code); return r === undefined ? r : JSON.parse(JSON.stringify(r)); } };
}
const bundle = (p, set, values) => {
  p.w.eval(`REGISTRY.push(${JSON.stringify(set)});applySet(${JSON.stringify(set.id)});Object.assign(CASE.values,${JSON.stringify(values)})`);
  p.w.buildBundle();
  return JSON.parse(p.w.document.getElementById('bj').textContent);
};
const obs = (b, label) => b.entry.map(e => e.resource).find(r => r.resourceType === 'Observation' && r.code.text === label);

test('page loads without script errors', () => { const p = page(); assert.deepEqual(p.errors, []); });

test('registry: required systems, shape, CPT present but off, no verifier => stays unverified', () => {
  const p = page();
  const reg = p.ev('CODESYS.map(x=>({key:x.key,uri:x.uri,label:x.label,roles:x.roles,verifier:x.verifier,licenceNote:x.licenceNote,enabled:x.enabled}))');
  assert.deepEqual(reg.map(r => r.key).sort(), ['atc', 'cpt', 'icd10', 'icd11', 'local', 'loinc', 'rxnorm', 'snomed', 'ucum']);
  for (const r of reg) { assert.ok(r.uri && r.label && Array.isArray(r.roles) && r.licenceNote, r.key); assert.ok('verifier' in r); }
  assert.equal(reg.find(r => r.key === 'cpt').enabled, false);
  for (const k of ['icd10', 'icd11', 'atc', 'ucum', 'local', 'cpt']) assert.equal(reg.find(r => r.key === k).verifier, null, k);
  for (const k of ['snomed', 'loinc', 'rxnorm']) assert.ok(reg.find(r => r.key === k).verifier, k);
  assert.equal(p.ev('CFG.txHost'), 'https://tx.fhir.org/r4');
});

test('built-in and demo sets ship with no licensed codes (R2f-4c): no coding, no binding in a licensed system', () => {
  const p = page();
  assert.equal(p.ev('BUILTIN.every(s=>s.fields.every(f=>!("coding" in f)))'), true);
  const fields = JSON.parse(p.ev('JSON.stringify([...BUILTIN,DEMO_SNAKE,DEMO_DKA].flatMap(s=>s.fields||[]))'));
  assert.ok(fields.length > 50, 'the shipped sets were found');
  const LICENSED = ['snomed', 'loinc', 'icd10', 'icd11', 'rxnorm', 'atc', 'cpt'];
  for (const f of fields) for (const b of (f.bindings || [])) assert.ok(!LICENSED.includes(b.system), `${f.id} carries a ${b.system} code`);
  const hr = fields.find(f => f.id === 'hr');
  assert.ok(hr && !hr.bindings, 'vitals heart rate is uncoded in the page');
  assert.ok(!/coding:\{system:'(?:loinc|snomed)'/.test(HTML), 'no licensed coding literal left in the page source');
});

test('migration of stored data: single coding becomes a one-item list; nothing is lost; idempotent; original backed up', () => {
  const old = {
    cases: [], customs: [{
      id: 'old1', kind: 'care', title: 'Old', desc: '', custom: true, version: 2,
      fields: [
        { id: 'a', label: 'A', type: 'number', coding: { system: 'loinc', code: '1234-5', display: 'X', source: 'manual' } },
        { id: 'b', label: 'B', type: 'text' },
        { id: 'c', label: 'C', type: 'text', coding: { system: 'snomed', code: '111', display: 'Y' },
          bindings: [{ system: 'snomed', code: '111', display: 'Y' }, { system: 'icd10', code: 'A00', display: 'Cholera' }] },
        { id: 'd', label: 'D', type: 'text', coding: { system: 'snomed', code: '222', display: 'Z' }, bindings: [{ system: 'loinc', code: '9-9', display: 'Q' }] },
      ],
      history: [{ version: 1, title: 'Old', desc: '', fields: [{ id: 'a', label: 'A', type: 'number', coding: { system: 'loinc', code: '9999-9', display: 'Z' } }] }],
    }],
  };
  const raw = JSON.stringify(old);
  const p = page({ store: { vr_traj: raw } });
  assert.deepEqual(p.errors, []);
  const saved = JSON.parse(p.w.localStorage.getItem('vr_traj')).customs[0];
  const f = Object.fromEntries(saved.fields.map(x => [x.id, x]));
  assert.deepEqual(f.a.bindings, [{ system: 'loinc', code: '1234-5', display: 'X', source: 'manual' }]);
  assert.equal(f.b.bindings, undefined);
  assert.deepEqual(f.c.bindings.map(b => b.system + ':' + b.code), ['snomed:111', 'icd10:A00']);       // duplicate not doubled
  assert.deepEqual(f.d.bindings.map(b => b.system + ':' + b.code), ['loinc:9-9', 'snomed:222']);       // both kept
  assert.deepEqual(saved.history[0].fields[0].bindings.map(b => b.code), ['9999-9']);
  assert.ok(!JSON.stringify(saved).includes('"coding"'));
  assert.equal(p.w.localStorage.getItem('vr_traj_pre_bindings'), raw);                                  // original kept
  assert.equal(p.ev(`migrateSet(REGISTRY.find(s=>s.id==="old1"))`), 0);                                  // idempotent
  // loading already-migrated data again changes nothing and makes no second backup
  const again = page({ store: { vr_traj: p.w.localStorage.getItem('vr_traj') } });
  assert.equal(again.w.localStorage.getItem('vr_traj_pre_bindings'), null);
});

test('a field with two bindings exports both verified codes; unverified/local/no-verifier stay text only', async () => {
  const p = page({ tx: { codes: { [LOINC + '|8867-4']: 'Heart rate', [SCT + '|364075005']: 'Heart rate' } } });
  const set = { id: 'cs2', kind: 'care', title: 'T', desc: '', custom: true, version: 1, fields: [
    { id: 'hr2', label: 'HR two', type: 'number', bindings: [{ system: 'loinc', code: '8867-4', display: 'Heart rate' }, { system: 'snomed', code: '364075005', display: 'Heart rate' }] },
    { id: 'dx', label: 'Dx text', type: 'text', bindings: [{ system: 'icd10', code: 'A00', display: 'Cholera' }, { system: 'local', code: 'L1', display: 'Local thing' }, { system: 'loinc', code: '0000-0', display: 'Nope' }] },
    { id: 'half', label: 'One good one bad', type: 'number', bindings: [{ system: 'loinc', code: '8867-4', display: 'Heart rate' }, { system: 'snomed', code: '000', display: 'Missing' }] },
  ] };
  for (const f of set.fields) for (const b of f.bindings) await p.w.verifyBinding(b);
  const b = bundle(p, set, { hr2: 72, dx: 'x', half: 5 });
  const hr = obs(b, 'HR two');
  assert.deepEqual(hr.code.coding.map(c => c.system).sort(), [LOINC, SCT]);
  assert.deepEqual(hr.code.coding.map(c => c.code).sort(), ['364075005', '8867-4']);
  assert.equal(hr.code.text, 'HR two');
  const dx = obs(b, 'Dx text');
  assert.equal(dx.code.coding, undefined);
  assert.equal(dx.code.text, 'Dx text');
  assert.deepEqual(obs(b, 'One good one bad').code.coding.map(c => c.code), ['8867-4']);
  assert.ok(!JSON.stringify(b).includes('A00') && !JSON.stringify(b).includes('L1') && !JSON.stringify(b).includes('"000"'));
  assert.ok(!p.calls.some(u => /icd-10|emr-enhancer/.test(decodeURIComponent(u))), 'no lookup is made for systems without a verifier');
  assert.equal(await p.w.verifyBinding({ system: 'icd10', code: 'A00', display: 'Cholera' }), 'nosystem');
  assert.equal(await p.w.verifyBinding({ system: 'cpt', code: '99213', display: 'x' }), 'nosystem');
});

test('display mismatch stays unverified and is not exported', async () => {
  const p = page({ tx: { codes: { [LOINC + '|8867-4']: 'Heart rate' } } });
  const bd = { system: 'loinc', code: '8867-4', display: 'Blood sugar level' };
  assert.equal(await p.w.verifyBinding(bd), 'mismatch');
  assert.equal(p.ev(`bst(${JSON.stringify(bd)})`), 'unverified');
  assert.equal(JSON.parse(p.w.localStorage.getItem('vr_codes') || '{}')['loinc|8867-4'], undefined);
  const b = bundle(p, { id: 'mm', kind: 'care', title: 'M', desc: '', custom: true, version: 1, fields: [{ id: 'x', label: 'X', type: 'number', bindings: [bd] }] }, { x: 1 });
  assert.equal(obs(b, 'X').code.coding, undefined);
});

test('unreachable terminology server never marks a code verified', async () => {
  const p = page({ tx: { down: true } });
  const bd = { system: 'loinc', code: '8867-4', display: 'Heart rate' };
  assert.equal(await p.w.verifyBinding(bd), 'unreachable');
  assert.equal(p.ev(`bst(${JSON.stringify(bd)})`), 'unverified');
  assert.equal(p.w.localStorage.getItem('vr_codes'), null);
  const nf = page({ tx: { codes: {} } });
  assert.equal(await nf.w.verifyBinding(bd), 'notfound');
});

test('a verified code whose display is edited later is no longer verified', async () => {
  const p = page({ tx: { codes: { [LOINC + '|8867-4']: 'Heart rate' } } });
  const ok = { system: 'loinc', code: '8867-4', display: 'Heart rate' };
  assert.equal(await p.w.verifyBinding(ok), 'verified');
  assert.equal(p.ev(`bst(${JSON.stringify(ok)})`), 'verified');
  const edited = { ...ok, display: 'Fasting glucose measurement' };
  assert.equal(p.ev(`bst(${JSON.stringify(edited)})`), 'unverified');
  assert.equal(await p.w.verifyBinding(edited), 'mismatch');
  assert.equal(p.calls.length, 1, 'cached result reused, no second lookup');
});

test('terminology host comes from config', async () => {
  const p = page({ store: { vr_cfg: JSON.stringify({ txHost: 'https://tx.example.test/r4' }) }, tx: { codes: {} } });
  await p.w.verifyBinding({ system: 'snomed', code: '1', display: 'x' });
  assert.ok(p.calls[0].startsWith('https://tx.example.test/r4/CodeSystem/$lookup?system=http%3A%2F%2Fsnomed.info%2Fsct'));
});

test('role guard warns on mismatch (ICD on a numeric field) but never blocks', async () => {
  const p = page();
  assert.match(p.ev(`roleWarn({type:"number"},{system:"icd10",code:"A00"})`), /ICD-10.*numeric/);
  assert.equal(p.ev(`roleWarn({type:"select"},{system:"icd10",code:"A00"})`), '');
  assert.equal(p.ev(`roleWarn({type:"text"},{system:"ucum",code:"mg"})`).length > 0, true);
  assert.match(p.ev(`roleWarn({type:"text"},{system:"cpt",code:"1"})`), /turned off/);
  const b = bundle(p, { id: 'rg', kind: 'care', title: 'R', desc: '', custom: true, version: 1, fields: [{ id: 'n', label: 'Num', type: 'number', bindings: [{ system: 'icd10', code: 'A00', display: 'Cholera' }] }] }, { n: 3 });
  assert.ok(obs(b, 'Num'), 'export still produced');
  assert.match(p.w.document.getElementById('codeTab').innerHTML, /not usually used for numeric/);
});

test('SDC: item.code with several systems imports as bindings[]; export emits only verified ones', async () => {
  const p = page({ tx: { codes: { [LOINC + '|8867-4']: 'Heart rate', [SCT + '|364075005']: 'Heart rate' } } });
  const q = { resourceType: 'Questionnaire', title: 'Q', item: [{ linkId: 'hr', text: 'Heart rate', type: 'integer', code: [
    { system: LOINC, code: '8867-4', display: 'Heart rate' }, { system: SCT, code: '364075005', display: 'Heart rate' },
    { system: 'http://hl7.org/fhir/sid/icd-10', code: 'A00', display: 'Cholera' },
    { system: 'http://www.ama-assn.org/go/cpt', code: '99213', display: 'Visit' }, { system: 'urn:foo', code: 'z' }] }] };
  const set = p.w.sdcToSet(q);
  const f = JSON.parse(JSON.stringify(set.fields[0]));
  assert.deepEqual(f.bindings.map(b => b.system), ['loinc', 'snomed', 'icd10']);
  assert.ok(f.bindings.every(b => b.source === 'sdc'));
  assert.deepEqual(f.otherCodes.map(c => c.code), ['99213', 'z']);          // disabled / unknown systems kept, not bound
  for (const b of set.fields[0].bindings) await p.w.verifyBinding(b);
  const out = p.w.buildQuestionnaire({ id: 'qq', title: 'Q', version: 1, fields: set.fields });
  assert.deepEqual(out.item[0].code.map(c => c.code).sort(), ['364075005', '8867-4']);
});
