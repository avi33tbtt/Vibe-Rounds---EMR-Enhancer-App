'use strict';
// Task D5: package bundle -> draft set proposals and blockers. Pure: no database, no server.
// Fixtures are small hand-written synthetic documents, checksummed with the vendored CCIS code. Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parsePackage, PackageImportError, LIMITS } = require('../package-import');

let C;
test.before(async () => { C = await import(pathToFileURL(path.join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href); });
const sum = doc => C.checksumOf(C.canonicalize(doc).text);
const art = doc => ({ checksum: sum(doc), document: doc });
const clone = x => JSON.parse(JSON.stringify(x));
const man = (id, type, name) => ({ id, name, type, version: '0.1.0', status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } });
const loc = code => ({ codeSystem: { id: 'local', version: '0.1.0' }, code, mapping: { status: 'mapped' } });

const TERMS = { manifest: man('t.terms', 'terminology-package', 'Terms'), codeSystem: { id: 'local', version: '0.1.0' },
  concepts: [{ key: 'pulse-rate', display: 'Pulse rate' }, { key: 'dm-type.t1', display: 'Type 1' }, { key: 'dm-type.t2', display: 'Type 2' }],
  valueSets: [{ id: 't.dm-type', version: '0.1.0', display: 'Diabetes type', members: [{ key: 'dm-type.t1' }, { key: 'dm-type.t2' }] }] };
const VITALS = { manifest: man('core.vitals', 'contextual-element', 'Vitals'), intent: { purpose: 'Record vital signs.' }, provenance: { origin: 'x', basis: 'Synthetic basis.' },
  fields: [
    { key: 'hr', label: 'Heart rate', type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 'unbounded' }, concept: loc('pulse-rate'), 'x-emrFieldId': 'hr_bpm' },
    { key: 'note', label: 'Note', type: 'string', cardinality: { min: 1, max: 1 } }] };
const DM = { manifest: man('dm.core', 'contextual-element', 'Diabetes core'), intent: { purpose: 'Diabetes basics.' },
  fields: [{ key: 'dmType', label: 'Type of diabetes', type: 'code', cardinality: { min: 0, max: 1 }, binding: { ...loc('dm-type'), valueSet: { id: 't.dm-type', version: '0.1.0' } } }] };
const bundle = (...docs) => ({ format: 'ccis-package-bundle/1', artefacts: docs.map(art) });
const withField = (extra, base = VITALS) => { const d = clone(base); d.fields.push({ key: 'extra', label: 'Extra', type: 'string', cardinality: { min: 0, max: 1 }, ...extra }); return d; };
const blockerCodes = r => r.blockers.map(b => b.code);

test('1. a valid bundle gives draft set proposals with bare-hex source checksums', async () => {
  const r = await parsePackage(bundle(TERMS, VITALS, DM));
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  assert.deepEqual(r.proposals.map(p => p.slug), ['core-vitals', 'dm-core']);
  const v = r.proposals[0];
  assert.equal(v.draft, true); assert.equal(v.setKind, 'custom');
  assert.deepEqual(v.definition.fields[0], { id: 'hr_bpm', label: 'Heart rate', type: 'number', unit: '/min', repeat: true, concept: 'pulse-rate' });
  assert.equal(v.definition.fields[1].required, true);
  assert.equal(v.definition.citation, 'Synthetic basis.');
  assert.match(v.source.checksum, /^[0-9a-f]{64}$/);
  assert.equal(v.source.checksum, sum(VITALS).slice(7));
  assert.deepEqual(r.proposals[1].definition.fields[0].options, ['Type 1', 'Type 2']);
  assert.equal(r.proposals[1].definition.fields[0].type, 'select');
});

test('2. a changed document is a checksum blocker and is not read; the others still convert', async () => {
  const b = bundle(TERMS, VITALS, DM);
  b.artefacts[1].document.manifest.name = 'Vitals changed';
  const r = await parsePackage(b);
  assert.equal(r.ok, false);
  assert.deepEqual(blockerCodes(r), ['checksum']);
  assert.deepEqual(r.proposals.map(p => p.slug), ['dm-core']);
  assert.equal(r.counts.verified, 2);
});

test('3. two units, a count above 1 and a code field without a value set are named blockers', async () => {
  const two = await parsePackage(bundle(TERMS, withField({ type: 'quantity', units: ['mg', 'g'] })));
  assert.ok(blockerCodes(two).includes('units-many'));
  const many = await parsePackage(bundle(TERMS, withField({ cardinality: { min: 0, max: 3 } })));
  assert.ok(blockerCodes(many).includes('cardinality'));
  const noSet = await parsePackage(bundle(TERMS, withField({ type: 'code', binding: { ...loc('x'), valueSet: { id: 'nope', version: '0.1.0' } } })));
  assert.ok(blockerCodes(noSet).includes('value-set'));
  assert.equal(noSet.proposals[0].ready, false);
});

