'use strict';
// node --test api.test.js  (needs DATABASE_URL; creates and drops its own database)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { seedSets, readSeedSets } = require('./seed.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_api_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let db, app;
// TEST-ONLY actor (createApp refuses getActor when NODE_ENV=production): an admin unless the request sends x-test-role. Real sessions are tested in permissions.test.js.
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await db.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['test-' + role, 'Test ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const api = () => request(app);
const newCase = async (b = {}) => (await api().post('/api/cases').send(b)).body;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name));
  await migrate(db, __dirname);
  app = createApp({ db, getActor });
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

test('cases: create, read in the prototype shape, list summary', async () => {
  const r = await api().post('/api/cases').send({ narrative: 'hello', patient: { name: 'Demo', ageSex: '30 M', bed: 'A1', mrn: 'X' } });
  assert.equal(r.status, 201);
  const c = r.body;
  assert.equal(c.version, 1); assert.deepEqual(c.applied, []); assert.deepEqual(c.values, {}); assert.equal(c.patient.bed, 'A1');
  const g = await api().get('/api/cases/' + c.id);
  assert.equal(g.body.narrative, 'hello');
  const l = await api().get('/api/cases');
  assert.ok(l.body.some((x) => x.id === c.id && x.preview === 'hello' && !('values' in x)));
});

test('cases: client-supplied id is idempotent (409, not a duplicate)', async () => {
  const id = crypto.randomUUID();
  assert.equal((await api().post('/api/cases').send({ id })).status, 201);
  const r = await api().post('/api/cases').send({ id });
  assert.equal(r.status, 409); assert.equal(r.body.current.id, id);
});

test('cases: PATCH needs expectedVersion; stale version returns 409 with current', async () => {
  const c = await newCase();
  const ok = await api().patch('/api/cases/' + c.id).send({ expectedVersion: 1, narrative: 'a', applied: [{ setId: 'care.vitals', addedAt: new Date().toISOString() }] });
  assert.equal(ok.status, 200); assert.equal(ok.body.version, 2);
  const stale = await api().patch('/api/cases/' + c.id).send({ expectedVersion: 1, narrative: 'b' });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'conflict'); assert.equal(stale.body.current.narrative, 'a');
  assert.equal((await api().patch('/api/cases/' + c.id).send({ narrative: 'x' })).status, 400);
});

test('validation: unknown fields, bad ids, bad JSON, error format', async () => {
  const c = await newCase();
  const unk = await api().patch('/api/cases/' + c.id).send({ expectedVersion: 1, narrative: 'a', created_by: 'x' });
  assert.equal(unk.status, 400); assert.equal(unk.body.error.code, 'validation');
  assert.equal((await api().get('/api/cases/not-a-uuid')).status, 404);
  assert.equal((await api().get('/api/cases/' + crypto.randomUUID())).status, 404);
  const bad = await api().post('/api/cases').set('Content-Type', 'application/json').send('{oops');
  assert.equal(bad.status, 400); assert.ok(bad.body.error.code && bad.body.error.message);
  assert.equal((await api().post('/api/cases').send({ narrative: 'x'.repeat(200001) })).status, 400);
});

test('rows: parallel appends both succeed and assemble as values[setId/@group]', async () => {
  const c = await newCase();
  const add = (hr, t) => api().post(`/api/cases/${c.id}/rows`).send({ setId: 'care.vitals', groupId: 'vit', row: { hr }, rowTime: t });
  const [a, b] = await Promise.all([add(70, '2026-11-18T08:00:00Z'), add(80, '2026-11-18T09:00:00Z')]);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const g = (await api().get('/api/cases/' + c.id)).body;
  const rows = g.values['care.vitals/@vit'];
  assert.deepEqual(rows.map((r) => r.hr), [70, 80]);
  assert.ok(rows[0].__id && rows[0].__v === 1 && rows[0].__by);
});

test('rows: invalid timestamp is kept (null time); bad timestamp text is refused', async () => {
  const c = await newCase();
  assert.equal((await api().post(`/api/cases/${c.id}/rows`).send({ setId: 's', groupId: 'g', row: { a: 1 } })).status, 201);
  assert.equal((await api().post(`/api/cases/${c.id}/rows`).send({ setId: 's', groupId: 'g', row: { a: 1 }, rowTime: 'yesterday-ish' })).status, 400);
  assert.equal((await api().get('/api/cases/' + c.id)).body.values['s/@g'].length, 1);
});

test('rows: two edits of the same row, one gets 409; entered-in-error needs a reason, hides and keeps', async () => {
  const c = await newCase();
  const row = (await api().post(`/api/cases/${c.id}/rows`).send({ setId: 's', groupId: 'g', row: { v: 1 } })).body;
  const e = (v) => api().patch(`/api/cases/${c.id}/rows/${row.id}`).send({ expectedVersion: 1, row: { v } });
  const res = await Promise.all([e(2), e(3)]);
  assert.deepEqual(res.map((x) => x.status).sort(), [200, 409]);
  assert.ok(res.find((x) => x.status === 409).body.current.row);
  assert.equal((await api().post(`/api/cases/${c.id}/rows/${row.id}/error`).send({ expectedVersion: 2, reason: '' })).status, 400);
  const er = await api().post(`/api/cases/${c.id}/rows/${row.id}/error`).send({ expectedVersion: 2, reason: 'wrong patient' });
  assert.equal(er.status, 200); assert.equal(er.body.status, 'entered_in_error');
  assert.equal((await api().get('/api/cases/' + c.id)).body.values['s/@g'], undefined);
  const all = (await api().get(`/api/cases/${c.id}?includeErrors=1`)).body.values['s/@g'];
  assert.equal(all.length, 1); assert.equal(all[0].__status, 'entered_in_error');
  assert.equal((await api().patch(`/api/cases/${c.id}/rows/${row.id}`).send({ expectedVersion: 3, row: { v: 9 } })).status, 422);
});

test('rows: there is no DELETE', async () => {
  const c = await newCase();
  const row = (await api().post(`/api/cases/${c.id}/rows`).send({ setId: 's', groupId: 'g', row: {} })).body;
  assert.equal((await api().delete(`/api/cases/${c.id}/rows/${row.id}`)).status, 404);
  assert.equal((await api().delete(`/api/cases/${c.id}`)).status, 404);
});

