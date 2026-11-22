'use strict';
// Task B2a: versioned element sets (server). Runs against real PostgreSQL; the app runs as the restricted emr_app role.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup, client } = require('./helpers');
const { checksumOf, canonicalJson } = require('../sets');

let env, admin, doctor, nurse, viewer;
const uid = async name => (await env.pool.query('SELECT id FROM users WHERE username = $1', [name])).rows[0].id;
const audits = async action => (await env.pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;
const counts = async () => ({
  sets: Number((await env.pool.query('SELECT count(*) n FROM element_sets')).rows[0].n),
  versions: Number((await env.pool.query('SELECT count(*) n FROM element_set_versions')).rows[0].n),
});
let n = 0;
const slug = () => 'set-' + (++n);
const DEF = (title = 'Sepsis bundle', extra = {}) => ({
  title, desc: 'Demo set (synthetic).',
  fields: [{ id: 'lac', label: 'Lactate', type: 'text', unit: 'mmol/L' }, { id: 'src', label: 'Source', type: 'select', options: ['Lung', 'Urine'] }],
  ...extra,
});
async function newSet(who = doctor, def = DEF(), kind = 'custom') {
  const r = await who.post('/api/element-sets', { slug: slug(), kind, definition: def });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body;
}
const publish = async (setId, v, who = admin, body = {}) => who.post(`/api/element-sets/${setId}/versions/${v}/publish`, body);

test.before(async () => {
  env = await setup();
  admin = client(env.base); doctor = client(env.base); nurse = client(env.base); viewer = client(env.base);
  for (const [c, u] of [[admin, 'admin1'], [doctor, 'doctor1'], [nurse, 'nurse1'], [viewer, 'viewer1']]) assert.equal((await c.login(u)).status, 200);
});
test.after(async () => { await env.close(); });

test('checksum is the sha256 of canonical JSON: key order does not matter, content does', () => {
  assert.equal(canonicalJson({ b: [true, 'x'], a: { d: 'y', c: 'z' } }), '{"a":{"c":"z","d":"y"},"b":[true,"x"]}');
  const want = crypto.createHash('sha256').update('{"a":["x"],"b":true}', 'utf8').digest('hex');
  assert.equal(checksumOf({ b: true, a: ['x'] }), want);
  assert.notEqual(checksumOf({ a: ['x'], b: false }), want);
});

test('create a set: draft version 1, creator from the session, checksum computed by the server, definition read back unchanged', async () => {
  const def = { fields: DEF().fields, desc: 'Demo set (synthetic).', title: 'Key order is irrelevant' };   // keys deliberately in another order
  const out = await newSet(doctor, def, 'disease');
  assert.equal(out.set.kind, 'disease'); assert.equal(out.set.status, 'active'); assert.equal(out.set.title, 'Key order is irrelevant');
  assert.equal(out.version.version, 1); assert.equal(out.version.status, 'draft'); assert.equal(out.version.created_by, 'doctor1');
  assert.equal(out.version.checksum, checksumOf(def));
  const got = await viewer.get(`/api/element-sets/${out.set.id}/versions/1`);
  assert.equal(got.status, 200); assert.deepEqual(got.body.version.definition, def); assert.equal(got.body.version.published_by, null);
  const one = await viewer.get(`/api/element-sets/${out.set.id}`);
  assert.deepEqual(one.body.versions.map(v => [v.version, v.status]), [[1, 'draft']]);
  assert.ok(!('definition' in one.body.versions[0]), 'the set view lists versions without their content');
  const row = (await env.pool.query('SELECT created_by FROM element_set_versions WHERE element_set_id = $1', [out.set.id])).rows[0];
  assert.equal(row.created_by, await uid('doctor1'));
});

test('list and read: every role may read; list shows latest and published version; kind filter; unknown ids are 404', async () => {
  const a = await newSet(doctor, DEF('List A'), 'care'); await publish(a.set.id, 1);
  const b = await newSet(doctor, DEF('List B'), 'template');
  for (const c of [viewer, nurse]) {
    const r = await c.get('/api/element-sets');
    assert.equal(r.status, 200);
    const sa = r.body.sets.find(s => s.id === a.set.id), sb = r.body.sets.find(s => s.id === b.set.id);
    assert.deepEqual([sa.latest_version, sa.published_version], [1, 1]);
    assert.deepEqual([sb.latest_version, sb.published_version], [1, null]);
  }
  const care = await viewer.get('/api/element-sets?kind=care');
  assert.ok(care.body.sets.length >= 1 && care.body.sets.every(s => s.kind === 'care'));
  assert.equal((await viewer.get('/api/element-sets?kind=pathway')).status, 400);
  assert.equal((await viewer.get('/api/element-sets/999999')).status, 404);
  assert.equal((await viewer.get('/api/element-sets/abc')).status, 404);
  assert.equal((await viewer.get(`/api/element-sets/${a.set.id}/versions/7`)).status, 404);
  assert.equal((await viewer.get(`/api/element-sets/${a.set.id}/versions/0`)).status, 404);
  assert.equal((await viewer.get(`/api/element-sets/${a.set.id}/versions/x`)).status, 404);
});

test('who may do what: nurse and viewer cannot create; a doctor can create but not publish; only admin publishes and retires', async () => {
  const before = await counts();
  for (const c of [nurse, viewer]) assert.equal((await c.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: DEF() })).status, 403);
  assert.deepEqual(await counts(), before);
  const s = await newSet(doctor);
  assert.equal((await doctor.post(`/api/element-sets/${s.set.id}/versions`, { definition: DEF('v2') })).status, 201);
  for (const c of [nurse, viewer]) assert.equal((await c.post(`/api/element-sets/${s.set.id}/versions`, { definition: DEF('v3') })).status, 403);
  for (const c of [doctor, nurse, viewer]) assert.equal((await publish(s.set.id, 1, c)).status, 403);
  assert.equal((await publish(s.set.id, 1, admin)).status, 200);
  for (const c of [doctor, nurse, viewer]) assert.equal((await c.post(`/api/element-sets/${s.set.id}/versions/1/retire`, {})).status, 403);
});

