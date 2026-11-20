'use strict';
// node --test bindings-multi.test.js  (needs DATABASE_URL; creates and drops its own database)
// Phase P, P2b: one binding per (set, field, system); a system the field's coding.allow does not list is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const dbName = 'emr_bm_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, admin;

const mkSet = (setId, fields) => ({ setId, kind: 'custom', version: 1, title: setId, sections: [{ title: 'S', fields }] });
async function addSet(body) {
  await owner.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier,content_hash) VALUES ($1,1,'custom',$2,'user',false,'local-draft',$3)`,
    [body.setId, JSON.stringify(body), crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')]);
}
const put = (setId, fieldId, system, code, display = 'd') => admin.put('/api/bindings').send({ setId, fieldId, system, code, display });
const list = async (setId) => (await admin.get('/api/bindings')).body.filter((b) => b.setId === setId);

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
  await addSet(mkSet('t.both', [{ id: 'f1', label: 'F1', type: 'text', coding: { allow: ['snomed', 'loinc'] } }]));
  await addSet(mkSet('t.loinc', [{ id: 'f1', label: 'F1', type: 'text', coding: { allow: ['loinc'] } }]));
  await addSet(mkSet('t.none', [{ id: 'f1', label: 'F1', type: 'text', coding: { allow: ['none'] } }]));
  await addSet(mkSet('t.legacy', [{ id: 'f1', label: 'F1', type: 'text', coding: { system: 'loinc', code: '8310-5', display: 'x' } }]));
  await addSet(mkSet('t.plain', [{ id: 'f1', label: 'F1', type: 'text' }]));
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('P2b: two systems on one field are both kept', async () => {
  assert.equal((await put('t.both', 'f1', 'snomed', '386661006')).status, 200);
  assert.equal((await put('t.both', 'f1', 'loinc', '8310-5')).status, 200);
  assert.deepEqual((await list('t.both')).map((b) => b.system).sort(), ['loinc', 'snomed']);
});
test('P2b: putting the same system again updates that binding and adds no row; each write is audited', async () => {
  const before = Number((await owner.query("SELECT count(*) n FROM audit_log WHERE action='binding.set'")).rows[0].n);
  assert.equal((await put('t.both', 'f1', 'snomed', '386661007', 'new')).status, 200);
  const rows = await list('t.both');
  assert.equal(rows.length, 2); assert.equal(rows.find((b) => b.system === 'snomed').code, '386661007');
  assert.equal(Number((await owner.query("SELECT count(*) n FROM audit_log WHERE action='binding.set'")).rows[0].n), before + 1);
});
test('P2b: a system the field does not list is refused with a plain sentence, and nothing is saved', async () => {
  const r = await put('t.loinc', 'f1', 'snomed', '386661006');
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'coding_not_allowed');
  assert.equal((await list('t.loinc')).length, 0);
  assert.equal((await put('t.loinc', 'f1', 'loinc', '8310-5')).status, 200);
});
test('P2b: a field whose coding is only none refuses every system', async () => {
  assert.equal((await put('t.none', 'f1', 'loinc', '8310-5')).status, 422);
  assert.equal((await list('t.none')).length, 0);
});
test('P2b: a field with no coding block, and a set not on the server, behave as before', async () => {
  assert.equal((await put('t.plain', 'f1', 'loinc', '8310-5')).status, 200);
  assert.equal((await put('t.missing', 'f1', 'snomed', '386661006')).status, 200);
});
test('P2b: delete with ?system= removes one binding; without it removes the field\'s bindings', async () => {
  assert.equal((await admin.delete('/api/bindings/t.both/f1?system=loinc')).status, 204);
  assert.deepEqual((await list('t.both')).map((b) => b.system), ['snomed']);
  assert.equal((await admin.delete('/api/bindings/t.both/f1?system=nope')).status, 400);
  assert.equal((await admin.delete('/api/bindings/t.both/f1')).status, 204);
  assert.equal((await list('t.both')).length, 0);
});
test('P2b: a field carrying the old {system, code, display} coding shape is not refused', async () => {
  assert.equal((await put('t.legacy', 'f1', 'snomed', '386661006')).status, 200);
});
