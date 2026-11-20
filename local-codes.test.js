'use strict';
// node --test local-codes.test.js  (needs DATABASE_URL; creates and drops its own database)
// Phase P, P4a: local code systems. A local code is typed in unverified, joins verified_codes only through the verify route, and is never
// accepted by the standard routes. Only an admin or informatician creates a system or adds a code; a verifier may also be a doctor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const { seedCodeSystems } = require('./seed.js');
const { CODE_SYSTEMS } = require('./code-systems.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const dbName = 'emr_lc_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, hash;
const who = {};

async function mk(role) {
  await owner.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a_' + role, 'Name ' + role, role, hash]);
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/login').send({ username: 'a_' + role, password: PW })).status, 200);
  agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
  return agent;
}
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
const since = async (id) => (await owner.query("SELECT * FROM audit_log WHERE id > $1 AND action NOT LIKE 'auth.%' ORDER BY id", [id])).rows;
const count = async (sql, p) => Number((await owner.query(sql, p)).rows[0].n);

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
  await seedCodeSystems(owner, CODE_SYSTEMS);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(dbName)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString()); app = createApp({ db: appDb });
  hash = await hashPassword(PW);
  for (const role of P.ROLES) who[role] = await mk(role);
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('P4a: nothing is pre-filled: no local code exists on a fresh database', async () => {
  assert.equal(await count('SELECT count(*) n FROM local_codes'), 0);
  assert.equal(await count("SELECT count(*) n FROM code_systems WHERE kind='local'"), 0);
});
test('P4a: routes are mapped to actions; creating and adding are admin and informatician only; verifying is code.write', () => {
  assert.equal(P.ROUTE_ACTIONS['POST /code-systems'], 'codesystem.write');
  assert.equal(P.ROUTE_ACTIONS['POST /code-systems/:id/codes'], 'codesystem.write');
  assert.equal(P.ROUTE_ACTIONS['POST /code-systems/:id/codes/:code/verify'], 'code.write');
  assert.equal(P.ROUTE_ACTIONS['GET /code-systems/:id/codes'], 'ref.read');
  assert.deepEqual(P.ACTIONS['codesystem.write'], ['admin', 'informatician']);
});

test('P4a: role matrix for create, add, verify and read', async () => {
  const mayCreate = new Set(['admin', 'informatician']), mayVerify = new Set(['admin', 'doctor', 'informatician']);
  assert.equal((await who.admin.post('/api/code-systems').send({ id: 'ward-a', name: 'Ward A' })).status, 201);
  for (const role of P.ROLES) {
    const c = await who[role].post('/api/code-systems').send({ id: 'rm-' + role, name: 'x' });
    assert.equal(c.status, mayCreate.has(role) ? 201 : 403, 'create ' + role);
    if (!mayCreate.has(role)) assert.equal(c.body.error.action, 'codesystem.write', role);
    const a = await who[role].post('/api/code-systems/ward-a/codes').send({ code: 'C-' + role, display: 'Code ' + role });
    assert.equal(a.status, mayCreate.has(role) ? 201 : 403, 'add ' + role);
  }
  await who.admin.post('/api/code-systems/ward-a/codes').send({ code: 'V1', display: 'For verifying' });
  for (const role of P.ROLES) {
    await who.admin.post('/api/code-systems/ward-a/codes').send({ code: 'V-' + role, display: 'Verify ' + role });
    const v = await who[role].post(`/api/code-systems/ward-a/codes/V-${role}/verify`).send({});
    assert.equal(v.status, mayVerify.has(role) ? 200 : 403, 'verify ' + role);
    assert.equal((await who[role].get('/api/code-systems/ward-a/codes')).status, 200, 'read ' + role);
  }
  assert.equal((await request(app).get('/api/code-systems/ward-a/codes')).status, 401);
});