test('unknown kind and bad slug are rejected and nothing is created; a taken slug is 409 and audited', async () => {
  const before = await counts();
  for (const kind of ['pathway', 'Custom', '', 5, undefined]) {
    const r = await doctor.post('/api/element-sets', { slug: slug(), kind, definition: DEF() });
    assert.equal(r.status, 400, String(kind)); assert.equal(r.body.error, 'invalid');
  }
  for (const bad of ['', 'Upper', '-lead', 'has space', 'x'.repeat(65), 7, null]) {
    assert.equal((await doctor.post('/api/element-sets', { slug: bad, kind: 'custom', definition: DEF() })).status, 400, String(bad));
  }
  assert.deepEqual(await counts(), before);
  const first = await newSet();
  const dup = await doctor.post('/api/element-sets', { slug: first.set.slug, kind: 'custom', definition: DEF('Another') });
  assert.equal(dup.status, 409); assert.equal(dup.body.error, 'slug_taken');
  assert.equal((await audits('set.create_rejected')).at(-1).detail.reason, 'slug_taken');
  assert.equal((await counts()).sets, before.sets + 1);
});

test('forged actor and state fields are refused, nothing is written; the recorded publisher is the session user', async () => {
  const before = await counts();
  for (const forged of [{ createdBy: 1 }, { created_by: 1 }, { publishedBy: 1 }, { status: 'published' }, { version: 9 }, { userId: 1 }]) {
    const r = await doctor.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: DEF(), ...forged });
    assert.equal(r.status, 400, JSON.stringify(forged)); assert.equal(r.body.error, 'unknown_field');
  }
  assert.deepEqual(await counts(), before);
  const s = await newSet();
  const v2 = await doctor.post(`/api/element-sets/${s.set.id}/versions`, { definition: DEF('v2'), createdBy: 1, version: 1 });
  assert.equal(v2.status, 400); assert.equal(v2.body.error, 'unknown_field');
  for (const forged of [{ publishedBy: await uid('doctor1') }, { published_by: 1 }, { status: 'published' }]) {
    const r = await publish(s.set.id, 1, admin, forged);
    assert.equal(r.status, 400, JSON.stringify(forged)); assert.equal(r.body.error, 'unknown_field');
  }
  const still = (await env.pool.query('SELECT status, published_by FROM element_set_versions WHERE element_set_id = $1', [s.set.id])).rows[0];
  assert.deepEqual([still.status, still.published_by], ['draft', null]);
  const ok = await publish(s.set.id, 1);
  assert.equal(ok.status, 200); assert.equal(ok.body.version.published_by, 'admin1');
  assert.equal((await env.pool.query('SELECT published_by FROM element_set_versions WHERE element_set_id = $1', [s.set.id])).rows[0].published_by, await uid('admin1'));
});

