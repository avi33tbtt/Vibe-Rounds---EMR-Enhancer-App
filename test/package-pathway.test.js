'use strict';
// Task D5a: pathway proposal, concept map and owner blockers from a package bundle. Pure: no database, no server.
// Fixtures are small hand-written synthetic documents, checksummed with the vendored CCIS code. Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parsePackage } = require('../package-import');

let C;
test.before(async () => { C = await import(pathToFileURL(path.join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href); });
const sum = doc => C.checksumOf(C.canonicalize(doc).text);
const art = doc => ({ checksum: sum(doc), document: doc });
const clone = x => JSON.parse(JSON.stringify(x));
const man = (id, type, name) => ({ id, name, type, version: '0.1.0', status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } });
const loc = code => ({ codeSystem: { id: 'local', version: '0.1.0' }, code, mapping: { status: 'mapped' } });
const bundle = (...docs) => ({ format: 'ccis-package-bundle/1', artefacts: docs.map(art) });
const codes = r => r.blockers.map(b => b.code);

const TERMS = { manifest: man('t.terms', 'terminology-package', 'Terms'), codeSystem: { id: 'local', version: '0.1.0' },
  concepts: [{ key: 'pulse-rate', display: 'Pulse rate' }, { key: 'dm-type.t1', display: 'Type 1' }],
  valueSets: [{ id: 't.dm-type', version: '0.1.0', members: [{ key: 'dm-type.t1' }] }] };
const VITALS = { manifest: man('core.vitals', 'contextual-element', 'Vitals'), intent: { purpose: 'Record vital signs.' },
  fields: [{ key: 'hr', label: 'Heart rate', type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 'unbounded' }, concept: loc('pulse-rate'), 'x-emrFieldId': 'hr_bpm' },
    { key: 'note', label: 'Note', type: 'string', cardinality: { min: 0, max: 1 } }] };
const DM = { manifest: man('dm.core', 'contextual-element', 'Diabetes core'), intent: { purpose: 'Diabetes basics.' },
  fields: [{ key: 'dmType', label: 'Type of diabetes', type: 'code', cardinality: { min: 0, max: 1 }, binding: { ...loc('dm-type'), valueSet: { id: 't.dm-type', version: '0.1.0' } }, 'x-emrFieldId': 'dm_type' }] };
const USER = { manifest: man('x.user', 'contextual-element', 'User'), fields: [{ key: 'pulse', label: 'Pulse', type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 1 }, concept: loc('pulse-rate'), ownedBy: { element: 'core.vitals', key: 'hr' } }] };
const PW = { manifest: man('dm', 'pathway', 'Diabetes documentation'), scope: 'Information needed for diabetes documentation.', intendedUse: 'Layout only.', exclusions: [],
  elements: [{ id: 'core.vitals', type: 'contextual-element', range: '0.1.0' }, { id: 'dm.core', type: 'contextual-element', range: '0.1.0' }],
  stages: [{ id: 'documentation', label: 'Documentation', kind: 'report', entry: ['A case is open.'], exit: ['The information is recorded.'] }],
  entryForm: { sections: [
    { id: 'history', label: 'History', items: [{ kind: 'element', element: 'dm.core' }, { kind: 'section', section: 'core.problems', visibleByDefault: true }] },
    { id: 'exam', label: 'Examination', items: [{ kind: 'element', element: 'core.vitals', fields: ['hr', 'note'], rowGroups: [['hr']] }] }] },
  contexts: [{ id: 'diabetes', label: 'Diabetes', elements: ['dm.core'] }] };
const withPw = f => { const p = clone(PW); f(p); return p; };
const run = (pw, ...extra) => parsePackage(bundle(TERMS, VITALS, DM, ...extra, pw));

test('1. a valid pathway: step order from the entry form, slugs and EMR field ids, translated contexts, bare-hex source', async () => {
  const r = await run(PW);
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  const w = r.pathways[0];
  assert.equal(w.slug, 'dm'); assert.equal(w.draft, true); assert.equal(w.ready, true);
  assert.deepEqual(w.steps.map(s => s.set), ['dm-core', 'core-vitals']);   // entry form order, not the elements order
  assert.deepEqual(w.entryForm.sections[0].items, [{ kind: 'element', set: 'dm-core' }, { kind: 'section', section: 'core.problems', visibleByDefault: true }]);
  assert.deepEqual(w.entryForm.sections[1].items[0], { kind: 'element', set: 'core-vitals', fields: ['hr_bpm', 'note'], rowGroups: [['hr_bpm']] });
  assert.deepEqual(w.contexts, [{ id: 'diabetes', label: 'Diabetes', elements: ['dm-core'] }]);
  assert.equal(w.source.checksum, sum(PW).slice(7)); assert.match(w.source.checksum, /^[0-9a-f]{64}$/);
  assert.equal(w.description, PW.scope); assert.equal(r.counts.pathways, 1);
});

