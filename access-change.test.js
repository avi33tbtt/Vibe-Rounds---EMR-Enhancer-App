'use strict';
// node --test access-change.test.js  (needs DATABASE_URL; creates and drops its own database)
// R7: changing the access block of an existing set needs access.configure (admin), carries the version (409), writes one audit row with before and after,
// and makes a new version. A new set may start with a block. Made-up sets only. Same set-up as permissions.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_chg_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let db, app;
const who = {};

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name)); await migrate(db, __dirname);
  app = createApp({ db });
  const h = await hashPassword(PW);
  for (const role of P.ROLES) {
    const id = (await db.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', ['u_' + role, 'User ' + role, role, h])).rows[0].id;
    const agent = request.agent(app);
    assert.equal((await agent.post('/api/login').send({ username: 'u_' + role, password: PW })).status, 200);
    agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
    who[role] = { id, agent };
  }
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

const SET = 'made.chg_set';
const A1 = { view: P.ROLES, enter: ['doctor', 'nurse'], amend: ['doctor'] };
const A2 = { view: P.ROLES, enter: ['doctor'], amend: ['doctor'] };
const save = (role, expectedVersion, access, title = 'T', setId = SET) => who[role].agent.post('/api/element-sets').send({
  setId, kind: 'care', expectedVersion, body: { title, sections: [{ title: 's', fields: [{ id: 'a', label: 'A', type: 'text' }] }], ...(access ? { access } : {}) } });
const versions = async (setId = SET) => (await db.query('SELECT count(*)::int n FROM element_sets WHERE set_id=$1', [setId])).rows[0].n;

test('a doctor may start a new set with an access block (version 1)', async () => {
  const r = await save('doctor', 0, A1);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.body.access, A1);
});
test('a doctor, an informatician and a nurse cannot change the block of an existing set; no new version is made', async () => {
  for (const role of ['doctor', 'informatician', 'nurse']) {
    const r = await save(role, 1, A2);
    assert.equal(r.status, 403, role);
    if (role !== 'nurse') assert.match(r.body.error.message, /access\.configure/, role);   // a nurse is stopped earlier by set.write
  }
  assert.equal(await versions(), 1);
});
test('dropping the block is also a change, so a doctor is refused', async () => {
  const r = await save('doctor', 1, null);
  assert.equal(r.status, 403);
  assert.equal(await versions(), 1);
});
test('a stale version gives 409, even for an admin', async () => {
  assert.equal((await save('admin', 5, A2)).status, 409);
  assert.equal(await versions(), 1);
});
test('an admin changes the block: new version, and one audit row with the block before and after', async () => {
  const r = await save('admin', 1, A2);
  assert.equal(r.status, 201);
  assert.equal(r.body.version, 2);
  assert.deepEqual(r.body.body.access, A2);
  assert.equal(await versions(), 2);
  const rows = (await db.query(`SELECT * FROM audit_log WHERE action='set.save' AND entity_id=$1`, [SET])).rows.map((x) => JSON.stringify(x));
  const changed = rows.filter((t) => t.includes('"enter":["doctor","nurse"]') && t.includes('"enter":["doctor"]'));
  assert.equal(rows.length, 2);       // one per save
  assert.equal(changed.length, 1);    // the second save holds the block before and after
});
test('the same block with its keys in another order is not a change', async () => {
  const reordered = { amend: ['doctor'], enter: ['doctor'], view: P.ROLES };
  const r = await save('doctor', 2, reordered, 'New title');
  assert.equal(r.status, 201);
  assert.equal(r.body.version, 3);
});
test('a block that names an unknown role or action is refused with 422', async () => {
  const r = await save('admin', 3, { enter: ['porter'] });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'bad_access');
  assert.equal((await save('admin', 3, { delete: ['admin'] })).status, 422);
  assert.equal(await versions(), 3);
});
