'use strict';
// node --test code-systems-seed.test.js  (needs DATABASE_URL; creates and drops its own database)
// Phase P, P1b: seeding the code systems is re-runnable, adds no codes, and never touches a local system.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createDb, migrate } = require('./server.js');
const { seedCodeSystems } = require('./seed.js');
const { CODE_SYSTEMS } = require('./code-systems.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const name = 'emr_cs_s_' + crypto.randomBytes(4).toString('hex');
let db;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name)); await migrate(db, __dirname);
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('P1b: the data holds only id, uri, name, kind and licence_note, and no code', () => {
  assert.equal(CODE_SYSTEMS.length, 5);
  for (const x of CODE_SYSTEMS) assert.deepEqual(Object.keys(x).sort(), ['id', 'kind', 'licence_note', 'name', 'uri']);
});

test('P1b: first run fills the notes on snomed and loinc and adds the other three', async () => {
  assert.deepEqual(await seedCodeSystems(db, CODE_SYSTEMS), { inserted: 3, updated: 2, unchanged: 0 });
  const r = (await db.query('SELECT id, kind, licence_note FROM code_systems ORDER BY id')).rows;
  assert.deepEqual(r.map((x) => x.id), ['icd10', 'icd11', 'loinc', 'snomed', 'ucum']);
  assert.ok(r.every((x) => x.kind === 'standard' && x.licence_note));
});

test('P1b: seeding twice adds and changes nothing, and verified_codes stays empty', async () => {
  assert.deepEqual(await seedCodeSystems(db, CODE_SYSTEMS), { inserted: 0, updated: 0, unchanged: 5 });
  assert.equal((await db.query('SELECT count(*)::int n FROM code_systems')).rows[0].n, 5);
  assert.equal((await db.query('SELECT count(*)::int n FROM verified_codes')).rows[0].n, 0);
});

test('P1b: a local system with the same id is left alone', async () => {
  await db.query("INSERT INTO code_systems (id,uri,name,kind) VALUES ('mylocal','urn:local:mylocal','Mine','local')");
  await seedCodeSystems(db, CODE_SYSTEMS);
  assert.deepEqual((await db.query("SELECT uri, name, kind FROM code_systems WHERE id='mylocal'")).rows[0], { uri: 'urn:local:mylocal', name: 'Mine', kind: 'local' });
});