test('2. a caret range, a missing element and a not-ready element are named blockers', async () => {
  assert.ok(codes(await run(withPw(p => { p.elements[0].range = '^0.1.0'; }))).includes('range'));
  assert.ok(codes(await run(withPw(p => { p.elements.push({ id: 'nope.el', type: 'contextual-element', range: '0.1.0' }); }))).includes('member-missing'));
  const bad = clone(USER); bad.fields[0].label = '<b>x</b>';
  const r = await run(withPw(p => { p.elements.push({ id: 'x.user', type: 'contextual-element', range: '0.1.0' }); }), bad);
  assert.ok(codes(r).includes('member-not-ready')); assert.equal(r.pathways[0].ready, false);
});

test('3. an element left out of the entry form and more than 30 elements are blockers', async () => {
  assert.ok(codes(await run(withPw(p => { p.entryForm.sections[1].items = []; }))).includes('element-not-placed'));
  const many = withPw(p => { for (let i = 0; i < 29; i++) p.elements.push({ id: 'e.' + i, type: 'contextual-element', range: '0.1.0' }); });
  assert.ok(codes(await run(many)).includes('too-many-elements'));
});

test('4. an unknown or duplicate section, an outside context element, an unknown field and a bad item are blockers', async () => {
  const r = await run(withPw(p => {
    p.entryForm.sections[0].items.push({ kind: 'section', section: 'core.nope' }, { kind: 'banana' });
    p.entryForm.sections.push({ id: 'exam', label: 'Again', items: [] });
    p.entryForm.sections[1].items[0].fields = ['hr', 'ghost'];
    p.contexts[0].elements.push('outside.el');
  }));
  for (const c of ['section-unknown', 'item-shape', 'section-duplicate', 'field-unknown', 'context-element']) assert.ok(codes(r).includes(c), c);
});

test('5. hostile text in the title, scope and labels is a blocker and is never echoed', async () => {
  const h = '<script>alert(1)</script>';
  const r = await run(withPw(p => { p.manifest.name = h; p.scope = 'go http://evil.example'; p.entryForm.sections[0].label = h; p.contexts[0].label = 'javascript:x'; }));
  for (const c of ['title', 'description', 'text-not-plain']) assert.ok(codes(r).includes(c), c);
  assert.equal(r.blockers.filter(b => b.code === 'text-not-plain').length, 2);
  assert.ok(!/<script|evil\.example|javascript:/.test(JSON.stringify(r.blockers)));
});

test('6. two owners of one concept, and a user with no owner, are concept-owner blockers', async () => {
  const second = clone(USER); delete second.fields[0].ownedBy; second.manifest.id = 'x.second';
  const r = await parsePackage(bundle(TERMS, VITALS, second));
  assert.ok(r.blockers.some(b => b.code === 'concept-owner' && /second-owner/.test(b.message) && /pulse-rate/.test(b.message)));
  const orphan = clone(USER); orphan.fields[0].concept = loc('lonely'); orphan.fields[0].ownedBy = { element: 'gone.el', key: 'k' };
  const r2 = await parsePackage(bundle(TERMS, orphan));
  assert.ok(r2.blockers.some(b => b.code === 'concept-owner' && /needs-owner/.test(b.message)));
  assert.equal(r2.ok, false);
});

test('7. a shared concept with one owner and one user maps to EMR set and field ids', async () => {
  const r = await run(PW, USER);
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  assert.deepEqual(r.conceptMap, [{ concept: 'pulse-rate', owner: { set: 'core-vitals', field: 'hr_bpm' }, users: [{ set: 'x-user', field: 'pulse' }], status: 'ok' }]);
});

test('8. same input gives identical output and the layout holds no number', async () => {
  const b = bundle(TERMS, VITALS, DM, USER, PW);
  assert.equal(JSON.stringify(await parsePackage(b)), JSON.stringify(await parsePackage(clone(b))));
  const w = (await parsePackage(b)).pathways[0];
  assert.equal(JSON.stringify([w.entryForm, w.contexts]).match(/:-?\d/g), null);
});
