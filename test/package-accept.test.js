'use strict';
// Task D7: accept ONE staged set proposal as a DRAFT set (source columns kept). Matrix and audit scenarios are in safety-routes.test.js.
// Fixtures are small hand-written synthetic documents. Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setup, client } = require('./helpers');

let env, C;
test.before(async () => { env = await setup(); C = await import(pathToFileURL(path.join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const sum = doc => C.checksumOf(C.canonicalize(doc).text);
const art = doc => ({ checksum: sum(doc), document: doc });
const clone = x => JSON.parse(JSON.stringify(x));
const man = (id, type, name, version = '0.1.0') => ({ id, name, type, version, status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } });
const loc = code => ({ codeSystem: { id: 'local', version: '0.1.0' }, code, mapping: { status: 'mapped' } });
const TERMS = { manifest: man('t.terms', 'terminology-package', 'Terms'), codeSystem: { id: 'local', version: '0.1.0' }, concepts: [{ key: 'pulse-rate', display: 'Pulse rate' }] };
const el = (id, name = 'Vitals', version = '0.1.0') => ({ manifest: man(id, 'contextual-element', name, version), intent: { purpose: 'Record vital signs.' }, provenance: { origin: 'x', basis: 'Synthetic basis.' },
  fields: [{ key: 'hr', label: 'Heart rate', type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 'unbounded' }, concept: loc('pulse-rate'), 'x-emrFieldId': 'hr_bpm' }] });
const bundle = (...docs) => ({ format: 'ccis-package-bundle/1', artefacts: docs.map(art) });
const stage = async (c, ...docs) => { const r = await c.post('/api/import/packages', bundle(TERMS, ...docs)); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.import; };
const accept = (c, id, rowVersion = 1, extra = {}) => c.post(`/api/import/package-proposals/${id}/accept`, { rowVersion, ...extra });
const count = async t => Number((await env.pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);

test('1. a doctor accepts a ready set: draft set, source columns, concept kept, proposal accepted', async () => {
  const d = await as('doctor1'), doc = el('acc.vitals'), imp = await stage(d, doc), p = imp.proposals[0];
  const r = await accept(d, p.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.proposal.status, 'accepted'); assert.equal(r.body.proposal.row_version, 2);
  const v = (await env.pool.query(`SELECT v.*, s.slug, s.kind, u.username FROM element_set_versions v JOIN element_sets s ON s.id = v.element_set_id JOIN users u ON u.id = v.created_by WHERE s.id = $1`, [r.body.setId])).rows;
  assert.equal(v.length, 1); assert.equal(v[0].version, 1); assert.equal(v[0].status, 'draft'); assert.equal(v[0].slug, 'acc-vitals'); assert.equal(v[0].kind, 'custom'); assert.equal(v[0].username, 'doctor1');
  assert.equal(v[0].source_artefact_id, 'acc.vitals'); assert.equal(v[0].source_version, '0.1.0'); assert.equal(v[0].source_checksum, sum(doc).slice(7));
  assert.equal(v[0].definition_json.fields[0].concept, 'pulse-rate');
  const row = (await env.pool.query('SELECT accepted_by, accepted_ref FROM package_proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.accepted_ref, r.body.setId); assert.ok(row.accepted_by);
});

test('2. nurse, viewer, informatician and signed-out callers cannot accept; nothing is written', async () => {
  const d = await as('doctor1'), p = (await stage(d, el('acc.perm'))).proposals[0], sets = await count('element_sets');
  for (const u of ['nurse1', 'viewer1', 'informatician1']) assert.equal((await accept(await as(u), p.id)).status, 403, u);
  assert.equal((await accept(client(env.base), p.id)).status, 401);
  assert.equal(await count('element_sets'), sets);
  assert.equal((await env.pool.query('SELECT status FROM package_proposals WHERE id = $1', [p.id])).rows[0].status, 'staged');
});

test('3. a blocked, a pathway and a rejected proposal are refused with a named code', async () => {
  const d = await as('doctor1'), bad = el('acc.blocked'); bad.fields.push({ key: 'x', label: 'X', type: 'weird', cardinality: { min: 0, max: 1 } });
  const pw = { manifest: man('acc.pathway', 'pathway', 'Path'), scope: 'Scope.', elements: [{ id: 'acc.rej', type: 'contextual-element', range: '0.1.0' }], stages: [], entryForm: { sections: [{ id: 'history', label: 'History', items: [{ kind: 'element', element: 'acc.rej' }] }] }, contexts: [] };
  const imp = await stage(d, bad, el('acc.rej'), pw);
  const blocked = imp.proposals.find(p => p.kind === 'set' && !p.ready), path = imp.proposals.find(p => p.kind === 'pathway'), good = imp.proposals.find(p => p.kind === 'set' && p.ready);
  assert.equal((await accept(d, blocked.id)).body.error, 'not_ready');
  assert.equal((await accept(d, path.id)).body.error, 'not_a_set');
  assert.equal((await d.post(`/api/import/package-proposals/${good.id}/reject`, { reason: 'No', rowVersion: 1 })).status, 200);
  assert.equal((await accept(d, good.id, 2)).body.error, 'proposal_final');
  assert.equal((await env.pool.query(`SELECT count(*) n FROM element_sets WHERE slug IN ('acc-blocked','acc-rej')`)).rows[0].n, '0');
});

test('4. a stale rowVersion and a second accept are 409', async () => {
  const d = await as('doctor1'), p = (await stage(d, el('acc.twice'))).proposals[0];
  assert.equal((await accept(d, p.id, 7)).body.error, 'version_conflict');
  assert.equal((await accept(d, p.id)).status, 200);
  assert.equal((await accept(d, p.id, 2)).body.error, 'proposal_final');
  assert.equal((await d.post(`/api/import/package-proposals/${p.id}/accept`, {})).status, 400, 'rowVersion is required');
});

test('5. a slug taken by another set is refused: no second set, the proposal stays staged', async () => {
  const d = await as('admin1');
  assert.equal((await d.post('/api/element-sets', { slug: 'acc-taken', kind: 'custom', definition: { title: 'Taken', fields: [{ id: 'a', label: 'A', type: 'text' }] } })).status, 201);
  const p = (await stage(d, el('acc.taken'))).proposals[0], sets = await count('element_sets');
  const r = await accept(d, p.id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'slug_taken');
  assert.equal(await count('element_sets'), sets);
  assert.equal((await env.pool.query('SELECT status FROM package_proposals WHERE id = $1', [p.id])).rows[0].status, 'staged');
});

test('6. the same artefact version imported again (a new bundle) is refused as already imported', async () => {
  const d = await as('doctor1'), doc = el('acc.dup');
  assert.equal((await accept(d, (await stage(d, doc)).proposals[0].id)).status, 200);
  const again = await stage(d, doc, el('acc.other-dup-filler')), p = again.proposals.find(x => x.slug === 'acc-dup');
  const r = await accept(d, p.id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'already_imported');
});

test('7. a body that names a user or any extra field is refused; the audit holds ids and hashes, no text', async () => {
  const d = await as('doctor1'), p = (await stage(d, el('acc.audit', 'Secretive Title'))).proposals[0];
  assert.equal((await accept(d, p.id, 1, { createdBy: 1, username: 'mallory' })).status, 400);
  assert.equal((await accept(d, p.id)).status, 200);
  const rows = (await env.pool.query(`SELECT username, detail FROM audit_log WHERE action = 'import.package_accept' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(rows.username, 'doctor1'); assert.ok(rows.detail.setId >= 1);
  assert.ok(!/Secretive|Heart rate|Synthetic/.test(JSON.stringify(rows.detail)), 'audit has no package text');
  // the stored body is checked again: tamper with it as the table owner (guard off for one statement) and the accept refuses
  const t = (await stage(d, el('acc.tamper'))).proposals[0];
  await env.pool.query('ALTER TABLE package_proposals DISABLE TRIGGER package_proposals_guard');
  await env.pool.query(`UPDATE package_proposals SET body = jsonb_set(body, '{definition}', '{"fields": []}'::jsonb) WHERE id = $1`, [t.id]);
  await env.pool.query('ALTER TABLE package_proposals ENABLE TRIGGER package_proposals_guard');
  const bad = await accept(d, t.id);
  assert.equal(bad.status, 422); assert.equal(bad.body.error, 'invalid_definition');
  assert.equal((await env.pool.query(`SELECT count(*) n FROM element_sets WHERE slug = 'acc-tamper'`)).rows[0].n, '0');
});

test('8. accept makes a draft only: no review row, the accepter cannot submit-approve-publish alone', async () => {
  const d = await as('admin1'), p = (await stage(d, el('acc.draft'))).proposals[0], r = await accept(d, p.id);
  assert.equal(r.status, 200);
  assert.equal(await count('element_set_reviews'), 0);
  const pub = await d.post(`/api/element-sets/${r.body.setId}/versions/1/publish`, {});
  assert.ok([403, 409, 422].includes(pub.status), 'publish of an unreviewed draft is refused: ' + pub.status);
  assert.equal((await env.pool.query('SELECT status FROM element_set_versions WHERE element_set_id = $1', [r.body.setId])).rows[0].status, 'draft');
});
