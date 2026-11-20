'use strict';
// node --test emr-views.test.js  (no database)
// Phase V, V5a and V6a: the seed EMR view pathways for the ward board and the Handover tab. Data only: it names no set or field, holds no rule, threshold,
// band, dose, limit, target or default, and validates with validatePathwayViews. (Seeding read-only is checked in the same file once seed.js is read.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { validatePathwayViews } = require('./views.js');

const win = {};
vm.runInNewContext(fs.readFileSync('./element-sets.js', 'utf8'), { window: win });
const SEEDS = JSON.parse(JSON.stringify(win.SEED_SETS));   // plain objects of this realm, so deepEqual compares like with like
const byId = (id) => SEEDS.find((s) => s.setId === id);
const BANNED = ['eval', 'function', 'threshold', 'band', 'dose', 'limit', 'target', 'default'];
const keysDeep = (o, out = []) => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { out.push(k); keysDeep(o[k], out); } return out; };

test('V5a: pathway.emr.ward_board is in the seed list exactly once', () => {
  assert.equal(SEEDS.filter((s) => s.setId === 'pathway.emr.ward_board').length, 1);
});
test('V5a: it is a pathway for the EMR context with the section 9 shape: no members, no rules, pinned columns', () => {
  const p = byId('pathway.emr.ward_board');
  assert.equal(p.kind, 'pathway'); assert.deepEqual(p.contexts, ['emr']);
  assert.deepEqual(p.members, []); assert.deepEqual(p.rules, []);
  assert.deepEqual(p.surface, { type: 'patients_columns', columnsFrom: 'pinned' });
  assert.ok(Number.isInteger(p.version) && p.version >= 1);
  assert.ok(typeof p.title === 'string' && p.title.trim() && typeof p.description === 'string' && p.description.trim());
});
test('V5a: it validates with validatePathwayViews', () => {
  const r = validatePathwayViews(byId('pathway.emr.ward_board'), new Set(SEEDS.map((s) => s.setId)));
  assert.deepEqual(r.errors, []);
});
test('V5a: it holds no banned key and names no set or field of any other seed', () => {
  const p = byId('pathway.emr.ward_board'), keys = keysDeep(p);
  for (const b of BANNED) assert.ok(!keys.includes(b), 'banned key ' + b);
  const text = JSON.stringify(p);
  for (const s of SEEDS) if (s.setId !== p.setId) {
    assert.ok(!text.includes('"' + s.setId + '"'), 'names set ' + s.setId);
    for (const sec of s.sections || []) for (const f of sec.fields || []) if (f.id.length >= 4) assert.ok(!text.includes('"' + f.id + '"'), 'names field ' + f.id);
  }
});
test('V5a: every seed pathway that is for the EMR has no rules, and the others are unchanged in kind and context', () => {
  const emr = SEEDS.filter((s) => s.kind === 'pathway' && (s.contexts || []).includes('emr'));
  assert.ok(emr.length >= 1); assert.ok(emr.every((s) => Array.isArray(s.rules) && s.rules.length === 0));
  for (const id of ['pathway.dka', 'pathway.snakebite', 'pathway.fever_monitoring']) assert.deepEqual(byId(id).contexts, ['care']);
});

// ---- V6a: the seed EMR view pathway for the Handover tab (data only; same checks as the ward board)
const HO = 'pathway.emr.handover';
test('V6a: pathway.emr.handover is in the seed list exactly once, for the EMR context, with no members and no rules', () => {
  assert.equal(SEEDS.filter((s) => s.setId === HO).length, 1);
  const p = byId(HO);
  assert.equal(p.kind, 'pathway'); assert.deepEqual(p.contexts, ['emr']);
  assert.deepEqual(p.members, []); assert.deepEqual(p.rules, []);
  assert.ok(Number.isInteger(p.version) && p.version >= 1);
  assert.ok(typeof p.title === 'string' && p.title.trim() && typeof p.description === 'string' && p.description.trim());
});
test('V6a: it is a case tab with the section 9 sections in order', () => {
  const p = byId(HO);
  assert.deepEqual(p.surface, { type: 'case_tab', id: 'ho', label: 'Handover', print: true });
  assert.deepEqual(p.sections.map((x) => x.type), ['narrative', 'activePathways', 'latestValues', 'ackedAlerts', 'newRows']);
});
test('V6a: it validates with validatePathwayViews', () => {
  assert.deepEqual(validatePathwayViews(byId(HO), new Set(SEEDS.map((s) => s.setId))).errors, []);
});
test('V6a: it holds no banned key and names no set or field of any other seed', () => {
  const p = byId(HO), keys = keysDeep(p);
  for (const b of BANNED) assert.ok(!keys.includes(b), 'banned key ' + b);
  const text = JSON.stringify(p);
  for (const s of SEEDS) if (s.setId !== p.setId) {
    assert.ok(!text.includes('"' + s.setId + '"'), 'names set ' + s.setId);
    for (const sec of s.sections || []) for (const f of sec.fields || []) if (f.id.length >= 4) assert.ok(!text.includes('"' + f.id + '"'), 'names field ' + f.id);
  }
});

