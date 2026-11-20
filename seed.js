'use strict';
// One-time (re-runnable) seed: loads element-sets.js (window.SEED_SETS) into element_sets as read-only seed rows.
// Usage: node seed.js     Seeds are never editable through the API (403).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { hashOf } = require('./api.js');
const { validateView, validatePathwayViews, validateSetCoding, validateAccess } = require('./views.js');
const { ROLES } = require('./permissions.js');

function readSeedSets(file = path.join(__dirname, 'element-sets.js')) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { timeout: 2000 });   // plain data script, no network or fs in the sandbox
  const sets = sandbox.window.SEED_SETS;
  if (!Array.isArray(sets)) throw new Error('element-sets.js did not define window.SEED_SETS');
  return sets;
}
async function seedSets(db, sets) {
  const out = { inserted: 0, unchanged: 0 };
  const knownIds = new Set(sets.map((x) => x && x.setId));
  await db.withTx(async (c) => {
    const systems = (await c.query('SELECT id FROM code_systems')).rows.map((x) => x.id);   // P3b: coding choices are checked against the code_systems table
    for (const s of sets) {
      if (!s || !/^[A-Za-z0-9_.-]{1,100}$/.test(s.setId || '') || !['care', 'template', 'disease', 'custom', 'pathway'].includes(s.kind)) throw new Error('Bad seed set: ' + (s && s.setId));
      const vv = validateView(s);
      if (vv.errors.length) throw new Error(`Seed set ${s.setId} has a bad view: ${vv.errors.join('; ')}`);
      const av = validateAccess(s, ROLES);                                  // R5: no access block, no seed (default deny)
      if (av.errors.length) throw new Error(`Seed set ${s.setId} has a bad access block: ${av.errors.join('; ')}`);
      const cv = validateSetCoding(s, systems);
      if (cv.errors.length) throw new Error(`Seed set ${s.setId} has bad coding choices: ${cv.errors.join('; ')}`);
      const pv = validatePathwayViews(s, knownIds);
      if (pv.errors.length) throw new Error(`Seed pathway ${s.setId} has a bad view surface: ${pv.errors.join('; ')}`);
      const version = Number.isInteger(s.version) && s.version >= 1 ? s.version : 1, h = hashOf(s);
      const cur = (await c.query('SELECT content_hash FROM element_sets WHERE set_id=$1 AND version=$2', [s.setId, version])).rows[0];
      if (cur) {
        if (cur.content_hash !== h) throw new Error(`Seed set ${s.setId} v${version} changed: bump its version instead of editing it`);
        out.unchanged++; continue;
      }
      await c.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier,content_hash) VALUES ($1,$2,$3,$4,'seed',true,'local-reviewed',$5)`,
        [s.setId, version, s.kind, JSON.stringify(s), h]);
      out.inserted++;
    }
  });
  return out;
}
// P1b: fills code_systems from code-systems.js. Safe to re-run. Adds missing systems, fills name, URI and licence note on standard ones
// (009 created snomed and loinc without a note), and never touches a local system or adds any code.
async function seedCodeSystems(db, list) {
  const out = { inserted: 0, updated: 0, unchanged: 0 };
  await db.withTx(async (c) => {
    for (const x of list) {
      if (!x || x.kind !== 'standard' || !/^[a-z0-9][a-z0-9_.-]{0,39}$/.test(x.id || '') || !x.uri || !x.name) throw new Error('Bad code system: ' + (x && x.id));
      const cur = (await c.query('SELECT uri, name, kind, licence_note FROM code_systems WHERE id=$1', [x.id])).rows[0];
      if (!cur) {
        await c.query('INSERT INTO code_systems (id,uri,name,kind,licence_note) VALUES ($1,$2,$3,$4,$5)', [x.id, x.uri, x.name, x.kind, x.licence_note || null]);
        out.inserted++;
      } else if (cur.kind === 'standard' && (cur.uri !== x.uri || cur.name !== x.name || cur.licence_note !== (x.licence_note || null))) {
        await c.query('UPDATE code_systems SET uri=$2, name=$3, licence_note=$4 WHERE id=$1', [x.id, x.uri, x.name, x.licence_note || null]);
        out.updated++;
      } else out.unchanged++;
    }
  });
  return out;
}
module.exports = { readSeedSets, seedSets, seedCodeSystems };

if (require.main === module) {
  const { loadConfig, createDb } = require('./server.js');
  (async () => {
    try { process.loadEnvFile && fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
    const db = createDb(loadConfig().databaseUrl);
    console.log(await seedCodeSystems(db, require('./code-systems.js').CODE_SYSTEMS));   // first, so seed sets can name these systems
    console.log(await seedSets(db, readSeedSets()));
    await db.close();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
