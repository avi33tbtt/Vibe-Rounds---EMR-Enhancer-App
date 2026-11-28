'use strict';
// Task D4: source artefact columns on set and pathway versions, and entry_form / contexts on pathway versions (insert-only).
// Needs PostgreSQL (TEST_DATABASE_URL, a scratch database). Prototype. Synthetic data only. Not for clinical use.
// The upgrade-from-every-earlier-version check is covered by test/safety-migrations.test.js (it reads every migration file).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, seq = 0, set, pathwayId, adminId;
const SUM = 'a'.repeat(64);
const SRC = { id: 'dm.core', ver: '0.2.0', sum: SUM };
test.before(async () => {
  env = await setup(); R = await reviewers(env.base); admin = client(env.base);
  assert.equal((await admin.login('admin1')).status, 200);
  const made = await R.doctor.post('/api/element-sets', { slug: 'src-set', kind: 'custom', definition: { title: 'S', fields: [{ id: 'x', label: 'X', type: 'text' }] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  set = { id: made.body.set.id };
  adminId = (await env.pool.query(`SELECT id FROM users WHERE username = 'admin1'`)).rows[0].id;
  pathwayId = (await env.pool.query(`INSERT INTO pathways(slug, title, created_by) VALUES ('src-pw','P',$1) RETURNING id`, [adminId])).rows[0].id;
});
test.after(async () => { await env.close(); });

const q = (sql, p) => env.pool.query(sql, p);
// a new draft set version copied from the published one, with the given source columns
async function setVersion(src = {}) {
  const n = ++seq + 1;
  return (await q(`INSERT INTO element_set_versions(element_set_id, version, definition_json, checksum, created_by, source_artefact_id, source_version, source_checksum)
    SELECT element_set_id, $2, definition_json, checksum, created_by, $3, $4, $5 FROM element_set_versions WHERE element_set_id = $1 AND version = 1 RETURNING id`,
    [set.id, n, src.id ?? null, src.ver ?? null, src.sum ?? null])).rows[0].id;
}
async function pathVersion(extra = {}) {
  const n = ++seq;
  return (await q(`INSERT INTO pathway_versions(pathway_id, version, title, checksum, created_by, source_artefact_id, source_version, source_checksum, entry_form, contexts)
    VALUES ($1,$2,'P',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [pathwayId, n, SUM, adminId, extra.id ?? null, extra.ver ?? null, extra.sum ?? null, extra.form ?? null, extra.ctx ?? null])).rows[0].id;
}

test('1. a set version and a pathway version store all three source columns, unchanged', async () => {
  const s = await setVersion({ id: SRC.id, ver: SRC.ver, sum: SRC.sum });
  const p = await pathVersion({ id: SRC.id, ver: SRC.ver, sum: SRC.sum, form: '{"sections":[]}', ctx: '[{"id":"dm"}]' });
  const a = (await q('SELECT source_artefact_id a, source_version v, source_checksum c FROM element_set_versions WHERE id = $1', [s])).rows[0];
  const b = (await q('SELECT source_artefact_id a, source_version v, source_checksum c, entry_form f, contexts x FROM pathway_versions WHERE id = $1', [p])).rows[0];
  assert.deepEqual(a, { a: 'dm.core', v: '0.2.0', c: SUM });
  assert.deepEqual([b.a, b.v, b.c], ['dm.core', '0.2.0', SUM]);
  assert.deepEqual(b.f, { sections: [] }); assert.deepEqual(b.x, [{ id: 'dm' }]);
});

test('2. one or two source columns without the rest are refused on both tables', async () => {
  for (const bad of [{ id: 'dm.core' }, { id: 'dm.core', ver: '1' }, { ver: '1', sum: SUM }]) {
    await assert.rejects(setVersion(bad), /source_all_or_none/);
    await assert.rejects(pathVersion(bad), /source_all_or_none/);
  }
});

test('3. a bad id, an empty or long version and a bad checksum are refused', async () => {
  for (const bad of [{ id: 'Dm.Core', ver: '1', sum: SUM }, { id: 'a'.repeat(65), ver: '1', sum: SUM }, { id: 'dm', ver: '', sum: SUM }, { id: 'dm', ver: 'v'.repeat(65), sum: SUM }, { id: 'dm', ver: '1', sum: 'XYZ' }]) {
    await assert.rejects(setVersion(bad), /violates check constraint/);
    await assert.rejects(pathVersion(bad), /violates check constraint/);
  }
});

test('4. changing a source column by UPDATE is refused on a draft and on a published version', async () => {
  const s = await setVersion({ id: SRC.id, ver: SRC.ver, sum: SRC.sum });
  await assert.rejects(q(`UPDATE element_set_versions SET source_version = '9' WHERE id = $1`, [s]), /source of an element set version never changes/);
  await assert.rejects(q(`UPDATE element_set_versions SET source_artefact_id = NULL, source_version = NULL, source_checksum = NULL WHERE id = $1`, [s]), /never changes/);
  await assert.rejects(q(`UPDATE element_set_versions SET source_version = '9' WHERE element_set_id = $1 AND version = 1`, [set.id]), /never changes/); // published, NULL source
  const p = await pathVersion({ id: SRC.id, ver: SRC.ver, sum: SRC.sum });
  await assert.rejects(q(`UPDATE pathway_versions SET source_checksum = $2 WHERE id = $1`, [p, 'b'.repeat(64)]), /source of a pathway version never changes/);
});

test('5. entry_form and contexts cannot be updated; a wrong JSON type is refused at insert', async () => {
  const p = await pathVersion({ form: '{"sections":[]}', ctx: '[{"id":"dm"}]' });
  await assert.rejects(q(`UPDATE pathway_versions SET entry_form = '{"sections":[1]}' WHERE id = $1`, [p]), /never change/);
  await assert.rejects(q(`UPDATE pathway_versions SET contexts = '[]' WHERE id = $1`, [p]), /never change/);
  const none = await pathVersion();
  await assert.rejects(q(`UPDATE pathway_versions SET entry_form = '{}' WHERE id = $1`, [none]), /never change/); // also from NULL
  await assert.rejects(pathVersion({ form: '[]' }), /violates check constraint/);
  await assert.rejects(pathVersion({ ctx: '{}' }), /violates check constraint/);
});

test('6. a pathway version with source columns still publishes; rows made without them stay NULL', async () => {
  const p = await pathVersion({ id: SRC.id, ver: SRC.ver, sum: SRC.sum, form: '{"sections":[]}' });
  const sv = (await q('SELECT id FROM element_set_versions WHERE element_set_id = $1 AND version = 1', [set.id])).rows[0].id;
  const pv = (await q('SELECT element_set_id FROM element_set_versions WHERE id = $1', [sv])).rows[0];
  await q('INSERT INTO pathway_version_steps(pathway_version_id, position, element_set_id, element_set_version_id) VALUES ($1,1,$2,$3)', [p, pv.element_set_id, sv]);
  await q(`UPDATE pathway_versions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`, [p, adminId]);
  const r = (await q('SELECT status, source_version v FROM pathway_versions WHERE id = $1', [p])).rows[0];
  assert.deepEqual(r, { status: 'published', v: '0.2.0' });
  const old = (await q('SELECT source_artefact_id a, source_version v, source_checksum c FROM element_set_versions WHERE id = $1', [sv])).rows[0];
  assert.deepEqual(old, { a: null, v: null, c: null });
});

test('7. the app role cannot update the new columns or delete a row', async () => {
  const s = await setVersion({ id: SRC.id, ver: SRC.ver, sum: SRC.sum });
  const p = await pathVersion({ form: '{"sections":[]}' });
  await assert.rejects(env.appPool.query(`UPDATE element_set_versions SET source_version = '9' WHERE id = $1`, [s]), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE pathway_versions SET entry_form = '{}' WHERE id = $1`, [p]), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM pathway_versions WHERE id = $1', [p]), /permission denied|not allowed/);
  await assert.rejects(env.appPool.query('DELETE FROM element_set_versions WHERE id = $1', [s]), /permission denied|not allowed/);
});