test('a new version increments by one, even when several are created at the same moment', async () => {
  const s = await newSet();
  const v2 = await doctor.post(`/api/element-sets/${s.set.id}/versions`, { definition: DEF('v2') });
  const v3 = await doctor.post(`/api/element-sets/${s.set.id}/versions`, { definition: DEF('v3') });
  assert.deepEqual([v2.body.version.version, v3.body.version.version], [2, 3]);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(i => (i % 2 ? doctor : admin).post(`/api/element-sets/${s.set.id}/versions`, { definition: DEF('race ' + i) })));
  assert.ok(rs.every(r => r.status === 201), JSON.stringify(rs.map(r => r.status)));
  assert.deepEqual(rs.map(r => r.body.version.version).sort(), [4, 5, 6, 7, 8]);
  const all = await viewer.get(`/api/element-sets/${s.set.id}`);
  assert.deepEqual(all.body.versions.map(v => v.version), [8, 7, 6, 5, 4, 3, 2, 1]);
});

test('checksum mismatch is rejected on create, on new version and on publish; the server computes it', async () => {
  const def = DEF('Checksum set'), good = checksumOf(def), wrong = checksumOf({ title: 'something else', fields: [] });
  const before = await counts();
  const r1 = await doctor.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: def, checksum: wrong });
  assert.equal(r1.status, 400); assert.equal(r1.body.error, 'checksum_mismatch');
  assert.equal((await doctor.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: def, checksum: 'not-hex' })).status, 400);
  assert.deepEqual(await counts(), before);
  const ok = await doctor.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: def, checksum: good });
  assert.equal(ok.status, 201); assert.equal(ok.body.version.checksum, good);
  const id = ok.body.set.id;
  const r2 = await doctor.post(`/api/element-sets/${id}/versions`, { definition: DEF('v2'), checksum: wrong });
  assert.equal(r2.status, 400); assert.equal(r2.body.error, 'checksum_mismatch');
  assert.equal((await viewer.get(`/api/element-sets/${id}`)).body.versions.length, 1);
  // publishing: the publisher may confirm the checksum they saw; a different one is refused and audited
  const r3 = await publish(id, 1, admin, { checksum: wrong });
  assert.equal(r3.status, 409); assert.equal(r3.body.error, 'checksum_mismatch');
  assert.equal((await audits('set.publish_rejected')).at(-1).detail.reason, 'checksum_mismatch');
  assert.equal((await viewer.get(`/api/element-sets/${id}`)).body.versions[0].status, 'draft');
  // content changed behind the server's back (a draft is not locked in the database): the stored checksum no longer matches, so it is not published
  await env.pool.query(`UPDATE element_set_versions SET definition_json = jsonb_set(definition_json, '{title}', '"tampered"') WHERE element_set_id = $1`, [id]);
  const r4 = await publish(id, 1);
  assert.equal(r4.status, 409); assert.equal(r4.body.error, 'checksum_mismatch');
  assert.equal((await viewer.get(`/api/element-sets/${id}`)).body.versions[0].status, 'draft');
});

