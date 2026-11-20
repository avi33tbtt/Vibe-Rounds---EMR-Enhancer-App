'use strict';
// node --test emr-views.test.js  (no database)
// Phase V, V5a, V6a, V7a1 and V7a2: the seed EMR view pathways for the ward board and the Handover tab, and the active-list read and write routes. Data only: it names no set or field, holds no rule, threshold,
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

// ---- V7a1: the active view pathways, read side (default list; stored list wins; /me carries the same list)
test('V7a1: GET /emr-views returns the default list when nothing is stored', async () => {
  const r = await admin.get('/api/emr-views');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ids: ['pathway.emr.ward_board', 'pathway.emr.handover'], version: null });
});
test('V7a1: /me carries the same list', async () => {
  const me = await admin.get('/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.emrViews, ['pathway.emr.ward_board', 'pathway.emr.handover']);
});
test('V7a1: a stored list wins, in both places; a stored value that is not a list of ids falls back to the default', async () => {
  await owner.query("INSERT INTO app_settings (key,value) VALUES ('emr_views',$1)", [JSON.stringify({ ids: ['pathway.emr.handover'] })]);
  assert.deepEqual((await admin.get('/api/emr-views')).body.ids, ['pathway.emr.handover']);
  assert.deepEqual((await admin.get('/api/me')).body.emrViews, ['pathway.emr.handover']);
  await owner.query("UPDATE app_settings SET value=$1 WHERE key='emr_views'", [JSON.stringify({ ids: 'nope' })]);
  assert.deepEqual((await admin.get('/api/emr-views')).body.ids, ['pathway.emr.ward_board', 'pathway.emr.handover']);
  await owner.query("DELETE FROM app_settings WHERE key='emr_views'");
});

// ---- V7a2: PUT /emr-views (admin only; ids must be EMR view pathways; version carried; one audit row)
const WB = 'pathway.emr.ward_board';
const asNurse = async () => {
  await owner.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a_nurse', 'Name nurse', 'nurse', await hashPassword(PW)]);
  const n = request.agent(app);
  assert.equal((await n.post('/api/login').send({ username: 'a_nurse', password: PW })).status, 200);
  n.set('x-csrf-token', (await n.get('/api/csrf')).body.token);
  return n;
};
const viewAudit = async () => (await owner.query("SELECT * FROM audit_log WHERE action='emr_views.set' ORDER BY id")).rows;
test('V7a2: a nurse is refused (403) and nothing is stored or audited', async () => {
  const n = await asNurse(), m = (await viewAudit()).length;
  const r = await n.put('/api/emr-views').send({ ids: [WB], expectedVersion: null });
  assert.equal(r.status, 403); assert.equal(r.body.error.action, 'views.admin');
  assert.equal((await owner.query("SELECT 1 FROM app_settings WHERE key='emr_views'")).rowCount, 0);
  assert.equal((await viewAudit()).length, m);
  assert.equal((await n.get('/api/emr-views')).status, 200, 'every role may still read the list');
});
test('V7a2: a bad id is refused (400) and nothing changes: unknown, a care pathway, a care set, a repeat, a non-list', async () => {
  const m = (await viewAudit()).length;
  for (const ids of [['pathway.emr.nope'], [WB, 'pathway.dka'], ['care.vitals'], [WB, WB], 'x']) {
    const r = await admin.put('/api/emr-views').send({ ids, expectedVersion: null });
    assert.equal(r.status, 400, JSON.stringify(ids)); assert.equal(r.body.error.code, 'validation');
  }
  assert.equal((await admin.put('/api/emr-views').send({ ids: [WB] })).status, 400, 'a version is required (null for the first save)');
  assert.equal((await owner.query("SELECT 1 FROM app_settings WHERE key='emr_views'")).rowCount, 0);
  assert.equal((await viewAudit()).length, m);
});
test('V7a2: an admin saves a list; the version moves; a stale version is refused (409) with the current list; one audit row per save', async () => {
  const m = (await viewAudit()).length;
  const a = await admin.put('/api/emr-views').send({ ids: [WB], expectedVersion: null });
  assert.equal(a.status, 200); assert.deepEqual(a.body.ids, [WB]); assert.ok(typeof a.body.version === 'string' && a.body.version);
  assert.deepEqual((await admin.get('/api/emr-views')).body, { ids: [WB], version: a.body.version });
  assert.deepEqual((await admin.get('/api/me')).body.emrViews, [WB]);
  const stale = await admin.put('/api/emr-views').send({ ids: [WB, 'pathway.emr.handover'], expectedVersion: null });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'conflict'); assert.deepEqual(stale.body.error.current.ids, [WB]);
  const b = await admin.put('/api/emr-views').send({ ids: [WB, 'pathway.emr.handover'], expectedVersion: a.body.version });
  assert.equal(b.status, 200); assert.notEqual(b.body.version, a.body.version);
  assert.equal((await admin.put('/api/emr-views').send({ ids: [], expectedVersion: a.body.version })).status, 409, 'the first version is now stale');
  const rows = (await viewAudit()).slice(m);
  assert.equal(rows.length, 2, 'two saves, two audit rows; the refused ones wrote none');
  assert.equal(rows[0].entity, 'app_setting'); assert.equal(rows[0].entity_id, 'emr_views'); assert.equal(rows[0].role, 'admin');
  assert.deepEqual(rows[0].before, { ids: ['pathway.emr.ward_board', 'pathway.emr.handover'] }, 'before is the default list');
  assert.deepEqual(rows[0].after, { ids: [WB] }); assert.deepEqual(rows[1].before, { ids: [WB] });
  assert.deepEqual((await admin.put('/api/emr-views').send({ ids: [], expectedVersion: b.body.version })).body.ids, [], 'an empty list is allowed: every view pathway off');
});