test('rows: at most 500 per group', async () => {
  const c = await newCase();
  await db.query(`INSERT INTO case_rows (case_id,set_id,group_id,row) SELECT $1,'s','big','{}' FROM generate_series(1,500)`, [c.id]);
  const r = await api().post(`/api/cases/${c.id}/rows`).send({ setId: 's', groupId: 'big', row: {} });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'too_many_rows');
  assert.equal((await api().post(`/api/cases/${c.id}/rows`).send({ setId: 's', groupId: 'other', row: {} })).status, 201);
});

test('values: create with expectedVersion 0, then versioned update, 409 on stale', async () => {
  const c = await newCase(), put = (b) => api().put(`/api/cases/${c.id}/values`).send({ key: 'care.vitals/__ref', ...b });
  const a = await put({ value: { temp: { low: 1 } }, expectedVersion: 0 });
  assert.equal(a.status, 200); assert.equal(a.body.version, 1);
  const dup = await put({ value: {}, expectedVersion: 0 });
  assert.equal(dup.status, 409); assert.equal(dup.body.current.version, 1);
  assert.equal((await put({ value: { x: 1 }, expectedVersion: 1 })).body.version, 2);
  assert.equal((await put({ value: { x: 2 }, expectedVersion: 1 })).status, 409);
  assert.equal((await api().put(`/api/cases/${c.id}/values`).send({ key: 'bad key', value: 1, expectedVersion: 0 })).status, 400);
  assert.deepEqual((await api().get('/api/cases/' + c.id)).body.values['care.vitals/__ref'], { x: 1 });
});

test('notes: draft, sign (signer from session), signed is read-only, amend needs reason', async () => {
  const c = await newCase();
  const n = (await api().post(`/api/cases/${c.id}/notes`).send({ type: 'narrative', text: 'a' })).body;
  const p = await api().patch(`/api/cases/${c.id}/notes/${n.id}`).send({ expectedVersion: 1, text: 'b' });
  assert.equal(p.body.text, 'b');
  assert.equal((await api().post(`/api/cases/${c.id}/notes/${n.id}/sign`).send({ expectedVersion: 2, signedBy: 'me' })).status, 400);
  const s = await api().post(`/api/cases/${c.id}/notes/${n.id}/sign`).send({ expectedVersion: 2 });
  assert.equal(s.body.status, 'signed'); assert.ok(s.body.signedBy && s.body.signedAt);
  const again = await api().patch(`/api/cases/${c.id}/notes/${n.id}`).send({ expectedVersion: 3, text: 'c' });
  assert.equal(again.status, 409); assert.equal(again.body.error.code, 'signed');
  assert.equal((await api().post(`/api/cases/${c.id}/notes/${n.id}/amend`).send({ reason: '', text: 'x' })).status, 400);
  const am = await api().post(`/api/cases/${c.id}/notes/${n.id}/amend`).send({ reason: 'typo', text: 'fixed' });
  assert.equal(am.status, 201); assert.equal(am.body.amends, n.id); assert.equal(am.body.status, 'draft');
  assert.equal((await api().get('/api/cases/' + c.id)).body.notes.length, 2);
});

