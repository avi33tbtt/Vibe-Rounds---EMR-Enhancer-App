'use strict';
// Row R7b: envelope versioning policy (docs/ENVELOPE-VERSIONING.md). Old versions still validate; each section is gated by the version the policy table names; the table matches the schema.
// The frozen files in test/fixtures/envelope/ were made once by the builder for 0.1.0, 0.2.0 and 0.3.0 and are never regenerated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');

const root = path.join(__dirname, '..');
const C = f => JSON.parse(fs.readFileSync(path.join(root, 'contracts', f), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(C('manifest.schema.json'));
const validate = ajv.compile(C('context-envelope.schema.json'));
const frozen = v => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'envelope', `envelope-${v}.json`), 'utf8'));
const doc = fs.readFileSync(path.join(root, 'docs', 'ENVELOPE-VERSIONING.md'), 'utf8');
const VERSIONS = ['0.1.0', '0.2.0', '0.3.0'];
const SECTIONS = ['problems', 'allergies', 'orders', 'results', 'administrations'];
const bump = (v, d) => v.split('.').map((x, i) => (i === 1 ? Number(x) + d : x)).join('.');   // 0.3.0 + 1 -> 0.4.0, 0.2.0 - 1 -> 0.1.0
// The policy table in the doc: version -> sections it adds.
const TABLE = [...doc.matchAll(/^\| (\d+\.\d+\.\d+) \| ([^|]+) \|$/gm)].map(m => [m[1], m[2].trim()]);
const ADDS = Object.fromEntries(TABLE.map(([v, s]) => [v, s.split(',').map(x => x.trim()).filter(x => SECTIONS.includes(x))]));

test('every released version has a frozen example that declares its own version and still validates against the current schema', () => {
  for (const v of VERSIONS) {
    const e = frozen(v);
    assert.equal(e.envelope.version, v, 'the file name and the version agree');
    assert.equal(validate(e), true, v + ': ' + JSON.stringify(validate.errors, null, 1));
    assert.equal(e.inclusions.identity, false); assert.equal(e.inclusions.narrative, false);
  }
});

test('the frozen examples hold the sections their version introduced and none from a later one', () => {
  const floor = s => Object.keys(ADDS).find(v => ADDS[v].includes(s));
  for (const v of VERSIONS) {
    const e = frozen(v);
    for (const s of SECTIONS.filter(x => x in e)) assert.ok(floor(s) <= v, `${v} carries ${s}, which needs ${floor(s)}`);
  }
  assert.ok('problems' in frozen('0.2.0') && 'allergies' in frozen('0.2.0'));
  assert.ok('orders' in frozen('0.3.0') && 'administrations' in frozen('0.3.0'));
  assert.deepEqual(SECTIONS.filter(s => s in frozen('0.1.0')), [], '0.1.0 is the plain shape');
});

test('the policy table in the doc lists every released version and every section, and nothing else', () => {
  assert.deepEqual(TABLE.map(t => t[0]), VERSIONS, 'one row per released version, in order');
  assert.deepEqual(Object.values(ADDS).flat().sort(), [...SECTIONS].sort(), 'each section appears once');
  assert.deepEqual(ADDS['0.1.0'], []);
});

test('each section is refused below the version the table names and accepted at it and after it (the table matches the schema)', () => {
  for (const [v, adds] of Object.entries(ADDS)) for (const s of adds) {
    const mk = ver => { const e = structuredClone(frozen('0.1.0')); e.envelope.version = ver; e[s] = []; return e; };
    const below = mk(bump(v, -1));
    assert.equal(validate(below), false, `${s} under ${bump(v, -1)} must be refused`);
    assert.ok((validate.errors || []).some(x => x.instancePath === '/envelope/version'), `${s}: refused because of the version`);
    for (const ok of [v, bump(v, 1), '0.10.0', '1.0.0']) assert.equal(validate(mk(ok)), true, `${s} under ${ok}: ` + JSON.stringify(validate.errors));
  }
});

test('a real example with its sections is refused when its version is lowered below the lowest covering version', () => {
  const e2 = frozen('0.2.0'); e2.envelope.version = '0.1.0'; assert.equal(validate(e2), false);
  const e3 = frozen('0.3.0'); e3.envelope.version = '0.2.0'; assert.equal(validate(e3), false, 'administrations need 0.3.0');
  const ok3 = frozen('0.3.0'); ok3.envelope.version = '0.4.0'; assert.equal(validate(ok3), true, 'a later minor is still fine');
});

test('the policy rules the tests rely on are written down', () => {
  for (const w of ['Lowest version', 'frozen', 'Breaking change', 'major', 'vendored', 'never hand-edited']) assert.ok(doc.includes(w), 'doc says: ' + w);
});