test('4. hostile text is a blocker and is never echoed in a message', async () => {
  const hostile = ['<script>alert(1)</script>', 'see javascript:alert(1)', 'go http://evil.example/x', 'bad\u0001char'];
  for (const h of hostile) {
    const d = withField({ label: h }); d.manifest.name = 'Vitals ' + h; d.fields.push({ key: 'o', label: 'O', type: 'string', cardinality: { min: 0, max: 1 } });
    const r = await parsePackage(bundle(TERMS, d));
    assert.equal(r.ok, false, h);
    assert.ok(blockerCodes(r).includes('text-not-plain') && blockerCodes(r).includes('title'), h);
    assert.ok(!JSON.stringify(r.blockers).includes(h.slice(0, 8)), 'message echoes the text: ' + h);
  }
  const badOption = clone(TERMS); badOption.concepts[1].display = '<b>x</b>';
  assert.ok(blockerCodes(await parsePackage(bundle(badOption, DM))).includes('option-text'));
});

test('5. a non-local concept system is a blocker; a local concept becomes a plain key', async () => {
  const d = clone(VITALS); d.fields[0].concept = { ...loc('pulse-rate'), codeSystem: { id: 'snomed', version: '1' } };
  const r = await parsePackage(bundle(TERMS, d));
  assert.ok(blockerCodes(r).includes('concept-system'));
  const ok = await parsePackage(bundle(TERMS, VITALS));
  assert.equal(ok.proposals[0].definition.fields[0].concept, 'pulse-rate');
  assert.deepEqual(ok.proposals[0].concepts, [{ concept: 'pulse-rate', field: 'hr_bpm' }]);
});

test('6. slug and field id mapping: dot to hyphen, x-emrFieldId wins, an invalid result is a blocker', async () => {
  const r = await parsePackage(bundle(TERMS, VITALS));
  assert.equal(r.proposals[0].slug, 'core-vitals');
  assert.equal(r.proposals[0].definition.fields[0].id, 'hr_bpm');
  assert.equal(r.proposals[0].definition.fields[1].id, 'note');
  const badSlug = clone(VITALS); badSlug.manifest.id = 'Core.Vitals';
  assert.ok(blockerCodes(await parsePackage(bundle(TERMS, badSlug))).includes('slug'));
  const badId = withField({ 'x-emrFieldId': 'has space' });
  assert.ok(blockerCodes(await parsePackage(bundle(TERMS, badId))).includes('field-id'));
  const dup = clone(DM); dup.manifest.id = 'core-vitals';
  assert.ok(blockerCodes(await parsePackage(bundle(TERMS, VITALS, dup))).includes('slug-duplicate'));
});

test('7. the set rules decide: a refused definition is a blocker and no proposal holds a number', async () => {
  const d = clone(VITALS); d.fields[1].type = 'code'; d.fields[1].binding = { ...loc('x'), valueSet: { id: 't.dm-type', version: '0.1.0' } };
  const many = clone(TERMS); many.valueSets[0].members = Array.from({ length: 101 }, (_, i) => { many.concepts.push({ key: 'm.' + i, display: 'M' + i }); return { key: 'm.' + i }; });
  const r = await parsePackage(bundle(many, d));
  assert.ok(blockerCodes(r).includes('definition'), JSON.stringify(blockerCodes(r)));
  const good = await parsePackage(bundle(TERMS, VITALS, DM));
  const nums = JSON.stringify(good.proposals.map(p => p.definition)).match(/:-?\d/g);
  assert.equal(nums, null);
});

test('8. same input gives identical output; a wrong format, 61 artefacts or an empty bundle is a hard error', async () => {
  const b = bundle(TERMS, VITALS, DM);
  assert.equal(JSON.stringify(await parsePackage(b)), JSON.stringify(await parsePackage(clone(b))));
  await assert.rejects(parsePackage({ format: 'other', artefacts: [] }), PackageImportError);
  await assert.rejects(parsePackage({ format: 'ccis-package-bundle/1', artefacts: [] }), PackageImportError);
  await assert.rejects(parsePackage({ format: 'ccis-package-bundle/1', artefacts: Array.from({ length: LIMITS.artefacts + 1 }, () => art(TERMS)) }), /at most 60/);
  await assert.rejects(parsePackage(null), PackageImportError);
});
