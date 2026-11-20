'use strict';
// node --test validate-coding.test.js  (no database needed)
// Phase P, P2a: validateCoding(field, knownSystems). Made-up fields and a made-up system list; no seed set or field id is named.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { validateCoding, validateSetCoding, codingAllow } = require('./views.js');

const KNOWN = ['alpha', 'beta'];
const f = (coding) => ({ id: 'x_field', label: 'X', type: 'text', ...(coding === undefined ? {} : { coding }) });
const errs = (coding, known = KNOWN) => validateCoding(f(coding), known).errors;

test('P2a: a field with no coding block is valid and means none', () => {
  assert.deepEqual(errs(undefined), []);
  assert.deepEqual(codingAllow(f()), ['none']);
});
test('P2a: any mix of known systems, local and none is accepted; known systems may be a Set or objects', () => {
  assert.deepEqual(errs({ allow: ['alpha', 'beta', 'local', 'none'] }), []);
  assert.deepEqual(errs({ allow: ['alpha'] }, new Set(['alpha'])), []);
  assert.deepEqual(errs({ allow: ['alpha'] }, [{ id: 'alpha' }]), []);
  assert.deepEqual(codingAllow(f({ allow: ['beta', 'local'] })), ['beta', 'local']);
});
test('P2a: an unknown system id is refused and named', () => {
  const e = errs({ allow: ['alpha', 'zzz'] });
  assert.equal(e.length, 1); assert.match(e[0], /unknown code system "zzz"/);
  assert.equal(errs({ allow: ['alpha'] }, []).length, 1);   // no known systems given: a named system is unknown
});
test('P2a: an empty or missing allow list is refused', () => {
  assert.equal(errs({ allow: [] }).length, 1);
  assert.equal(errs({}).length, 1);
  assert.equal(errs({ allow: 'alpha' }).length, 1);
  assert.equal(errs({ allow: [''] }).length, 1);
  assert.equal(errs({ allow: [5] }).length, 1);
});
test('P2a: keys named default or auto are refused, at any depth', () => {
  assert.ok(errs({ allow: ['alpha'], default: 'alpha' }).some((m) => /"coding\.default" is not allowed/.test(m)));
  assert.ok(errs({ allow: ['alpha'], auto: true }).some((m) => /"coding\.auto" is not allowed/.test(m)));
  assert.ok(errs({ allow: ['alpha'], nested: { Auto: 1 } }).some((m) => /not allowed/.test(m)));
});
test('P2a: an unknown key and a non-object coding are refused', () => {
  assert.ok(errs({ allow: ['alpha'], code: '123' }).some((m) => /unknown key "code"/.test(m)));
  assert.equal(errs('alpha').length, 1);
  assert.equal(errs(['alpha']).length, 1);
});
test('P2a: every real seed field is still valid (none carries a coding block yet)', () => {
  const sb = { window: {} }; vm.createContext(sb); vm.runInContext(fs.readFileSync(__dirname + '/element-sets.js', 'utf8'), sb);
  let n = 0;
  for (const s of sb.window.SEED_SETS) for (const sec of s.sections || []) for (const fl of sec.fields || []) { n++; assert.deepEqual(validateCoding(fl, KNOWN).errors, []); }
  assert.ok(n > 0);
});
test('P2a: the legacy client shape {system, code, display} is not treated as a choice block', () => {
  assert.deepEqual(errs({ system: 'loinc', code: '8310-5', display: 'Body temperature' }), []);
  assert.ok(errs({ code: '1', allow: [] }).some((m) => /non-empty list/.test(m)));   // once allow is present it is checked
});
test('P3b: validateSetCoding checks every field of every section and of a top-level list', () => {
  const set = { sections: [{ fields: [f({ allow: ['alpha'] }), { id: 'y', type: 'text', coding: { allow: ['zzz'] } }] }], fields: [{ id: 'z', type: 'text', coding: { allow: [] } }] };
  assert.equal(validateSetCoding(set, KNOWN).errors.length, 2);
  assert.deepEqual(validateSetCoding({ sections: [{ fields: [f()] }] }, KNOWN).errors, []);
  assert.deepEqual(validateSetCoding(null, KNOWN).errors, []);
});
