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
const api = () => request(app);
const newCase = async (b = {}) => (await api().post('/api/cases').send(b)).body;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name));
  await migrate(db, __dirname);
  app = createApp({ db });
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
  fs.writeFileSync(tmp, "window.SEED_SETS=[{setId:'care.vitals',kind:'care',version:1,title:'Vitals',sections:[]}];");
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
  const p = await api().put('/api/protocols/care.sliding_scale_insulin').send({ body: { bands: [] }, expectedVersion: 0 });
  assert.equal(p.status, 200); assert.equal(p.body.verifiedBy, null);
  const ap = await api().post('/api/protocols/care.sliding_scale_insulin/approve').send({ expectedVersion: 1 });
  assert.ok(ap.body.verifiedBy);
  const ed = await api().put('/api/protocols/care.sliding_scale_insulin').send({ body: { bands: [] }, expectedVersion: 2 });
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

test('GET /api/me returns the acting (development) user', async () => {
  const r = await api().get('/api/me');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['id', 'mode', 'name', 'role']);
  assert.equal(r.body.mode, 'dev'); assert.equal(r.body.role, 'admin'); assert.match(r.body.id, /^[0-9a-f-]{36}$/);
});

test('auth placeholder refuses to run in production', async () => {
  const old = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { assert.equal((await api().get('/api/cases')).status, 503); } finally { process.env.NODE_ENV = old; }
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
    if (s.kind === 'pathway') {                                  // a pathway bundles sets only
      if (!Array.isArray(s.members) || !s.members.length) problems.push(`${s.setId}: pathway has no members`);
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
