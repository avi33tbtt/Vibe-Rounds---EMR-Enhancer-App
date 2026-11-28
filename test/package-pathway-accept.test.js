'use strict';
// Task D8: accept ONE staged pathway proposal as a DRAFT pathway; members are matched by SOURCE and must be published first. Matrix and audit scenario: safety-routes.test.js.
// Every case stages, accepts, reviews and publishes through the real routes. Fixtures are small synthetic CCIS documents. Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setup, client, reviewers } = require('./helpers');

let env, C, R;
test.before(async () => { env = await setup(); C = await import(pathToFileURL(path.join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href); R = await reviewers(env.base); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const sum = doc => C.checksumOf(C.canonicalize(doc).text);
const art = doc => ({ checksum: sum(doc), document: doc });
const man = (id, type, name) => ({ id, name, type, version: '0.1.0', status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } });
const loc = code => ({ codeSystem: { id: 'local', version: '0.1.0' }, code, mapping: { status: 'mapped' } });
const TERMS = { manifest: man('t.terms', 'terminology-package', 'Terms'), codeSystem: { id: 'local', version: '0.1.0' }, concepts: [{ key: 'pulse-rate', display: 'Pulse rate' }, { key: 'note-text', display: 'Note' }] };
const el = (id, name, concept, fid) => ({ manifest: man(id, 'contextual-element', name), intent: { purpose: 'Record information.' }, provenance: { origin: 'x', basis: 'Synthetic basis.' },
  fields: [{ key: 'f', label: 'Field', type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 1 }, concept: loc(concept), 'x-emrFieldId': fid }] });
const pw = (id, name, ...ids) => ({ manifest: man(id, 'pathway', name), scope: 'Scope.', elements: ids.map(i => ({ id: i, type: 'contextual-element', range: '0.1.0' })), stages: [],
  entryForm: { sections: [{ id: 'main', label: 'Main', items: ids.map(i => ({ kind: 'element', element: i })) }] }, contexts: [{ id: 'ctx', label: 'Context', elements: ids }] });
const bundle = (...docs) => ({ format: 'ccis-package-bundle/1', artefacts: [TERMS, ...docs].map(art) });
const stage = async (c, ...docs) => { const r = await c.post('/api/import/packages', bundle(...docs)); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.import; };
const acceptSet = async (c, p) => { const r = await c.post(`/api/import/package-proposals/${p.id}/accept`, { rowVersion: 1 }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.setId; };
const acceptPath = (c, id, rowVersion = 1, extra = {}) => c.post(`/api/import/package-proposals/${id}/accept-pathway`, { rowVersion, ...extra });
async function publishSet(d, setId) {
  assert.equal((await d.post(`/api/element-sets/${setId}/versions/1/submit`, {})).status, 200);
  for (const inf of [R.inf1, R.inf2]) { const a = await inf.post(`/api/element-sets/${setId}/versions/1/approve`, { reason: 'Test approval' }); if (a.body.status === 'reviewed') break; }
  const r = await (await as('admin1')).post(`/api/element-sets/${setId}/versions/1/publish`, {}); assert.equal(r.status, 200, JSON.stringify(r.body));
}
// stage a pathway package of two elements; accept (and optionally publish) both sets; returns the pathway proposal
async function ready(d, tag, publish = true) {
  const a = el(tag + '.a', 'Alpha', 'pulse-rate', 'hr_bpm'), b = el(tag + '.b', 'Beta', 'note-text', 'note_x'), imp = await stage(d, b, a, pw(tag + '.path', 'Secretive Path', tag + '.a', tag + '.b'));
  const sets = imp.proposals.filter(p => p.kind === 'set');
  for (const s of sets) { const id = await acceptSet(d, s); if (publish) await publishSet(d, id); }
  return imp.proposals.find(p => p.kind === 'pathway');
}
const count = async t => Number((await env.pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);

test('1. full flow: sets published, pathway accepted as draft v1 with steps in layout order, entry_form, contexts and source stored', async () => {
  const d = await as('doctor1'), p = await ready(d, 'pa1'), r = await acceptPath(d, p.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = (await env.pool.query(`SELECT v.*, u.username, pa.slug FROM pathway_versions v JOIN pathways pa ON pa.id = v.pathway_id JOIN users u ON u.id = v.created_by WHERE pa.id = $1`, [r.body.pathwayId])).rows;
  assert.equal(v.length, 1); assert.equal(v[0].version, 1); assert.equal(v[0].status, 'draft'); assert.equal(v[0].username, 'doctor1'); assert.equal(v[0].slug, 'pa1-path');
  assert.equal(v[0].source_artefact_id, 'pa1.path'); assert.equal(v[0].source_version, '0.1.0'); assert.match(v[0].source_checksum, /^[0-9a-f]{64}$/);
  assert.equal(v[0].entry_form.sections[0].id, 'main'); assert.equal(v[0].contexts[0].id, 'ctx');
  const steps = (await env.pool.query(`SELECT s.slug FROM pathway_version_steps st JOIN element_sets s ON s.id = st.element_set_id WHERE st.pathway_version_id = $1 ORDER BY st.position`, [v[0].id])).rows.map(x => x.slug);
  assert.deepEqual(steps, ['pa1-a', 'pa1-b']);
  assert.equal((await env.pool.query('SELECT status, accepted_ref FROM package_proposals WHERE id = $1', [p.id])).rows[0].accepted_ref, r.body.pathwayId);
});

test('2. sets still draft: 409 member_not_published, nothing is written', async () => {
  const d = await as('doctor1'), p = await ready(d, 'pa2', false), before = await count('pathways');
  const r = await acceptPath(d, p.id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'member_not_published'); assert.deepEqual(r.body.sets.sort(), ['pa2-a', 'pa2-b']);
  assert.equal(await count('pathways'), before);
  assert.equal((await env.pool.query('SELECT status FROM package_proposals WHERE id = $1', [p.id])).rows[0].status, 'staged');
});

test('3. a published set of ANOTHER artefact with the same slug does not satisfy a step (matched by source)', async () => {
  const d = await as('doctor1');
  const other = el('pa3-a', 'Other', 'pulse-rate', 'hr_bpm'), imp0 = await stage(d, other);   // artefact id pa3-a gives slug pa3-a, like pa3.a
  await publishSet(d, await acceptSet(d, imp0.proposals.find(x => x.kind === 'set')));
  const imp = await stage(d, el('pa3.b', 'Beta', 'note-text', 'note_x'), el('pa3.a', 'Alpha', 'pulse-rate', 'hr_bpm'), pw('pa3.path', 'Path', 'pa3.a', 'pa3.b'));
  const b = imp.proposals.find(x => x.slug === 'pa3-b'); await publishSet(d, await acceptSet(d, b));
  const r = await acceptPath(d, imp.proposals.find(x => x.kind === 'pathway').id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'member_not_published'); assert.deepEqual(r.body.sets, ['pa3-a']);
});

test('4. wrong roles are refused; a set proposal, a blocked pathway, a stale and a repeated accept give named codes', async () => {
  const d = await as('doctor1'), p = await ready(d, 'pa4'), before = await count('pathways');
  for (const u of ['nurse1', 'viewer1', 'informatician1']) assert.equal((await acceptPath(await as(u), p.id)).status, 403, u);
  assert.equal((await acceptPath(client(env.base), p.id)).status, 401);
  assert.equal(await count('pathways'), before);
  const imp = await stage(d, el('pa4x.a', 'A', 'pulse-rate', 'hr_bpm'), pw('pa4x.path', 'Bad', 'pa4x.a', 'pa4x.missing'));
  assert.equal((await acceptPath(d, imp.proposals.find(x => x.kind === 'set').id)).body.error, 'not_a_pathway');
  assert.equal((await acceptPath(d, imp.proposals.find(x => x.kind === 'pathway').id)).body.error, 'not_ready');
  assert.equal((await acceptPath(d, p.id, 9)).body.error, 'version_conflict');
  assert.equal((await acceptPath(d, p.id)).status, 200);
  assert.equal((await acceptPath(d, p.id, 2)).body.error, 'proposal_final');
});

test('5. a taken slug and an artefact version imported before are 409', async () => {
  const d = await as('admin1');
  const p = await ready(d, 'pa5');
  assert.equal((await d.post('/api/pathways', { slug: 'pa5-path', title: 'Taken', steps: [{ setId: (await env.pool.query(`SELECT element_set_id id FROM element_set_versions WHERE source_artefact_id = 'pa5.a'`)).rows[0].id, version: 1 }] })).status, 201);
  assert.equal((await acceptPath(d, p.id)).body.error, 'slug_taken');
  const q = await ready(d, 'pa5y');
  assert.equal((await acceptPath(d, q.id)).status, 200);
  const dup = await stage(d, el('pa5y.b', 'Beta', 'note-text', 'note_x'), el('pa5y.a', 'Alpha', 'pulse-rate', 'hr_bpm'), pw('pa5y.path', 'Secretive Path', 'pa5y.a', 'pa5y.b'), el('pa5y.filler', 'F', 'pulse-rate', 'hr_bpm'));
  const r = await acceptPath(d, dup.proposals.find(x => x.kind === 'pathway').id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'already_imported');
});

test('6. an extra or user-naming field is 400; the audit holds ids only, no title', async () => {
  const d = await as('doctor1'), p = await ready(d, 'pa6');
  assert.equal((await acceptPath(d, p.id, 1, { createdBy: 1 })).status, 400);
  assert.equal((await d.post(`/api/import/package-proposals/${p.id}/accept-pathway`, {})).status, 400);
  assert.equal((await acceptPath(d, p.id)).status, 200);
  const a = (await env.pool.query(`SELECT username, detail FROM audit_log WHERE action = 'import.package_accept_pathway' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(a.username, 'doctor1'); assert.ok(a.detail.pathwayId >= 1); assert.ok(!/Secretive|Alpha|Synthetic|Main/.test(JSON.stringify(a.detail)));
});

test('7. the admin publishes the draft pathway through the existing route; checksum, layout and source unchanged', async () => {
  const d = await as('doctor1'), p = await ready(d, 'pa7'), r = await acceptPath(d, p.id), before = (await env.pool.query('SELECT checksum FROM pathway_versions WHERE pathway_id = $1', [r.body.pathwayId])).rows[0].checksum;
  const pub = await (await as('admin1')).post(`/api/pathways/${r.body.pathwayId}/versions/1/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const v = (await env.pool.query('SELECT * FROM pathway_versions WHERE pathway_id = $1', [r.body.pathwayId])).rows[0];
  assert.equal(v.status, 'published'); assert.equal(v.checksum, before); assert.equal(v.source_artefact_id, 'pa7.path'); assert.equal(v.entry_form.sections[0].id, 'main');
});

test('8. hostile text in a staged title is refused with 422 and nothing is written', async () => {
  const d = await as('doctor1'), p = await ready(d, 'pa8'), before = await count('pathways');
  await env.pool.query('ALTER TABLE package_proposals DISABLE TRIGGER package_proposals_guard');
  await env.pool.query(`UPDATE package_proposals SET body = jsonb_set(body, '{title}', '"<script>alert(1)</script>"'::jsonb) WHERE id = $1`, [p.id]);
  await env.pool.query('ALTER TABLE package_proposals ENABLE TRIGGER package_proposals_guard');
  const r = await acceptPath(d, p.id);
  assert.equal(r.status, 422); assert.equal(r.body.error, 'invalid_pathway'); assert.equal(await count('pathways'), before);
});
