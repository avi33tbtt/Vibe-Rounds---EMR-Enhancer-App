'use strict';
// Task D1: contracts/ is a byte copy of CCIS schemas at one pinned commit (contracts/SOURCE.json).
// Pure: no database, no server. Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv2020 = require('ajv/dist/2020');

const dir = path.join(__dirname, '..', 'contracts');
const read = f => fs.readFileSync(path.join(dir, f));
const json = f => JSON.parse(read(f).toString('utf8'));
const src = json('SOURCE.json');
const onDisk = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'SOURCE.json').sort();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

test('1. every listed file exists and its SHA-256 matches (no hand edit)', () => {
  for (const [f, h] of Object.entries(src.files)) {
    assert.ok(fs.existsSync(path.join(dir, f)), 'missing ' + f);
    assert.equal(sha(read(f)), h, 'changed by hand: ' + f);
  }
});

test('2. SOURCE.json lists exactly the 13 schema files on disk', () => {
  assert.deepEqual(Object.keys(src.files).sort(), onDisk);
  assert.equal(onDisk.length, 13);
});

test('3. every $ref to a schema file resolves inside contracts/', () => {
  for (const f of onDisk) {
    const refs = read(f).toString('utf8').match(/"\$ref":\s*"[^"#]*\.schema\.json/g) || [];
    for (const r of refs) {
      const name = r.replace(/.*\//, '');
      assert.ok(onDisk.includes(name), f + ' refers to ' + name);
    }
  }
});

test('4. all schemas load into one Ajv2020 and compile', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const f of onDisk) ajv.addSchema(json(f));
  for (const f of onDisk) assert.ok(ajv.getSchema(json(f).$id), 'no compile: ' + f);
});

test('5. 0.2.0 markers: types, entryForm, contexts, field concept', () => {
  const m = read('manifest.schema.json').toString('utf8');
  assert.ok(m.includes('"element-group"') && m.includes('"rule-pack"'));
  const p = json('pathway.schema.json');
  assert.ok(p.properties.entryForm && p.properties.contexts);
  assert.ok(read('element.schema.json').toString('utf8').includes('"concept"'));
});

test('6. a synthetic manifest header is accepted; an unknown type is refused', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const f of onDisk) ajv.addSchema(json(f));
  const v = ajv.getSchema(json('manifest.schema.json').$id);
  const head = { id: 'demo.thing', name: 'Demo', type: 'contextual-element', version: '1.0.0',
    publisher: { name: 'Synthetic demo' }, standard: { version: '0.2.0' }, status: 'draft' };
  assert.equal(v(head), true, JSON.stringify(v.errors));
  assert.equal(v({ ...head, type: 'not-a-type' }), false);
});

test('7. SOURCE.json has a 40-hex commit and standard 0.2.0', () => {
  assert.match(src.commit, /^[0-9a-f]{40}$/);
  assert.equal(src.standard, '0.2.0');
});

test('8. with CCIS_DIR set, each copy equals the CCIS file byte for byte', { skip: !process.env.CCIS_DIR }, () => {
  for (const f of onDisk) {
    const o = fs.readFileSync(path.join(process.env.CCIS_DIR, 'ccis', 'schemas', f));
    assert.ok(o.equals(read(f)), 'differs from CCIS: ' + f);
  }
});