test('P4a: input checks: reserved and malformed ids, extra fields, duplicates, bad code text', async () => {
  const a = who.admin;
  for (const id of ['local', 'none', 'any', 'Upper', 'x', '1abc', 'has space', 'a/b']) assert.equal((await a.post('/api/code-systems').send({ id, name: 'n' })).status, 400, id);
  assert.equal((await a.post('/api/code-systems').send({ id: 'ok-1', name: 'n', extra: 1 })).status, 400, 'strict body');
  assert.equal((await a.post('/api/code-systems').send({ id: 'ok-2', name: 'n', uri: 'no scheme' })).status, 400, 'uri needs a scheme');
  assert.equal((await a.post('/api/code-systems').send({ id: 'ward-a', name: 'again' })).status, 409, 'duplicate id');
  assert.equal((await a.post('/api/code-systems').send({ id: 'snomed', name: 'again' })).status, 409, 'a standard id is taken');
  assert.equal((await a.post('/api/code-systems').send({ id: 'ok-3', name: 'n', uri: 'http://loinc.org' })).status, 409, 'duplicate uri');
  const d = await a.post('/api/code-systems').send({ id: 'ok-4', name: 'Default uri' });
  assert.equal(d.status, 201); assert.equal(d.body.uri, 'urn:local-code-system:ok-4'); assert.equal(d.body.kind, 'local');
  assert.equal((await a.post('/api/code-systems').send({ id: 'ok-5', name: 'Own uri', uri: 'urn:hospital:five' })).body.uri, 'urn:hospital:five');
  assert.equal((await a.post('/api/code-systems/ward-a/codes').send({ code: 'bad code', display: 'x' })).status, 400);
  assert.equal((await a.post('/api/code-systems/ward-a/codes').send({ code: 'A/1', display: 'x' })).status, 400);
  assert.equal((await a.post('/api/code-systems/ward-a/codes').send({ code: 'ok', display: ' ' })).status, 400);
  assert.equal((await a.post('/api/code-systems/ward-a/codes').send({ code: 'V1', display: 'dup' })).status, 409, 'duplicate code');
  assert.equal((await a.post('/api/code-systems/nope/codes').send({ code: 'A', display: 'x' })).status, 404, 'unknown system');
  assert.equal((await a.post('/api/code-systems/snomed/codes').send({ code: 'A', display: 'x' })).status, 404, 'a standard system takes no local codes');
  await assert.rejects(owner.query("INSERT INTO local_codes (system_id,code,display) VALUES ('snomed','X1','x')"), (e) => e.code === '23503', 'the database refuses it too');
  assert.equal((await a.post('/api/code-systems/ward-a/codes/A%201/verify').send({})).status, 404);
  assert.equal((await a.post('/api/code-systems/ward-a/codes/NOPE/verify').send({})).status, 404);
});

test('P4a: a local code is unverified until verified; then it is in verified_codes once, with the verifier recorded', async () => {
  const a = who.admin, key = "system='ward-a' AND code='V1'";
  const before = (await a.get('/api/code-systems/ward-a/codes')).body.find((x) => x.code === 'V1');
  assert.equal(before.verified, false); assert.equal(before.verifiedBy, null);
  assert.equal(await count(`SELECT count(*) n FROM verified_codes WHERE ${key}`), 0);
  assert.ok(!(await a.get('/api/codes')).body.some((x) => x.system === 'ward-a' && x.code === 'V1'), 'not in the verified list yet');
  const v = await who.doctor.post('/api/code-systems/ward-a/codes/V1/verify').send({});
  assert.equal(v.status, 200); assert.equal(v.body.verified, true); assert.ok(v.body.verifiedBy && v.body.verifiedAt);
  assert.equal(await count(`SELECT count(*) n FROM verified_codes WHERE ${key}`), 1);
  assert.equal((await owner.query("SELECT id FROM users WHERE username='a_doctor'")).rows[0].id, v.body.verifiedBy);
  assert.equal((await a.post('/api/code-systems/ward-a/codes/V1/verify').send({})).status, 409, 'a second verify');
  assert.ok((await a.get('/api/codes')).body.some((x) => x.system === 'ward-a' && x.code === 'V1' && x.display === 'For verifying'));
});

test('P4a: a local code is never offered as a standard one', async () => {
  const a = who.admin;
  assert.equal((await a.post('/api/codes').send({ system: 'ward-a', code: 'Z9', display: 'x' })).status, 400, 'POST /codes takes snomed and loinc only');
  assert.equal((await a.post('/api/codes/ward-a/V1/live').send({ ok: true })).status, 400, 'no live check for a local code');
  assert.equal((await a.put('/api/bindings').send({ setId: 'care.t', fieldId: 'f', system: 'icd10', code: 'A00', display: 'x' })).status, 400, 'a standard system other than snomed and loinc is not bound yet');
  const l = (await a.get('/api/code-systems')).body, i = l.findIndex((x) => x.kind === 'local');
  assert.ok(i > 0 && l.slice(0, i).every((x) => x.kind === 'standard') && l.slice(i).every((x) => x.kind === 'local'), 'local systems come after the standard ones');
  assert.deepEqual(l.slice(0, 5).map((x) => x.id), ['icd10', 'icd11', 'loinc', 'snomed', 'ucum']);
  assert.ok(l.find((x) => x.id === 'ward-a').kind === 'local');
});

test('P4a: each write leaves one audit row with the actor, and a refused write leaves none', async () => {
  const a = who.informatician;
  let m = await maxId();
  assert.equal((await a.post('/api/code-systems').send({ id: 'aud-1', name: 'Audited' })).status, 201);
  let rows = await since(m); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'codesystem.add'); assert.equal(rows[0].entity_id, 'aud-1'); assert.equal(rows[0].after.kind, 'local');
  m = await maxId();
  assert.equal((await a.post('/api/code-systems/aud-1/codes').send({ code: 'Q1', display: 'Q one' })).status, 201);
  rows = await since(m); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'localcode.add'); assert.equal(rows[0].entity_id, 'aud-1/Q1'); assert.equal(rows[0].after.display, 'Q one');
  m = await maxId();
  assert.equal((await a.post('/api/code-systems/aud-1/codes/Q1/verify').send({})).status, 200);
  rows = await since(m); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'localcode.verify'); assert.equal(rows[0].entity_id, 'aud-1/Q1');
  m = await maxId();
  await who.nurse.post('/api/code-systems').send({ id: 'aud-2', name: 'x' });
  await a.post('/api/code-systems/aud-1/codes/Q1/verify').send({});
  await a.post('/api/code-systems').send({ id: 'aud-1', name: 'dup' });
  assert.equal((await since(m)).length, 0, 'forbidden and conflicting writes add no audit row');
});

