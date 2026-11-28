'use strict';
// Task D2: vendor/ccis/ is a byte copy of CCIS modules at one pinned commit (vendor/ccis/SOURCE.json).
// Pure: no database, no server. Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', 'vendor', 'ccis');
const src = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE.json'), 'utf8'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const EMR_OWNED = ['package.json', 'SOURCE.json', 'README.md'];
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const onDisk = walk(root).map(f => path.relative(root, f).split(path.sep).join('/'))
  .filter(f => !EMR_OWNED.includes(f)).sort();
const load = f => import(pathToFileURL(path.join(root, f)).href);

test('1. every listed file exists and its SHA-256 matches (no hand edit)', () => {
  for (const [f, h] of Object.entries(src.files)) {
    assert.ok(fs.existsSync(path.join(root, f)), 'missing ' + f);
    assert.equal(sha(fs.readFileSync(path.join(root, f))), h, 'changed by hand: ' + f);
  }
});

test('2. files on disk are exactly the 22 listed', () => {
  assert.deepEqual(Object.keys(src.files).sort(), onDisk);
  assert.equal(onDisk.length, 22);
  assert.match(src.commit, /^[0-9a-f]{40}$/);
});

test('3. every relative import stays inside vendor/ccis; the only bare import is node:crypto', () => {
  for (const f of onDisk.filter(x => x !== 'ccis/validators/ccis-validators.js')) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of s.matchAll(/^(?:import|export)\b[^;'"]*?\bfrom\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1] || m[2];
      if (spec.startsWith('.')) {
        assert.ok(fs.existsSync(path.resolve(root, path.dirname(f), spec)), f + ' imports missing ' + spec);
      } else assert.equal(spec, 'node:crypto', f + ' imports ' + spec);
    }
  }
});

test('4. the six entry modules load through import()', async () => {
  for (const f of ['ccis-compile.js', 'ccis-sha256.js', 'ccis-compose.js', 'ccis-compose-group.js', 'ccis-compose-pathway.js', 'ccis-validator.js']) {
    assert.ok(Object.keys(await load(f)).length > 0, f);
  }
});

test('5. canonicalize sorts keys; checksumOf equals the ccis-sha256 result', async () => {
  const c = await load('ccis-compile.js'), s = await load('ccis-sha256.js');
  const r = c.canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] });
  assert.equal(r.ok, true);
  assert.equal(r.text, '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(c.checksumOf(r.text), 'sha256:' + s.createHash('sha256').update(r.text, 'utf8').digest('hex'));
});

test('6. canonicalize of broken JSON text returns ok:false, not a throw', async () => {
  const c = await load('ccis-compile.js');
  assert.equal(c.canonicalize('{').ok, false);
});

test('7. validator has 8 layers; compose entry points are functions', async () => {
  const v = await load('ccis-validator.js');
  assert.equal(v.LAYER_NAMES.length, 8);
  assert.equal(typeof (await load('ccis-compose.js')).conflictReport, 'function');
  assert.equal(typeof (await load('ccis-compose-group.js')).composeGroup, 'function');
  assert.equal(typeof (await load('ccis-compose-pathway.js')).composePathway, 'function');
});

test('8. with CCIS_DIR set, each copy equals the CCIS file byte for byte', { skip: !process.env.CCIS_DIR }, () => {
  for (const f of onDisk) {
    const o = fs.readFileSync(path.join(process.env.CCIS_DIR, f));
    assert.ok(o.equals(fs.readFileSync(path.join(root, f))), 'differs from CCIS: ' + f);
  }
});