test('content must be declarative data: unknown keys, code-like text, numbers, broken characters and oversize are refused', async () => {
  const f = (over = {}) => ({ id: 'a', label: 'A', type: 'text', ...over });
  const cases = {
    'no title': { fields: [f()] },
    'blank title': { title: '  ', fields: [f()] },
    'no fields': { title: 'T' },
    'empty fields': { title: 'T', fields: [] },
    'unknown top-level key (rules)': { ...DEF(), rules: [{ if: 'x > 1', then: 'alert' }] },
    'unknown top-level key (script)': { ...DEF(), script: 'doIt()' },
    'unknown field key (formula)': { title: 'T', fields: [f({ formula: 'a + b' })] },
    'unknown field key (expression)': { title: 'T', fields: [f({ expression: '1+1' })] },
    '<script> in a label': { title: 'T', fields: [f({ label: 'x <script>alert(1)</script>' })] },
    'event handler in a description': { title: 'T', desc: 'a" onclick="x()', fields: [f()] },
    'javascript: URL in a citation': { title: 'T', citation: 'javascript:alert(1)', fields: [f()] },
    'HTML tag in an option': { title: 'T', fields: [f({ type: 'select', options: ['<img src=x>'] })] },
    'select without options': { title: 'T', fields: [f({ type: 'select' })] },
    'options on a text field': { title: 'T', fields: [f({ options: ['a'] })] },
    'unknown field type': { title: 'T', fields: [f({ type: 'script' })] },
    'duplicate field id': { title: 'T', fields: [f(), f()] },
    'bad field id': { title: 'T', fields: [f({ id: 'a b' })] },
    'a number where text is expected': { title: 'T', fields: [f({ unit: 5 })] },
    'null value': { title: 'T', desc: null, fields: [f()] },
    'the original Questionnaire is not stored': { title: 'T', fields: [f()], sdc: { url: 'http://x.org/q', original: { resourceType: 'Questionnaire' } } },
    'binding with an unknown key': { title: 'T', fields: [f({ bindings: [{ system: 'snomed', code: '1', verified: true }] })] },
    'binding with an unknown source': { title: 'T', fields: [f({ bindings: [{ system: 'snomed', code: '1', source: 'hack' }] })] },
    'NUL character': { title: 'T', desc: 'a\u0000b', fields: [f()] },
    'lone surrogate': { title: 'T', desc: 'a\ud800b', fields: [f()] },
    'too many fields': { title: 'T', fields: Array.from({ length: 201 }, (_, i) => f({ id: 'f' + i })) },
    'too deeply nested': { title: 'T', fields: [f({ bindings: [{ system: 's', code: 'c', display: 'd', extra: { a: { b: { c: { d: { e: { f: { g: {} } } } } } } } }] })] },
    'a list instead of an object': [DEF()],
    'text instead of an object': 'DEF',
  };
  const before = await counts();
  const target = await newSet(); const before2 = await counts();
  for (const [name, def] of Object.entries(cases)) {
    const r = await doctor.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: def });
    assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error, 'invalid_definition', name);
    assert.ok(Array.isArray(r.body.errors) && r.body.errors.length, name);
    const r2 = await doctor.post(`/api/element-sets/${target.set.id}/versions`, { definition: def });
    assert.equal(r2.status, 400, `new version, ${name}`); assert.equal(r2.body.error, 'invalid_definition', name);
  }
  assert.deepEqual(await counts(), before2, 'nothing was stored for any refused definition');
  assert.equal(before2.sets, before.sets + 1);
  // a definition that is too big for one version
  // (under the 50 kb request-body limit, over the 40000-byte definition limit)
  const big = { title: 'Big', desc: 'x'.repeat(1900), fields: Array.from({ length: 40 }, (_, i) => ({ id: 'f' + i, label: 'L'.repeat(190), type: 'text', rationale: 'r'.repeat(900) })) };
  assert.ok(JSON.stringify(big).length < 50 * 1024 && JSON.stringify(big).length > 40000);
  const rb = await doctor.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: big });
  assert.equal(rb.status, 400, JSON.stringify(rb.body)); assert.match(rb.body.message, /larger than 40000 bytes/);
  assert.deepEqual(await counts(), before2);
  // a normal definition with a binding, a citation and an SDC reference is accepted
  const fine = { title: 'Fine', citation: 'Local guideline 2026', sdc: { url: 'http://example.org/q', modified: false },
    fields: [f({ bindings: [{ system: 'snomed', code: '73211009', display: 'Diabetes mellitus', source: 'manual' }], codingPolicy: { mode: 'custom', systems: ['snomed'] }, repeat: true, required: true })] };
  assert.equal((await doctor.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: fine })).status, 201);
});

