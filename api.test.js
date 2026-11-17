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
  assert.equal((await api().put('/api/codes').send({ system: 'snomed', code: '1', display: 'x' })).status, 200);
  assert.equal((await api().put('/api/codes').send({ system: 'snomed', code: '1', display: 'y', addedBy: 'me' })).status, 400);
  assert.equal((await api().get('/api/codes')).body[0].display, 'x');
  await api().put('/api/bindings').send({ setId: 's', fieldId: 'f', system: 'loinc', code: '2', display: 'z' });
  assert.equal((await api().get('/api/bindings')).body.length, 1);
  assert.equal((await api().delete('/api/bindings/s/f')).status, 204);
  await api().put('/api/prefs/pinned').send({ value: ['care.vitals'] });
  assert.deepEqual((await api().get('/api/prefs')).body.pinned, ['care.vitals']);
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
