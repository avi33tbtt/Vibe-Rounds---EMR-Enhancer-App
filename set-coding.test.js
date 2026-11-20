'use strict';
// node --test set-coding.test.js  (needs DATABASE_URL; creates and drops its own database)
// Phase P, P3b: saving a set and seeding a set check field.coding against code_systems.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const { seedSets } = require('./seed.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const dbName = 'emr_sc_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, admin;

const mk = (setId, coding) => ({ setId, kind: 'custom', body: { title: setId, sections: [{ title: 'S', fields: [{ id: 'f1', label: 'F1', type: 'text', ...(coding === undefined ? {} : { coding }) }] }] } });
const save = (x) => admin.post('/api/element-sets').send(x);

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(dbName)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString()); app = createApp({ db: appDb });
  await owner.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a_admin', 'Name admin', 'admin', await hashPassword(PW)]);
  admin = request.agent(app);
  assert.equal((await admin.post('/api/login').send({ username: 'a_admin', password: PW })).status, 200);
  admin.set('x-csrf-token', (await admin.get('/api/csrf')).body.token);
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('P3b: a set with no coding, with known systems, local and none, or the old attached-code shape is saved', async () => {
  assert.equal((await save(mk('c.none'))).status, 201);
  assert.equal((await save(mk('c.mix', { allow: ['snomed', 'loinc', 'local', 'none'] }))).status, 201);
  assert.equal((await save(mk('c.legacy', { system: 'loinc', code: '8310-5', display: 'x' }))).status, 201);
});
test('P3b: an unknown system or an empty allow list is refused with 422 and the error list; nothing is saved', async () => {
  for (const [id, coding] of [['c.bad1', { allow: ['icd99'] }], ['c.bad2', { allow: [] }], ['c.bad3', { allow: ['snomed'], default: 'snomed' }]]) {
    const r = await save(mk(id, coding));
    assert.equal(r.status, 422, id); assert.equal(r.body.error.code, 'bad_coding'); assert.ok(r.body.errors.length >= 1);
    assert.equal((await owner.query('SELECT count(*)::int n FROM element_sets WHERE set_id=$1', [id])).rows[0].n, 0);
  }
});
test('P3b: a system added to code_systems later is accepted', async () => {
  assert.equal((await save(mk('c.later', { allow: ['mylocal'] }))).status, 422);
  await owner.query("INSERT INTO code_systems (id,uri,name,kind) VALUES ('mylocal','urn:local:mylocal','Mine','local')");
  assert.equal((await save(mk('c.later', { allow: ['mylocal'] }))).status, 201);
});
test('P3b: seeding refuses a seed set with bad coding choices and names the set', async () => {
  const bad = { setId: 'seed.badcoding', kind: 'care', version: 1, title: 'x', sections: [{ title: 'S', fields: [{ id: 'a', label: 'A', type: 'text', coding: { allow: ['nope'] } }] }] };
  await assert.rejects(seedSets(owner, [bad]), /seed\.badcoding.*bad coding choices.*nope/);
  const ok = { ...bad, setId: 'seed.okcoding', sections: [{ title: 'S', fields: [{ id: 'a', label: 'A', type: 'text', coding: { allow: ['snomed', 'none'] } }] }] };
  assert.deepEqual(await seedSets(owner, [ok]), { inserted: 1, unchanged: 0 });
});