// ---- V5a, part 2: the seeded row is read-only (needs DATABASE_URL; creates and drops its own database)
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const { readSeedSets, seedSets, seedCodeSystems } = require('./seed.js');
const { CODE_SYSTEMS } = require('./code-systems.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const dbName = 'emr_ev_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery', ID = 'pathway.emr.ward_board';
let owner, appDb, app, admin;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
  await seedCodeSystems(owner, CODE_SYSTEMS);
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
const row = async () => (await owner.query('SELECT * FROM element_sets WHERE set_id=$1 ORDER BY version', [ID])).rows;

test('V5a: seeding stores the pathway as a read-only seed row, and a second seeding changes nothing', async () => {
  const sets = readSeedSets(), first = await seedSets(owner, sets);
  assert.equal(first.inserted, sets.length);
  const rows = await row();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'seed'); assert.equal(rows[0].read_only, true); assert.equal(rows[0].kind, 'pathway'); assert.equal(rows[0].version, 1);
  assert.deepEqual(rows[0].body.surface, { type: 'patients_columns', columnsFrom: 'pinned' });
  assert.deepEqual(rows[0].body.rules, []);
  const again = await seedSets(owner, sets);
  assert.deepEqual(again, { inserted: 0, unchanged: sets.length });
});
test('V5a: the API lists it as a read-only seed', async () => {
  const p = (await admin.get('/api/element-sets')).body.find((s) => s.setId === ID);
  assert.ok(p); assert.equal(p.readOnly, true); assert.equal(p.source, 'seed'); assert.equal(p.kind, 'pathway');
});
test('V5a: saving, patching or deleting it through the API is refused (403) and nothing changes', async () => {
  const before = (await row())[0].content_hash, body = JSON.parse(JSON.stringify(SEEDS.find((s) => s.setId === ID)));
  body.title = 'Changed';
  const post = await admin.post('/api/element-sets').send({ setId: ID, kind: 'pathway', body, expectedVersion: 1 });
  assert.equal(post.status, 403); assert.equal(post.body.error.code, 'read_only');
  assert.equal((await admin.patch('/api/element-sets/' + ID).send({})).status, 403);
  assert.equal((await admin.delete('/api/element-sets/' + ID)).status, 403);
  const rows = await row();
  assert.equal(rows.length, 1); assert.equal(rows[0].content_hash, before); assert.equal(rows[0].body.title, 'Ward board columns');
});

test('V6a: seeding stores the handover pathway as a read-only seed row', async () => {
  await seedSets(owner, readSeedSets());
  const rows = (await owner.query('SELECT * FROM element_sets WHERE set_id=$1 ORDER BY version', [HO])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'seed'); assert.equal(rows[0].read_only, true); assert.equal(rows[0].kind, 'pathway'); assert.equal(rows[0].version, 1);
  assert.deepEqual(rows[0].body.rules, []);
  assert.deepEqual(rows[0].body.sections.map((x) => x.type), ['narrative', 'activePathways', 'latestValues', 'ackedAlerts', 'newRows']);
  const p = (await admin.get('/api/element-sets')).body.find((s) => s.setId === HO);
  assert.ok(p); assert.equal(p.readOnly, true); assert.equal(p.source, 'seed');
});
test('V6a: saving, patching or deleting the handover pathway through the API is refused (403) and nothing changes', async () => {
  const q = async () => (await owner.query('SELECT * FROM element_sets WHERE set_id=$1 ORDER BY version', [HO])).rows;
  const before = (await q())[0].content_hash, body = JSON.parse(JSON.stringify(byId(HO)));
  body.title = 'Changed';
  const post = await admin.post('/api/element-sets').send({ setId: HO, kind: 'pathway', body, expectedVersion: 1 });
  assert.equal(post.status, 403); assert.equal(post.body.error.code, 'read_only');
  assert.equal((await admin.patch('/api/element-sets/' + HO).send({})).status, 403);
  assert.equal((await admin.delete('/api/element-sets/' + HO)).status, 403);
  const rows = await q();
  assert.equal(rows.length, 1); assert.equal(rows[0].content_hash, before); assert.equal(rows[0].body.title, 'Handover view');
});
