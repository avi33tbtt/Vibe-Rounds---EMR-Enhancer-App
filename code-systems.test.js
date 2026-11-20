'use strict';
// node --test code-systems.test.js  (needs DATABASE_URL; creates and drops its own databases)
// Phase P, P1a: migration 009 adds code_systems and a foreign key from verified_codes.system. Fresh and upgrade both pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createDb, migrate } = require('./server.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const sfx = crypto.randomBytes(4).toString('hex');
const freshName = 'emr_cs_f_' + sfx, upName = 'emr_cs_u_' + sfx;
let fresh, up, tmp;

async function makeDb(name) {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  return createDb(withDb(name));
}
async function dropDb(name) {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
}

test.before(async () => {
  fresh = await makeDb(freshName);
  await migrate(fresh, __dirname);
  // upgrade case: only the migrations before 009 first, with data in verified_codes, then the full set
  up = await makeDb(upName);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-mig-'));
  for (const f of fs.readdirSync(__dirname).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f) && f.slice(0, 3) < '009')) {
    fs.copyFileSync(path.join(__dirname, f), path.join(tmp, f));
  }
  await migrate(up, tmp);
  await up.query("INSERT INTO verified_codes (system,code,display) VALUES ('snomed','386661006','Fever'), ('xyz','1','Old row')");
  await migrate(up, __dirname);
});
test.after(async () => {
  if (fresh) await fresh.close();
  if (up) await up.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  await dropDb(freshName); await dropDb(upName);
});

test('P1a fresh: snomed and loinc are seeded as standard systems, no codes exist', async () => {
  const r = await fresh.query('SELECT id, uri, kind FROM code_systems ORDER BY id');
  assert.deepEqual(r.rows.map((x) => [x.id, x.kind]), [['loinc', 'standard'], ['snomed', 'standard']]);
  assert.equal((await fresh.query('SELECT count(*)::int n FROM verified_codes')).rows[0].n, 0);
});

test('P1a fresh: a code with an unknown system is refused by the foreign key', async () => {
  await assert.rejects(fresh.query("INSERT INTO verified_codes (system,code,display) VALUES ('nope','1','x')"), (e) => e.code === '23503');
  await fresh.query("INSERT INTO verified_codes (system,code,display) VALUES ('loinc','8310-5','Body temperature')");
});

test('P1a fresh: kind is limited to standard or local, and ids and URIs are unique', async () => {
  await assert.rejects(fresh.query("INSERT INTO code_systems (id,uri,name,kind) VALUES ('bad','urn:x','Bad','other')"), (e) => e.code === '23514');
  await assert.rejects(fresh.query("INSERT INTO code_systems (id,uri,name,kind) VALUES ('snomed','urn:y','Dup','local')"), (e) => e.code === '23505');
});

test('P1a upgrade: existing rows survive, and a system the app never listed becomes a local system', async () => {
  const codes = (await up.query('SELECT system, code, display FROM verified_codes ORDER BY system')).rows;
  assert.deepEqual(codes.map((x) => x.system + '/' + x.code), ['snomed/386661006', 'xyz/1']);
  const xyz = (await up.query("SELECT uri, kind FROM code_systems WHERE id='xyz'")).rows[0];
  assert.deepEqual(xyz, { uri: 'urn:local:xyz', kind: 'local' });
  assert.equal((await up.query("SELECT kind FROM code_systems WHERE id='snomed'")).rows[0].kind, 'standard');
});

test('P1a upgrade: running migrate again applies nothing', async () => {
  assert.deepEqual(await migrate(up, __dirname), []);
});

test('P1a: emr_app can read and write code_systems', async () => {
  const r = (await fresh.query("SELECT has_table_privilege('emr_app','code_systems','SELECT') s, has_table_privilege('emr_app','code_systems','INSERT') i")).rows[0];
  assert.deepEqual(r, { s: true, i: true });
});