test('publish: only a draft can be published; the version is then frozen by the API and by the database', async () => {
  const s = await newSet(doctor, DEF('Frozen set'));
  const id = s.set.id;
  const p = await publish(id, 1);
  assert.equal(p.status, 200); assert.equal(p.body.version.status, 'published'); assert.ok(p.body.version.published_at);
  assert.equal((await publish(id, 1)).status, 409);
  assert.equal((await publish(id, 9)).status, 404);
  // there is no route that edits a version
  for (const m of ['PUT', 'PATCH']) {
    const r = await doctor.raw(m, `/api/element-sets/${id}/versions/1`, { definition: DEF('changed') });
    assert.equal(r.status, 404, m);
  }
  const stored = async () => (await env.pool.query('SELECT definition_json, checksum, status, published_by FROM element_set_versions WHERE element_set_id = $1 AND version = 1', [id])).rows[0];
  const frozen = await stored();
  // the database refuses changes even for the owner connection
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET definition_json = '{"title":"x","fields":[]}' WHERE element_set_id = $1`, [id]), /immutable/);
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET checksum = repeat('0', 64) WHERE element_set_id = $1`, [id]), /immutable/);
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET published_by = $2 WHERE element_set_id = $1`, [id, await uid('doctor1')]), /immutable/);
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET published_at = now() + interval '1 day' WHERE element_set_id = $1`, [id]), /immutable/);
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET status = 'draft' WHERE element_set_id = $1`, [id]), /cannot go back/);
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET version = 5 WHERE element_set_id = $1`, [id]), /identity/);
  await assert.rejects(env.pool.query(`UPDATE element_sets SET slug = 'renamed' WHERE id = $1`, [id]), /identity/);
  await assert.rejects(env.pool.query(`UPDATE element_sets SET kind = 'care' WHERE id = $1`, [id]), /identity/);
  await assert.rejects(env.pool.query(`DELETE FROM element_set_versions WHERE element_set_id = $1`, [id]), /append-only/);
  await assert.rejects(env.pool.query('DELETE FROM element_sets WHERE id = $1', [id]), /append-only/);
  await assert.rejects(env.pool.query('TRUNCATE element_set_versions'), /append-only|referenced in a foreign key/);   // since 8c the reviews table references versions
  await assert.rejects(env.pool.query('TRUNCATE element_sets CASCADE'), /append-only|referenced in a foreign key/);
  assert.deepEqual(await stored(), frozen, 'nothing changed');
  // a second version of the set is a new row; version 1 stays as it was
  const v2 = await doctor.post(`/api/element-sets/${id}/versions`, { definition: DEF('Frozen set, edited') });
  assert.equal(v2.body.version.version, 2);
  assert.deepEqual(await stored(), frozen);
  assert.deepEqual((await viewer.get(`/api/element-sets/${id}/versions/1`)).body.version.definition, DEF('Frozen set'));
});

test('the app role can only change what publish and retire change: no DELETE, no TRUNCATE, no content updates', async () => {
  const s = await newSet(doctor, DEF('Grants set'));
  const id = s.set.id;
  for (const t of ['element_sets', 'element_set_versions']) {
    for (const priv of ['DELETE', 'TRUNCATE']) assert.equal((await env.pool.query(`SELECT has_table_privilege('emr_app', $1, $2) ok`, [t, priv])).rows[0].ok, false, `${priv} on ${t}`);
  }
  assert.equal((await env.appPool.query('SELECT current_user u')).rows[0].u, 'emr_app');
  const denied = /permission denied/;
  for (const q of [
    `UPDATE element_set_versions SET definition_json = '{}' WHERE element_set_id = ${id}`,
    `UPDATE element_set_versions SET checksum = repeat('1', 64) WHERE element_set_id = ${id}`,
    `UPDATE element_set_versions SET created_by = 1 WHERE element_set_id = ${id}`,
    `UPDATE element_sets SET slug = 'x' WHERE id = ${id}`,
    `UPDATE element_sets SET kind = 'care' WHERE id = ${id}`,
    `DELETE FROM element_set_versions WHERE element_set_id = ${id}`,
    `DELETE FROM element_sets WHERE id = ${id}`,
    `TRUNCATE element_set_versions`,
  ]) await assert.rejects(env.appPool.query(q), denied, q);
});