test('element sets: seed sets are read-only (PATCH, DELETE, POST all 403); user sets version up', async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')), 'element-sets.js');
  fs.writeFileSync(tmp, "window.SEED_SETS=[{setId:'care.vitals',kind:'care',version:1,title:'Vitals',sections:[],access:{view:['admin','doctor','nurse','informatician','viewer'],enter:['admin','doctor'],amend:['admin','doctor'],approve:['admin','doctor'],configure:['admin'],export:['admin']}}];");
  const seeds = readSeedSets(tmp);
  assert.deepEqual(await seedSets(db, seeds), { inserted: 1, unchanged: 0 });
  assert.deepEqual(await seedSets(db, seeds), { inserted: 0, unchanged: 1 });
  await assert.rejects(() => seedSets(db, [{ ...seeds[0], title: 'Changed' }]), /bump its version/);
  assert.equal((await api().patch('/api/element-sets/care.vitals').send({ title: 'x' })).status, 403);
  assert.equal((await api().delete('/api/element-sets/care.vitals')).status, 403);
  assert.equal((await api().post('/api/element-sets').send({ setId: 'care.vitals', kind: 'care', body: {}, expectedVersion: 1 })).status, 403);
  // marketplace-style read-only row
  await db.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier) VALUES ('pkg.x',1,'care','{}','marketplace',true,'marketplace-verified')`);
  assert.equal((await api().patch('/api/element-sets/pkg.x').send({})).status, 403);
  assert.equal((await api().delete('/api/element-sets/pkg.x')).status, 403);
  // user set
  const v1 = await api().post('/api/element-sets').send({ setId: 'user.mine', kind: 'custom', body: { title: 'Mine' } });
  assert.equal(v1.status, 201); assert.equal(v1.body.version, 1); assert.equal(v1.body.readOnly, false);
  assert.equal((await api().post('/api/element-sets').send({ setId: 'user.mine', kind: 'custom', body: {} })).status, 409);
  const v2 = await api().post('/api/element-sets').send({ setId: 'user.mine', kind: 'custom', body: { title: 'Mine 2' }, expectedVersion: 1 });
  assert.equal(v2.body.version, 2);
  assert.equal((await api().post('/api/element-sets').send({ setId: 'user.mine', kind: 'custom', body: {}, expectedVersion: 1 })).status, 409);
  assert.equal((await api().patch('/api/element-sets/user.mine').send({})).status, 405);
  const list = (await api().get('/api/element-sets')).body;
  assert.equal(list.find((s) => s.setId === 'user.mine').version, 2);
  assert.equal(list.find((s) => s.setId === 'care.vitals').readOnly, true);
});

test('element sets: old versions stay readable; applied/pathway entries may record a version', async () => {
  const id = 'user.versioned';
  await api().post('/api/element-sets').send({ setId: id, kind: 'custom', body: { title: 'A' } });
  await api().post('/api/element-sets').send({ setId: id, kind: 'custom', body: { title: 'B' }, expectedVersion: 1 });
  const v1 = await api().get(`/api/element-sets/${id}/versions/1`);
  assert.equal(v1.status, 200); assert.equal(v1.body.version, 1); assert.equal(v1.body.body.title, 'A');
  const v2 = await api().get(`/api/element-sets/${id}/versions/2`);
  assert.equal(v2.body.body.title, 'B');
  assert.equal((await api().get(`/api/element-sets/${id}`)).body.version, 2);       // latest is still v2
  const all = await api().get(`/api/element-sets/${id}/versions`);
  assert.deepEqual(all.body.map((v) => v.version), [1, 2]); assert.equal(all.body[0].body, undefined);
  assert.equal((await api().get(`/api/element-sets/${id}/versions/3`)).status, 404);
  assert.equal((await api().get(`/api/element-sets/${id}/versions/0`)).status, 400);
  assert.equal((await api().get(`/api/element-sets/${id}/versions/abc`)).status, 400);
  assert.equal((await api().get('/api/element-sets/user.nope/versions')).status, 404);
  assert.equal((await api().get('/api/element-sets/user.nope/versions/1')).status, 404);
  // a pathway saved twice: both versions resolvable; read-only seed/marketplace sets still refuse edits
  const p1 = await api().post('/api/element-sets').send({ setId: 'pathway.user.p', kind: 'pathway', body: { title: 'P', members: [{ setId: 'a', optional: false }] } });
  const p2 = await api().post('/api/element-sets').send({ setId: 'pathway.user.p', kind: 'pathway', body: { title: 'P', members: [{ setId: 'b', optional: false }] }, expectedVersion: 1 });
  assert.equal(p1.body.version, 1); assert.equal(p2.body.version, 2);
  assert.equal((await api().get('/api/element-sets/pathway.user.p/versions/1')).body.body.members[0].setId, 'a');
  assert.equal((await api().post('/api/element-sets').send({ setId: 'pkg.x', kind: 'care', body: {}, expectedVersion: 1 })).status, 403);
  // a case can record the version it applied
  const c = await api().post('/api/cases').send({ applied: [{ setId: id, version: 1, addedAt: new Date().toISOString() }], pathways: [{ pathwayId: 'pathway.user.p', version: 1, startedAt: new Date().toISOString() }] });
  assert.equal(c.status, 201); assert.equal(c.body.applied[0].version, 1); assert.equal(c.body.pathways[0].version, 1);
  const bad = await api().post('/api/cases').send({ applied: [{ setId: id, version: 0, addedAt: 'x' }] });
  assert.equal(bad.status, 400);
});

test('rules: approval is stamped by the server; editing resets it; unapproved never enabled', async () => {
  const put = (b) => api().put('/api/rules/care.fever_chart/r1').send(b);
  const a = await put({ body: { op: '>=', threshold: 1 }, expectedVersion: 0 });
  assert.equal(a.status, 200); assert.equal(a.body.enabled, false);
  assert.equal((await api().post('/api/rules/care.fever_chart/r1/approve').send({ expectedVersion: 1, verifiedBy: 'x' })).status, 400);
  const ap = await api().post('/api/rules/care.fever_chart/r1/approve').send({ expectedVersion: 1 });
  assert.equal(ap.body.enabled, true); assert.ok(ap.body.verifiedBy && ap.body.verifiedAt);
  const ed = await put({ body: { op: '>=', threshold: 2 }, expectedVersion: 2 });
  assert.equal(ed.body.enabled, false); assert.equal(ed.body.verifiedBy, null);
  assert.equal((await put({ body: {}, expectedVersion: 2 })).status, 409);
  assert.equal((await api().get('/api/rules')).body['care.fever_chart'].length, 1);
});

test('protocols: bands saved unapproved; editing clears approval', async () => {
  const p = await api().put('/api/protocols/care.sliding_scale_insulin').send({ body: { bands: [{ min: '', max: '', instruction: 'typed text' }] }, expectedVersion: 0 });
  assert.equal(p.status, 200); assert.equal(p.body.verifiedBy, null);
  const ap = await api().post('/api/protocols/care.sliding_scale_insulin/approve').send({ expectedVersion: 1 });
  assert.ok(ap.body.verifiedBy);
  const ed = await api().put('/api/protocols/care.sliding_scale_insulin').send({ body: { bands: [{ min: '', max: '', instruction: 'typed text 2' }] }, expectedVersion: 2 });
  assert.equal(ed.body.verifiedBy, null);
  assert.equal((await api().put('/api/protocols/care.sliding_scale_insulin').send({ body: {}, expectedVersion: 2 })).status, 409);
});

test('usage, codes, bindings, prefs', async () => {
  await api().post('/api/usage/care.vitals').send({ dx: '123' });
  const u = await api().post('/api/usage/care.vitals').send({ dx: '123' });
  assert.equal(u.body.count, 2); assert.equal(u.body.withDx['123'], 2);
  assert.equal((await api().get('/api/usage')).body['care.vitals'].count, 2);
  assert.equal((await api().delete('/api/usage')).status, 204);
  assert.deepEqual((await api().get('/api/usage')).body, {});
  assert.equal((await api().post('/api/codes').send({ system: 'snomed', code: '123456', display: 'x' })).status, 201);
  assert.equal((await api().post('/api/codes').send({ system: 'snomed', code: '123457', display: 'y', addedBy: 'me' })).status, 400);
  assert.equal((await api().get('/api/codes')).body[0].display, 'x');
  await api().put('/api/bindings').send({ setId: 's', fieldId: 'f', system: 'loinc', code: '2345-7', display: 'z' });
  assert.equal((await api().get('/api/bindings')).body.length, 1);
  assert.equal((await api().delete('/api/bindings/s/f')).status, 204);
  await api().put('/api/prefs/pinned').send({ value: ['care.vitals'] });
  assert.deepEqual((await api().get('/api/prefs')).body.pinned, ['care.vitals']);
});

test('usage: the client payload (dxs) works; counts are per user; reset only touches the caller', async () => {
  await api().delete('/api/usage');
  const u = await api().post('/api/usage/care.vitals').send({ dxs: ['111', '222', '111'] });
  assert.equal(u.status, 200); assert.equal(u.body.count, 1); assert.deepEqual(u.body.withDx, { 111: 1, 222: 1 });
  const u2 = await api().post('/api/usage/care.vitals').send({ dx: '111', dxs: ['333'] });
  assert.equal(u2.body.count, 2); assert.deepEqual(u2.body.withDx, { 111: 2, 222: 1, 333: 1 });
  assert.equal((await api().post('/api/usage/care.vitals').send({ dxs: new Array(21).fill('x') })).status, 400);
  assert.equal((await api().post('/api/usage/care.vitals').send({ dxs: [''] })).status, 400);
  assert.equal((await api().post('/api/usage/care.vitals').send({ other: 1 })).status, 400);
  const other = (await db.query(`INSERT INTO users (username,name,role) VALUES ('other_user','Other','nurse') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO set_usage (user_id,set_id,count) VALUES ($1,'care.vitals',7)`, [other]);
  assert.equal((await api().get('/api/usage')).body['care.vitals'].count, 2, 'another user\'s count is not mine');
  assert.equal((await api().delete('/api/usage')).status, 204);
  assert.deepEqual((await api().get('/api/usage')).body, {});
  assert.equal((await db.query('SELECT count FROM set_usage WHERE user_id=$1', [other])).rows[0].count, 7, 'reset never touches other users');
});

test('rules and protocols: delete needs the current version; protocol approval is stamped by the server', async () => {
  const put = (b) => api().put('/api/rules/care.vitals/del1').send(b);
  assert.equal((await put({ body: { op: '>=', threshold: 1 }, expectedVersion: 0 })).status, 200);
  assert.equal((await api().delete('/api/rules/care.vitals/del1?expectedVersion=9')).status, 409);
  assert.equal((await api().delete('/api/rules/care.vitals/del1?expectedVersion=1')).status, 204);
  assert.equal((await api().get('/api/rules')).body['care.vitals'], undefined);
  const p = await api().put('/api/protocols/care.sss30c').send({ body: { bands: [{ min: '', max: '', instruction: 'typed text' }], verifiedBy: 'someone typed' }, expectedVersion: 0 });
  assert.equal(p.body.verifiedBy, null, 'a typed name in the body is never trusted');
  const a = await api().post('/api/protocols/care.sss30c/approve').send({ expectedVersion: 1 });
  assert.ok(a.body.verifiedBy && a.body.verifiedAt);
  const all = (await api().get('/api/protocols')).body['care.sss30c'];
  assert.equal(all.version, 2); assert.equal(all.body.bands[0].instruction, 'typed text');
});

test('GET /api/me returns the acting user (a session user: mode "session")', async () => {
  const r = await api().get('/api/me');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['ai', 'allowed', 'emrViews', 'id', 'mode', 'mustChangePassword', 'name', 'role']);
  assert.equal(r.body.ai, false, 'AI is off by default (chunk 36b)');
  assert.ok(Array.isArray(r.body.allowed) && r.body.allowed.includes('rule.approve') && r.body.allowed.includes('session.read'), 'allowed lists the actions of the role (chunk 32d2)');
  assert.equal(r.body.mode, 'session'); assert.equal(r.body.role, 'admin'); assert.match(r.body.id, /^[0-9a-f-]{36}$/);
});

// Chunk 28H: the seed loader against the REAL element-sets.js (earlier tests used a stand-in file).
test('seed: real element-sets.js loads, ids unique, zero rules, zero protocol bands, zero thresholds', async () => {
  const sets = readSeedSets();                                   // default path = the real element-sets.js
  assert.ok(sets.length > 0, 'element-sets.js defines no sets');
  const ids = Array.from(sets, (s) => s.setId);                  // sets come from a vm realm: copy into this realm's Array
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, [], 'duplicate setIds: ' + dup.join(', '));

  const problems = [];
  const fieldsOf = (s) => (s.sections || []).flatMap((sec) => sec.fields || []);
  for (const s of sets) {
    if (Array.isArray(s.rules) ? s.rules.length : s.rules != null) problems.push(`${s.setId}: ships with rules`);
    if (s.protocol && !(Array.isArray(s.protocol.bands) && s.protocol.bands.length === 0)) problems.push(`${s.setId}: protocol has bands`);
    if (s.kind === 'pathway') {                                  // a pathway bundles sets only; an EMR view pathway (contexts 'emr') is a screen description and has members: []
      if (!(s.contexts || []).includes('emr') && (!Array.isArray(s.members) || !s.members.length)) problems.push(`${s.setId}: pathway has no members`);
      if (s.protocol) problems.push(`${s.setId}: pathway carries a protocol`);
    }
    // Threshold, target and band fields exist for the clinician to type into; none may be pre-filled.
    const thrIds = new Set([s.view && s.view.thresholdField, s.view && s.view.thresholdUnitField].filter(Boolean));
    for (const f of fieldsOf(s)) {
      const thresholdLike = thrIds.has(f.id) || /(thr|thresh|target|tgt)/i.test(f.id) || /entered by clinician/i.test(f.label || '');
      if (thresholdLike) for (const k of ['default', 'value', 'min', 'max']) if (k in f) problems.push(`${s.setId}.${f.id}: pre-filled "${k}"`);
    }
  }
  assert.deepEqual(problems, [], 'seed safety problems:\n' + problems.join('\n'));

  // Load into a database of its own: earlier tests in this file already created user sets such as care.vitals v1.
  const seedName = 'emr_seed_' + crypto.randomBytes(4).toString('hex');
  const admin = new Client({ connectionString: withDb('postgres') });
  await admin.connect(); await admin.query(`CREATE DATABASE ${seedName}`);
  const sdb = createDb(withDb(seedName));
  try {
    await migrate(sdb, __dirname);
    assert.deepEqual(await seedSets(sdb, sets), { inserted: sets.length, unchanged: 0 });
    assert.deepEqual(await seedSets(sdb, sets), { inserted: 0, unchanged: sets.length });      // re-runnable
    const r = await sdb.query(`SELECT count(*)::int AS n, bool_and(read_only) AS ro FROM element_sets WHERE source='seed'`);
    assert.equal(r.rows[0].n, sets.length); assert.equal(r.rows[0].ro, true);
  } finally {
    await sdb.close();
    await admin.query(`DROP DATABASE IF EXISTS ${seedName} WITH (FORCE)`); await admin.end();
  }
});

test('codes: add stamps adder and time, duplicate is 409 and never overwrites', async () => {
  const a = await api().post('/api/codes').send({ system: 'loinc', code: '8310-5', display: 'Body temperature' });
  assert.equal(a.status, 201); assert.ok(a.body.addedAt); assert.ok(a.body.addedBy); assert.equal(a.body.verifiedLive, null);
  const d = await api().post('/api/codes').send({ system: 'loinc', code: '8310-5', display: 'Something else' });
  assert.equal(d.status, 409); assert.equal(d.body.error.code, 'conflict'); assert.equal(d.body.current.display, 'Body temperature');
  const l = (await api().get('/api/codes')).body.filter((c) => c.code === '8310-5');
  assert.equal(l.length, 1); assert.equal(l[0].display, 'Body temperature');
  assert.ok([404, 405].includes((await api().put('/api/codes').send({ system: 'loinc', code: '8310-5', display: 'x' })).status));   // no upsert route
});

test('codes: validation (system, code shape, display length, unknown fields)', async () => {
  const post = (b) => api().post('/api/codes').send(b);
  assert.equal((await post({ system: 'icd10', code: 'A00', display: 'x' })).status, 400);
  assert.equal((await post({ system: 'snomed', code: '12', display: 'x' })).status, 400);
  assert.equal((await post({ system: 'snomed', code: '12345a', display: 'x' })).status, 400);
  assert.equal((await post({ system: 'loinc', code: '83105', display: 'x' })).status, 400);
  assert.equal((await post({ system: 'loinc', code: '8310-5', display: '' })).status, 400);
  assert.equal((await post({ system: 'loinc', code: '8310-5', display: 'x'.repeat(301) })).status, 400);
  const r = await post({ system: 'snomed', code: '12345a', display: 'x' });
  assert.equal(r.body.error.code, 'validation'); assert.match(r.body.error.message, /code/);
});

test('codes: live result is stamped by the server and needs an existing row', async () => {
  await api().post('/api/codes').send({ system: 'snomed', code: '386661006', display: 'Fever' });
  const ok = await api().post('/api/codes/snomed/386661006/live').send({ ok: true, display: 'Fever (finding)' });
  assert.equal(ok.status, 200); assert.equal(ok.body.verifiedLive.ok, true); assert.ok(ok.body.verifiedLive.checkedAt); assert.ok(ok.body.verifiedLive.checkedBy);
  assert.equal((await api().post('/api/codes/snomed/386661006/live').send({ ok: true, checkedAt: '2000-01-01' })).status, 400);   // client cannot set the time
  assert.equal((await api().post('/api/codes/snomed/999999999/live').send({ ok: true })).status, 404);
  assert.equal((await api().post('/api/codes/snomed/12/live').send({ ok: true })).status, 400);
  const g = (await api().get('/api/codes')).body.find((c) => c.code === '386661006');
  assert.equal(g.verifiedLive.ok, true); assert.equal(g.display, 'Fever');   // live display is recorded, the table display is not replaced
});

test('bindings: bind, rebind, list, unbind, validation', async () => {
  const put = (b) => api().put('/api/bindings').send(b);
  assert.equal((await put({ setId: 'care.vitals', fieldId: 'temp', system: 'loinc', code: '8310-5', display: 'Body temperature' })).status, 200);
  assert.equal((await put({ setId: 'care.vitals', fieldId: 'temp', system: 'loinc', code: '8310-5', display: 'Body temp' })).status, 200);   // rebind replaces, no duplicate
  const l = (await api().get('/api/bindings')).body.filter((b) => b.setId === 'care.vitals');
  assert.equal(l.length, 1); assert.equal(l[0].display, 'Body temp');
  assert.equal((await put({ setId: 'care.vitals', fieldId: 'temp', system: 'icd10', code: '8310-5', display: 'x' })).status, 400);
  assert.equal((await put({ setId: 'care.vitals', fieldId: 'temp', system: 'loinc', code: 'abc', display: 'x' })).status, 400);
  assert.equal((await put({ setId: 'bad id!', fieldId: 'temp', system: 'loinc', code: '8310-5', display: 'x' })).status, 400);
  assert.equal((await api().delete('/api/bindings/care.vitals/temp')).status, 204);
  assert.equal((await api().get('/api/bindings')).body.filter((b) => b.setId === 'care.vitals').length, 0);
  assert.equal((await api().delete('/api/bindings/care.vitals/temp')).status, 204);   // unbinding twice is harmless
});

// ---------- chunk 31a: transactional import of browser data ----------
const imp = (b, dry) => api().post(dry ? '/api/import/dry-run' : '/api/import').send(b);
const iso0 = '2026-11-18T08:00:00.000Z';
const mkCase = (id, extra = {}) => ({ id, patient: { name: 'Demo', ageSex: '40 F', bed: 'B2', mrn: 'M1' }, narrative: 'n ' + id, applied: [], pathways: [], values: {}, notes: [], ...extra });
const counts = async () => ({ cases: (await db.query('SELECT count(*)::int n FROM cases')).rows[0].n, rows: (await db.query('SELECT count(*)::int n FROM case_rows')).rows[0].n,
  imports: (await db.query('SELECT count(*)::int n FROM imports')).rows[0].n });

test('import: dry-run reports counts, invalid cases, collisions and orphaned sets, and writes nothing', async () => {
  const before = await counts(), id = 'dry-' + crypto.randomBytes(3).toString('hex');
  const body = { cases: [mkCase(id, { applied: [{ setId: 'gone.set', addedAt: iso0 }] }), { id: 'bad-' + id, narrative: 5 * 1 && 'x'.repeat(200001) }, { narrative: 'no id' }],
    codes: { ['snomed|' + (7000000 + Math.floor(Math.random() * 1e6))]: 'Test concept', 'snomed|12': 'short' }, rules: { 'dry.set': [{ ruleId: 'r1', fieldRef: 'dry.set/f', op: '>', threshold: 5, indicator: 'info', summary: 'Review' }] } };
  const r = await imp(body, true);
  assert.equal(r.status, 200); assert.equal(r.body.dryRun, true); assert.equal(r.body.ok, false);
  assert.equal(r.body.counts.cases, 1); assert.equal(r.body.counts.codes, 1); assert.equal(r.body.counts.rules, 1);
  assert.equal(r.body.invalid.filter((x) => x.kind === 'case').length, 2);
  assert.ok(r.body.invalid.some((x) => x.kind === 'case' && /longer than 200000/.test(x.reason)));
  assert.ok(r.body.invalid.some((x) => x.kind === 'code' && x.ref === 'snomed|12'));
  assert.deepEqual(r.body.orphanedSets.map((x) => x.setId).sort(), ['dry.set', 'gone.set']);
  assert.deepEqual(await counts(), before);
  assert.equal((await db.query("SELECT 1 FROM verified_codes WHERE display='Test concept'")).rows.length, 0);
});

test('import: all-or-nothing, a bad case stops everything and the attempt is recorded as failed', async () => {
  const before = await counts(), good = 'aon-' + crypto.randomBytes(3).toString('hex');
  const r = await imp({ cases: [mkCase(good), mkCase('aon-bad-' + good, { values: { 'bad key with spaces': 1 } })] });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'import_invalid'); assert.equal(r.body.report.invalid.length, 1);
  const after = await counts();
  assert.equal(after.cases, before.cases); assert.equal(after.imports, before.imports + 1);
  assert.equal((await db.query('SELECT status FROM imports ORDER BY created_at DESC LIMIT 1')).rows[0].status, 'failed');
  assert.equal((await db.query('SELECT 1 FROM cases WHERE legacy_id=$1', [good])).rows.length, 0);
});

test('import: idempotent, the second run inserts nothing and reports collisions', async () => {
  const id = 'idem-' + crypto.randomBytes(3).toString('hex'), body = { cases: [mkCase(id, { values: { 'care.vitals/@vitals': [{ vit_time: '2026-11-18T09:00', hr: 70 }] } })], codes: { 'loinc|9999-9': 'Idem code' } };
  const a = await imp(body); assert.equal(a.status, 201); assert.equal(a.body.counts.cases, 1); assert.equal(a.body.cases.length, 1); assert.equal(a.body.cases[0].legacyId, id);
  const mid = await counts();
  const b = await imp(body); assert.equal(b.status, 201); assert.equal(b.body.counts.cases, 0); assert.equal(b.body.counts.rows, 0); assert.equal(b.body.counts.codes, 0);
  assert.ok(b.body.collisions.some((x) => x.kind === 'case' && x.ref === id)); assert.ok(b.body.collisions.some((x) => x.kind === 'code'));
  const end = await counts(); assert.equal(end.cases, mid.cases); assert.equal(end.rows, mid.rows);
});

test('import: two imports at the same time insert the case once', async () => {
  const id = 'race-' + crypto.randomBytes(3).toString('hex'), body = { cases: [mkCase(id)] };
  const [a, b] = await Promise.all([imp(body), imp(body)]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal(a.body.counts.cases + b.body.counts.cases, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM cases WHERE legacy_id=$1', [id])).rows[0].n, 1);
});

test('import: approvals are cleared (rules disabled and unapproved, protocols unverified, protocol value unverified)', async () => {
  const sid = 'appr31.' + crypto.randomBytes(2).toString('hex'), cid = 'appr-' + sid;
  const r = await imp({ cases: [mkCase(cid, { values: { [sid + '/__protocol']: { verifiedBy: 'Dr X', bands: [{ min: '1', max: '2', instruction: 'typed text' }] } } })],
    rules: { [sid]: [{ ruleId: 'r1', fieldRef: sid + '/f', op: '>=', threshold: '38.5', unit: '°C', indicator: 'warning', summary: 'Review temperature', enabled: true, provenance: { source: 'manual', verifiedBy: 'Dr X', verifiedAt: iso0 } }] },
    protocols: { [sid]: { verifiedBy: 'Dr X', bands: [{ min: 1, max: 2, instruction: 'typed text' }] } } });
  assert.equal(r.status, 201); assert.equal(r.body.counts.rules, 1); assert.equal(r.body.counts.protocols, 1);
  const rules = (await api().get('/api/rules')).body[sid]; assert.equal(rules.length, 1);
  assert.equal(rules[0].enabled, false); assert.equal(rules[0].verifiedBy, null); assert.equal(rules[0].body.enabled, false); assert.equal(rules[0].body.provenance.verifiedBy, ''); assert.equal(rules[0].body.threshold, 38.5);
  const p = (await api().get('/api/protocols')).body[sid]; assert.equal(p.verifiedBy, null); assert.equal(p.body.verifiedBy, ''); assert.deepEqual(p.body.bands, [{ min: '1', max: '2', instruction: 'typed text' }]);
  const c = (await api().get('/api/cases/' + r.body.cases[0].id)).body; assert.equal(c.values[sid + '/__protocol'].verifiedBy, ''); assert.equal(c.values[sid + '/__protocol'].bands[0].instruction, 'typed text');
  assert.ok(r.body.warnings.some((w) => w.kind === 'rule') && r.body.warnings.some((w) => w.kind === 'protocol'));
  const again = await imp({ rules: { [sid]: [{ ruleId: 'r1', fieldRef: sid + '/f', op: '<', threshold: 1, indicator: 'info', summary: 'Changed' }] } });
  assert.equal(again.body.counts.rules, 0); assert.equal((await api().get('/api/rules')).body[sid][0].body.op, '>=');         // an existing rule is never overwritten
});

test('import: repeat arrays become rows; times use the browser offset; error rows and bad times are kept; metadata is stripped', async () => {
  const cid = 'rows-' + crypto.randomBytes(3).toString('hex'), sid = 'rowset31.' + crypto.randomBytes(2).toString('hex');
  const def = { setId: sid, kind: 'care', sections: [{ title: 'g', fields: [{ id: 'vit_time', label: 'Time', type: 'datetime', repeat: true, group: 'vitals' }, { id: 'hr', label: 'HR', type: 'number', repeat: true, group: 'vitals' }] }] };
  const r = await imp({ utcOffsetMinutes: 345, sets: [def], cases: [mkCase(cid, { values: { [sid + '/@vitals']: [
    { vit_time: '2026-11-18T09:30', hr: 80, __id: 'x', __v: 9 }, { vit_time: 'not a time', hr: 81 }, { vit_time: '2026-11-18T10:00', hr: 82, __status: 'entered_in_error' }, { vit_time: '2026-11-18T08:00:00Z', hr: 79 }],
    [sid + '/temp_note']: 'free text' } })] });
  assert.equal(r.status, 201); assert.equal(r.body.counts.rows, 4); assert.equal(r.body.counts.values, 1);
  assert.ok(r.body.warnings.some((w) => w.kind === 'row'));
  const c = (await api().get('/api/cases/' + r.body.cases[0].id)).body, rows = c.values[sid + '/@vitals'];
  assert.deepEqual(rows.map((x) => x.hr), [80, 79, 81]);                                                       // sorted by time, no-time row last, error row hidden
  assert.equal(rows[0].__time, '2026-11-18T03:45:00.000Z'); assert.equal(rows[1].__time, '2026-11-18T08:00:00.000Z'); assert.equal(rows[2].__time, null); assert.equal(rows[0].__id.length, 36); assert.ok(!('x' in rows[0]) && rows[0].__v === 1);
  const all = (await api().get(`/api/cases/${r.body.cases[0].id}?includeErrors=1`)).body.values[sid + '/@vitals'];
  assert.equal(all.length, 4); assert.equal(all.find((x) => x.hr === 82).__status, 'entered_in_error');
  assert.equal(c.values[sid + '/temp_note'], 'free text');
  const by = (await db.query('SELECT DISTINCT entered_by FROM case_rows WHERE case_id=$1', [c.id])).rows; assert.equal(by.length, 1); assert.ok(by[0].entered_by);
});

test('import: more than 500 rows in a group refuses the import (nothing is dropped silently)', async () => {
  const before = await counts(), rows = Array.from({ length: 501 }, (_, i) => ({ vit_time: '2026-11-18T09:00', hr: i }));
  const r = await imp({ cases: [mkCase('big-' + crypto.randomBytes(3).toString('hex'), { values: { 'care.vitals/@vitals': rows } })] });
  assert.equal(r.status, 422); assert.match(r.body.report.invalid[0].reason, /501 rows/);
  assert.equal((await counts()).rows, before.rows);
});

test('import: notes keep status, signing time and amendment links; signer is the importing user, original name kept in the import record', async () => {
  const cid = 'notes-' + crypto.randomBytes(3).toString('hex');
  const r = await imp({ cases: [mkCase(cid, { notes: [
    { id: 'n1', type: 'template', setId: 'template.basic_emr', text: 'signed text', status: 'signed', signedBy: 'Dr Typed Name', signedAt: '2026-11-17T10:00:00Z', createdAt: '2026-11-17T09:00:00Z' },
    { id: 'n2', type: 'template', setId: 'template.basic_emr', text: 'amended text', status: 'draft', amends: 'n1', reason: 'wrong dose typed', createdAt: '2026-11-18T09:00:00Z' },
    { id: 'n3', type: 'narrative', text: 'draft only', status: 'draft' }] })] });
  assert.equal(r.status, 201); assert.equal(r.body.counts.notes, 3);
  const c = (await api().get('/api/cases/' + r.body.cases[0].id)).body, by = Object.fromEntries(c.notes.map((n) => [n.text, n]));
  assert.equal(by['signed text'].status, 'signed'); assert.equal(by['signed text'].signedAt, '2026-11-17T10:00:00.000Z'); assert.ok(by['signed text'].signedBy);
  assert.equal(by['amended text'].amends, by['signed text'].id); assert.equal(by['amended text'].reason, 'wrong dose typed'); assert.equal(by['draft only'].status, 'draft');
  assert.equal((await api().patch(`/api/cases/${c.id}/notes/${by['signed text'].id}`).send({ expectedVersion: 1, text: 'edit' })).status, 409);     // signed stays read-only
  const rec = (await db.query('SELECT report FROM imports WHERE id=$1', [r.body.importId])).rows[0].report;
  assert.equal(rec.signers[0].signedBy, 'Dr Typed Name'); assert.ok(r.body.warnings.some((w) => w.kind === 'note'));
  const bad = await imp({ cases: [mkCase('nb-' + cid, { notes: [{ id: 'a', type: 'narrative', text: 'x', status: 'draft', amends: 'zzz', reason: 'r' }, { id: 'b', type: 'narrative', text: 'x', status: 'signed' }] })] }, true);
  assert.equal(bad.body.ok, false); assert.match(bad.body.invalid[0].reason, /amends a note that is not in this case/); assert.match(bad.body.invalid[0].reason, /signing time/);
});

test('import: sets (version kept, rules inside stripped, existing ids never replaced), usage, pinned', async () => {
  const tag = crypto.randomBytes(2).toString('hex'), sid = 'mine31.' + tag, other = 'exist31.' + tag;
  const mk = (id, extra = {}) => ({ setId: id, kind: 'custom', version: 3, title: 'Mine', sections: [{ title: 's', fields: [{ id: 'f', label: 'F', type: 'text' }] }], ...extra });
  assert.equal((await api().post('/api/element-sets').send({ setId: other, kind: 'custom', body: { title: 'Already here', sections: [] } })).status, 201);
  const set = mk(sid, { rules: [{ ruleId: 'x' }] }), had = 'pinned' in (await api().get('/api/prefs')).body;
  const body = { sets: [set, mk(other), { setId: 'nokind.' + tag, kind: 'weird', sections: [] }], setUsage: { [sid]: { count: 4, lastUsed: iso0, withDx: { dka: 2 } } }, pinned: ['care.vitals', sid] };
  const d = await imp(body, true); assert.equal(d.body.invalid.length, 1); assert.equal(d.body.invalid[0].kind, 'set'); assert.ok(d.body.collisions.some((x) => x.ref === other));
  const r = await imp({ ...body, sets: [set, mk(other)] }); assert.equal(r.status, 201); assert.equal(r.body.counts.sets, 1); assert.equal(r.body.counts.pinned, had ? 0 : 1);
  const s = (await api().get('/api/element-sets/' + sid)).body; assert.equal(s.version, 3); assert.equal(s.source, 'user'); assert.equal(s.tier, 'local-draft'); assert.equal(s.readOnly, false); assert.ok(!('rules' in s.body));
  assert.equal((await api().get('/api/element-sets/' + other)).body.body.title, 'Already here');                              // an existing set is never replaced
  assert.deepEqual((await api().get('/api/usage')).body[sid], { count: 4, lastUsed: iso0, withDx: { dka: 2 } });
  if (!had) assert.deepEqual((await api().get('/api/prefs')).body.pinned, ['care.vitals', sid]);
  const nv = await api().post('/api/element-sets').send({ setId: sid, kind: 'custom', body: set, expectedVersion: 3 }); assert.equal(nv.status, 201); assert.equal(nv.body.version, 4);   // later saves continue the version line
  const again = await imp({ setUsage: { [sid]: { count: 99 } }, pinned: ['x'] }); assert.equal(again.body.counts.usage, 0); assert.equal(again.body.counts.pinned, 0);
  assert.equal((await api().get('/api/usage')).body[sid].count, 4);
});

test('import: codes follow the same format rules as /api/codes and never overwrite', async () => {
  const r = await imp({ codes: { 'snomed|2345678': 'Concept A', 'loinc|1234-5': 'Obs B', 'snomed|0123456': 'leading zero', 'foo|1': 'x', 'loinc|1234-5|x': 'extra' } }, true);
  assert.equal(r.body.counts.codes, 2); assert.equal(r.body.invalid.length, 3); assert.ok(r.body.warnings.some((w) => w.kind === 'code'));
  await api().post('/api/codes').send({ system: 'snomed', code: '7654321', display: 'Original' });
  const again = await imp({ codes: { 'snomed|7654321': 'Different' } }); assert.equal(again.body.counts.codes, 0);
  assert.equal((await api().get('/api/codes')).body.find((c) => c.code === '7654321').display, 'Original');
});

test('import: validation of the body and a body larger than 1 MB is accepted (10 MB limit on this route only)', async () => {
  assert.equal((await imp({ cases: 'nope' }, true)).status, 400);
  assert.equal((await imp({ cases: [], extra: 1 }, true)).status, 400);
  assert.equal((await imp({ utcOffsetMinutes: 5000 }, true)).status, 400);
  const big = Array.from({ length: 10 }, (_, i) => mkCase('large-' + i + crypto.randomBytes(2).toString('hex'), { narrative: 'x'.repeat(150000) }));
  const r = await imp({ cases: big }, true); assert.equal(r.status, 200); assert.equal(r.body.counts.cases, 10);
  assert.equal((await api().post('/api/cases').send({ narrative: 'y'.repeat(1100000) })).status, 413);                  // other routes keep the 1 MB cap
  const empty = await imp({}); assert.equal(empty.status, 201); assert.equal(empty.body.counts.cases, 0);
});


// ---- chunk 35a: approval is a server action; no silent re-stamp; no typed verifier anywhere ----
test('35a: approving a rule that already runs is refused and keeps the first approver; an edit resets it, then a new approver may approve', async () => {
  const doc = (m, u, b) => api()[m](u).set('x-test-role', 'doctor').send(b);
  assert.equal((await api().put('/api/rules/care.a35/r1').send({ body: { op: '>=', threshold: 1 }, expectedVersion: 0 })).status, 200);
  const first = await api().post('/api/rules/care.a35/r1/approve').send({ expectedVersion: 1 });
  assert.equal(first.status, 200);
  const again = await doc('post', '/api/rules/care.a35/r1/approve', { expectedVersion: 2 });
  assert.equal(again.status, 409); assert.equal(again.body.error.code, 'already_approved');
  const cur = (await api().get('/api/rules')).body['care.a35'][0];
  assert.equal(cur.verifiedBy, first.body.verifiedBy, 'the first approver is kept'); assert.equal(cur.version, 2);
  const ed = await doc('put', '/api/rules/care.a35/r1', { body: { op: '>=', threshold: 2 }, expectedVersion: 2 });
  assert.equal(ed.body.enabled, false); assert.equal(ed.body.verifiedBy, null);
  const ap2 = await doc('post', '/api/rules/care.a35/r1/approve', { expectedVersion: 3 });
  assert.equal(ap2.status, 200); assert.notEqual(ap2.body.verifiedBy, first.body.verifiedBy);
});

test('35a: a protocol with no bands cannot be verified; a verified protocol is not re-stamped; viewer and nurse are refused', async () => {
  assert.equal((await api().put('/api/protocols/care.p35').send({ body: { bands: [] }, expectedVersion: 0 })).status, 200);
  const empty = await api().post('/api/protocols/care.p35/approve').send({ expectedVersion: 1 });
  assert.equal(empty.status, 400); assert.equal(empty.body.error.code, 'validation');
  assert.equal((await api().get('/api/protocols')).body['care.p35'].verifiedBy, null);
  const put = await api().put('/api/protocols/care.p35').send({ body: { bands: [{ min: '', max: '', instruction: 'typed text' }] }, expectedVersion: 1 });
  for (const role of ['nurse', 'viewer', 'informatician']) assert.equal((await api().post('/api/protocols/care.p35/approve').set('x-test-role', role).send({ expectedVersion: put.body.version })).status, 403, role);
  const ok = await api().post('/api/protocols/care.p35/approve').send({ expectedVersion: put.body.version });
  assert.equal(ok.status, 200); assert.ok(ok.body.verifiedBy);
  const dup = await api().post('/api/protocols/care.p35/approve').set('x-test-role', 'doctor').send({ expectedVersion: ok.body.version });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'already_approved');
  assert.equal((await api().get('/api/protocols')).body['care.p35'].verifiedBy, ok.body.verifiedBy);
});

test('35a: a typed verifier inside a case protocol value is never stored', async () => {
  const c = await newCase({});
  const key = 'care.p35/__protocol';
  const put = await api().put(`/api/cases/${c.id}/values`).send({ key, value: { verifiedBy: 'Dr Forged', verifiedAt: '2020-01-01', bands: [{ min: '1', max: '2', instruction: 'typed text' }] }, expectedVersion: 0 });
  assert.equal(put.status, 200);
  const got = (await api().get(`/api/cases/${c.id}`)).body.values[key];
  assert.equal(got.verifiedBy, ''); assert.equal(got.verifiedAt, ''); assert.equal(got.bands[0].instruction, 'typed text');
  assert.ok(!JSON.stringify(got).includes('Dr Forged'));
  const upd = await api().put(`/api/cases/${c.id}/values`).send({ key, value: { verifiedBy: 'Dr Forged', bands: [] }, expectedVersion: put.body.version });
  assert.equal(upd.status, 200); assert.equal(upd.body.value.verifiedBy, '');
});

test('35b: import carries acknowledgements into alert_acks as imported (no user); a time that does not parse becomes now; the case reads them back', async () => {
  const cid = 'ack35-' + crypto.randomBytes(3).toString('hex');
  const r = await imp({ cases: [mkCase(cid, { alertLog: [{ ruleId: 'r1', setId: 'care.t', ackedAt: '2026-11-18T09:00:00.000Z', sig: 's1' }, { ruleId: 'r2', setId: 'care.t', ackedAt: 'not a date', sig: '' }] })] });
  assert.equal(r.status, 201);
  const got = (await api().get('/api/cases/' + r.body.cases[0].id)).body;
  assert.equal(got.alertLog.length, 2);
  for (const a of got.alertLog) { assert.equal(a.source, 'imported'); assert.equal(a.by, null); assert.equal(a.byName, null); }
  assert.equal(got.alertLog[0].ruleId, 'r1'); assert.equal(got.alertLog[0].ackedAt, '2026-11-18T09:00:00.000Z');
  assert.ok(Date.now() - new Date(got.alertLog[1].ackedAt).getTime() < 60000, 'unparseable time became now');
  assert.equal((await db.query('SELECT alert_log FROM cases WHERE legacy_id=$1', [cid])).rows[0].alert_log.length, 0, 'the old JSON list is no longer written');
});