test('P4a: a new local system can be named in a field\'s coding.allow when a set is saved', async () => {
  const body = { title: 'T', sections: [{ id: 's', title: 'S', fields: [{ id: 'f', label: 'F', type: 'text', coding: { allow: ['ward-a', 'local'] } }] }] };
  assert.equal((await who.admin.post('/api/element-sets').send({ setId: 'user.lc', kind: 'custom', body })).status, 201);
  body.sections[0].fields[0].coding.allow = ['not-a-system'];
  assert.equal((await who.admin.post('/api/element-sets').send({ setId: 'user.lc2', kind: 'custom', body })).status, 422);
});

// P4c: bind a verified local code to a field
const addSet = async (setId, fields) => {
  const body = { setId, kind: 'custom', version: 1, title: setId, sections: [{ title: 'S', fields }] };
  await owner.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier,content_hash) VALUES ($1,1,'custom',$2,'user',false,'local-draft',$3)`,
    [setId, JSON.stringify(body), crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')]);
};
const fld = (id, allow) => ({ id, label: id, type: 'text', ...(allow ? { coding: { allow } } : {}) });
const bind = (setId, fieldId, system, code) => who.admin.put('/api/bindings').send({ setId, fieldId, system, code, display: 'client text' });
const bound = async (setId) => (await who.admin.get('/api/bindings')).body.filter((b) => b.setId === setId);

test('P4c: a verified local code binds, with the verified display; the field must allow local or that system', async () => {
  await addSet('t.loc', [fld('f1', ['local']), fld('f2', ['ward-a']), fld('f3', ['snomed']), fld('f4', null), fld('f5', ['none'])]);
  const r = await bind('t.loc', 'f1', 'ward-a', 'V1');
  assert.equal(r.status, 200); assert.equal(r.body.display, 'For verifying', 'the verified display is kept, not the client text');
  assert.deepEqual((await bound('t.loc')).map((b) => [b.fieldId, b.system, b.code]), [['f1', 'ward-a', 'V1']]);
  assert.equal((await bind('t.loc', 'f2', 'ward-a', 'V1')).status, 200, 'allow names the system itself');
  assert.equal((await bind('t.loc', 'f4', 'ward-a', 'V1')).status, 200, 'no coding block behaves as before');
  const no = await bind('t.loc', 'f3', 'ward-a', 'V1');
  assert.equal(no.status, 422); assert.equal(no.body.error.code, 'coding_not_allowed');
  assert.equal((await bind('t.loc', 'f5', 'ward-a', 'V1')).status, 422);
  assert.equal((await bound('t.loc')).filter((b) => b.fieldId === 'f3' || b.fieldId === 'f5').length, 0);
});
test('P4c: an unverified or unknown local code, an unknown system and a bad code are refused; nothing is saved', async () => {
  await addSet('t.loc2', [fld('f1', ['local'])]);
  await who.admin.post('/api/code-systems/ward-a/codes').send({ code: 'U1', display: 'Typed only' });
  const u = await bind('t.loc2', 'f1', 'ward-a', 'U1');
  assert.equal(u.status, 422); assert.equal(u.body.error.code, 'code_not_verified');
  assert.equal((await bind('t.loc2', 'f1', 'ward-a', 'NOPE')).status, 422);
  assert.equal((await bind('t.loc2', 'f1', 'icd10', 'A00')).status, 400, 'a standard system other than snomed and loinc');
  assert.equal((await bind('t.loc2', 'f1', 'nope-sys', 'V1')).status, 400, 'not a code system');
  assert.equal((await bind('t.loc2', 'f1', 'ward-a', 'bad code')).status, 400);
  assert.equal((await bound('t.loc2')).length, 0);
});
test('P4c: a local and a SNOMED binding sit side by side; DELETE ?system= removes one; each bind is audited', async () => {
  await addSet('t.loc3', [fld('f1', ['snomed', 'local'])]);
  const m = await maxId();
  assert.equal((await bind('t.loc3', 'f1', 'snomed', '386661006')).status, 200);
  assert.equal((await bind('t.loc3', 'f1', 'ward-a', 'V1')).status, 200);
  assert.equal((await since(m)).filter((x) => x.action === 'binding.set').length, 2);
  assert.equal((await who.admin.delete('/api/bindings/t.loc3/f1?system=nope-sys')).status, 400);
  assert.equal((await who.admin.delete('/api/bindings/t.loc3/f1?system=ward-a')).status, 204);
  assert.deepEqual((await bound('t.loc3')).map((b) => b.system), ['snomed']);
});