test('retire: published -> retired; the set retires when no live version is left; a new draft brings it back', async () => {
  const s = await newSet(doctor, DEF('Retire set'));
  const id = s.set.id;
  const early = await admin.post(`/api/element-sets/${id}/versions/1/retire`, {});
  assert.equal(early.status, 409); assert.equal(early.body.error, 'not_published');
  assert.equal((await admin.post(`/api/element-sets/${id}/versions/1/retire`, { retiredBy: 1 })).status, 400);
  assert.equal((await publish(id, 1)).status, 200);
  const v2 = await doctor.post(`/api/element-sets/${id}/versions`, { definition: DEF('Retire set v2') });
  assert.equal((await publish(id, 2)).status, 200);
  assert.equal((await viewer.get(`/api/element-sets/${id}`)).body.set.title, 'Retire set v2', 'the set shows the title of the latest published version');
  const r1 = await admin.post(`/api/element-sets/${id}/versions/1/retire`, {});
  assert.equal(r1.status, 200); assert.equal(r1.body.version.status, 'retired'); assert.equal(r1.body.version.retired_by, 'admin1'); assert.equal(r1.body.set.status, 'active');
  assert.equal((await publish(id, 1)).status, 409, 'a retired version cannot be published again');
  assert.equal((await admin.post(`/api/element-sets/${id}/versions/1/retire`, {})).status, 409);
  const r2 = await admin.post(`/api/element-sets/${id}/versions/2/retire`, {});
  assert.equal(r2.status, 200); assert.equal(r2.body.set.status, 'retired');
  // retired content stays readable and unchanged
  assert.deepEqual((await viewer.get(`/api/element-sets/${id}/versions/2`)).body.version.definition, DEF('Retire set v2'));
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET definition_json = '{}' WHERE element_set_id = $1`, [id]), /immutable/);
  const v3 = await doctor.post(`/api/element-sets/${id}/versions`, { definition: DEF('Retire set v3') });
  assert.equal(v3.body.version.version, 3); assert.equal(v3.body.set.status, 'active');
  assert.equal(v2.body.version.version, 2);
});

test('every write is audited from the session; the audit rows hold the checksum, never the content', async () => {
  const from = (await env.pool.query('SELECT max(id) m FROM audit_log')).rows[0].m;
  const secret = 'Distinctive label text 7741';
  const s = await newSet(doctor, DEF(secret));
  const v2 = await doctor.post(`/api/element-sets/${s.set.id}/versions`, { definition: DEF(secret + ' v2') });
  await publish(s.set.id, 1); await admin.post(`/api/element-sets/${s.set.id}/versions/1/retire`, {});
  const rows = (await env.pool.query('SELECT * FROM audit_log WHERE id > $1 ORDER BY id', [from])).rows;
  const by = a => rows.filter(r => r.action === a && r.entity_id === String(s.set.id));
  assert.equal(by('set.create')[0].username, 'doctor1'); assert.equal(by('set.create')[0].detail.checksum, s.version.checksum);
  assert.equal(by('set.version_create')[0].username, 'doctor1'); assert.equal(by('set.version_create')[0].detail.version, v2.body.version.version);
  assert.equal(by('set.publish')[0].username, 'admin1'); assert.equal(by('set.publish')[0].role, 'admin');
  assert.equal(by('set.retire')[0].username, 'admin1');
  for (const r of by('set.create').concat(by('set.version_create'), by('set.publish'), by('set.retire'))) assert.ok(r.user_id && r.detail.slug === s.set.slug, r.action);
  assert.ok(!JSON.stringify(rows).includes(secret), 'content stays out of the audit log');
  // a refused permission is audited too
  await nurse.post('/api/element-sets', { slug: slug(), kind: 'custom', definition: DEF() });
  assert.equal((await audits('permission.denied')).at(-1).detail.perm, 'sets:write');
});
