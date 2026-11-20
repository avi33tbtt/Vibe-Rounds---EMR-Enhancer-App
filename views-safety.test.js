'use strict';
// node --test views-safety.test.js
// Phase V, V8b: safety tests for view data. Parts 1 and 2 need no database. Part 3 needs DATABASE_URL (creates and drops its own database).
// (The plan names safety.test.js; this is a new file so nothing already called that is overwritten. Rename or merge if you prefer.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { validateView, validatePathwayViews, sumBy } = require('./views.js');

const win = {};
vm.runInNewContext(fs.readFileSync('./element-sets.js', 'utf8'), { window: win });
const SEEDS = JSON.parse(JSON.stringify(win.SEED_SETS));
const KNOWN = new Set(SEEDS.map((s) => s.setId));
const EMR = SEEDS.filter((s) => Array.isArray(s.contexts) && s.contexts.includes('emr'));
const BANNED = ['eval', 'function', 'threshold', 'band', 'dose', 'limit', 'target', 'default', 'auto'];   // key names that would put a clinical number or a filled-in value into view data
const keysDeep = (o, out = []) => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { out.push(k); keysDeep(o[k], out); } return out; };
const strip = (set) => { const c = JSON.parse(JSON.stringify(set)); if (c.view) delete c.view.summary; return c; };

// ---- 1. every seed view block
test('V8b: every seed set with a view block passes validateView with no errors', () => {
  const withView = SEEDS.filter((s) => s.view);
  assert.ok(withView.length >= 3, 'expected several seed sets with a view block');
  for (const s of withView) assert.deepEqual(validateView(s).errors, [], s.setId);
});
test('V8b: no seed view block and no EMR surface or section has a banned key (threshold, band, dose, limit, target, default, auto, eval, function)', () => {
  for (const s of SEEDS) {
    const parts = [['view', s.view]];
    if (EMR.includes(s)) parts.push(['surface', s.surface], ['sections', s.sections]);
    for (const [name, part] of parts) {
      const keys = keysDeep(part).map((k) => k.toLowerCase());
      for (const b of BANNED) assert.ok(!keys.includes(b), `${s.setId} ${name} has key "${b}"`);
    }
  }
});

// ---- 2. EMR view pathways
test('V8b: every seed pathway with contexts "emr" has rules [] and no members, and passes validatePathwayViews', () => {
  assert.ok(EMR.length >= 2, 'expected the ward board and handover pathways');
  for (const p of EMR) {
    assert.equal(p.kind, 'pathway', p.setId);
    assert.deepEqual(p.rules, [], p.setId + ' rules');
    assert.deepEqual(p.members, [], p.setId + ' members');
    assert.deepEqual(validatePathwayViews(p, KNOWN).errors, [], p.setId);
  }
});
test('V8b: removing the whole summary key leaves the set usable', () => {
  const withSummary = SEEDS.filter((s) => s.view && s.view.summary);
  assert.ok(withSummary.length >= 1, 'expected at least one seed set with a summary (the intake and output set)');
  for (const s of withSummary) {
    const c = strip(s);
    assert.equal(c.view.summary, undefined);
    assert.deepEqual(validateView(c).errors, [], s.setId);
    assert.equal(c.view.type, s.view.type, 'the rest of the view is unchanged');
    assert.deepEqual(c.sections, s.sections, 'fields are unchanged');
  }
  assert.deepEqual(sumBy([{ t: new Date().toISOString(), v: '5' }], undefined, 0, Date.now() + 1e6), {}, 'no spec gives no sums');
});

// ---- 3. seeded rows are read-only (database; own database, created and dropped inside the test)
test('V8b: every seeded EMR view pathway is stored as a read-only seed row', async () => {
  try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
  const { Client } = require('pg');
  const { createDb, migrate } = require('./server.js');
  const { seedSets, seedCodeSystems, readSeedSets } = require('./seed.js');
  const { CODE_SYSTEMS } = require('./code-systems.js');
  const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
  const dbName = 'emr_vs_' + crypto.randomBytes(4).toString('hex');
  const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  let owner;
  try {
    owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
    await seedCodeSystems(owner, CODE_SYSTEMS);
    await seedSets(owner, readSeedSets());
    const rows = (await owner.query("SELECT set_id, source, read_only, kind, body FROM element_sets WHERE body->'contexts' ? 'emr' ORDER BY set_id")).rows;
    assert.deepEqual(rows.map((r) => r.set_id), EMR.map((p) => p.setId).sort());
    for (const r of rows) { assert.equal(r.source, 'seed', r.set_id); assert.equal(r.read_only, true, r.set_id); assert.equal(r.kind, 'pathway', r.set_id); assert.deepEqual(r.body.rules, [], r.set_id); }
  } finally {
    if (owner) await owner.close();
    const b = new Client({ connectionString: withDb('postgres') });
    await b.connect(); await b.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await b.end();
  }
});
