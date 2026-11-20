'use strict';
// node --test elements-codesystem.test.js  (no database)
// Phase P, P5a: a slot may carry codeSystem (default 'any'). 'any' matches with or without codes; a named system is met only when the
// element has a coding in that system, otherwise 'partly' with the reason. Made-up sets only: no real set id or field id.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./elements.js');

const SET = { setId: 'made.up', sections: [{ fields: [
  { id: 'a', type: 'number', unit: 'u1', fhir: { resource: 'Observation' } },   // two codings: snomed and loinc
  { id: 'b', type: 'number', unit: 'u1', fhir: { resource: 'Observation' } },   // one coding: a local system
  { id: 'c', type: 'number', unit: 'u1', fhir: { resource: 'Observation' } },   // no coding
  { id: 'd', type: 'number', unit: 'u2', fhir: { resource: 'Observation' } },   // no coding, other unit
] }] };
const BIND = [
  { set_id: 'made.up', field_id: 'a', system: 'snomed', code: '111111' },
  { set_id: 'made.up', field_id: 'a', system: 'loinc', code: '1-1' },
  { set_id: 'made.up', field_id: 'b', system: 'ward-x', code: 'L1' },
];
const prov = (bindings) => E.providesOf(SET, bindings);
const one = (slot, bindings, manual) => E.compatibility([Object.assign({ slot: 's', role: 'quantity' }, slot)], prov(bindings), manual).slots[0];
const ids = (r) => r.matched.map((m) => m.fieldId).sort();

test('P5a: codeSystem "any" and no codeSystem match with or without codes, and give the same result', () => {
  const none = one({}, BIND), any = one({ codeSystem: 'any' }, BIND);
  assert.equal(any.status, 'met'); assert.deepEqual(ids(any), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(none), ids(any));
  assert.equal(one({ codeSystem: 'any' }, []).status, 'met', 'met even when no field has any code');
  assert.equal(one({ codeSystem: '' }, BIND).status, 'met', 'an empty codeSystem is the same as any');
});
test('P5a: a named system is met only by fields that carry a code in it', () => {
  const r = one({ codeSystem: 'snomed' }, BIND);
  assert.equal(r.status, 'met'); assert.deepEqual(ids(r), ['a']);
  assert.match(r.matched[0].basis, /code system snomed/);
  assert.deepEqual(ids(one({ codeSystem: 'loinc' }, BIND)), ['a'], 'a field with several codings meets each of its systems');
  assert.deepEqual(ids(one({ codeSystem: 'ward-x' }, BIND)), ['b'], 'a local system id works the same way');
});
test('P5a: a named system nobody carries is partly met, with the reason, and nothing is made up', () => {
  const r = one({ codeSystem: 'icd10' }, BIND);
  assert.equal(r.status, 'partly'); assert.deepEqual(r.matched, []);
  assert.deepEqual(r.partial.map((p) => p.fieldId).sort(), ['a', 'b', 'c', 'd']);
  const c = r.partial.find((p) => p.fieldId === 'c'), a = r.partial.find((p) => p.fieldId === 'a');
  assert.match(c.differs[0], /needs icd10.*field has none/); assert.match(a.differs[0], /field has snomed, loinc/);
  assert.match(c.basis, /^role matches; /);
});
test('P5a: no codes at all: a named system is partly met, any is met, and no code appears in the result', () => {
  assert.equal(one({ codeSystem: 'snomed' }, []).status, 'partly');
  assert.equal(one({ codeSystem: 'any' }, []).status, 'met');
  assert.ok(prov([]).every((e) => e.system === null && e.code === null && e.key.endsWith(' | -')));
});
test('P5a: partly becomes met when another field has the system; a field that lacks it is not listed as partial then', () => {
  const r = one({ codeSystem: 'ward-x' }, BIND);
  assert.equal(r.status, 'met'); assert.deepEqual(r.partial, []);
});
test('P5a: unit and code system are judged separately and each reason is listed; the unit rule is unchanged', () => {
  const r = one({ unit: 'u2', codeSystem: 'snomed' }, BIND);   // a has snomed but unit u1; d has unit u2 but no code; c has neither
  assert.equal(r.status, 'partly'); assert.deepEqual(r.matched, []);
  const by = (id) => r.partial.find((p) => p.fieldId === id).differs;
  assert.equal(by('a').length, 1); assert.match(by('a')[0], /^unit differs/);
  assert.equal(by('d').length, 1); assert.match(by('d')[0], /^code system differs/);
  assert.equal(by('c').length, 2);
  assert.equal(one({ unit: 'u1' }, BIND).status, 'met', 'a unit alone behaves as before');
});
test('P5a: a manual binding is still honoured when the named system is missing', () => {
  const r = one({ codeSystem: 'icd10' }, BIND, [{ slot: 's', fieldId: 'c' }]);
  assert.equal(r.status, 'met'); assert.equal(r.matched[0].fieldId, 'c'); assert.equal(r.matched[0].basis, 'bound by hand');
});
