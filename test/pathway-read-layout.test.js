'use strict';
// Task D10a: the pathway version read returns the layout and the source (entry_form, contexts, source_*). Reads only. Prototype. Synthetic data only. Not for clinical use.
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
const TERMS = { manifest: man('t.terms', 'terminology-package', 'Terms'), codeSystem: { id: 'local', version: '0.1.0' }, concepts: [{ key: 'pulse-rate', display: 'Pulse rate' }] };
const el = id => ({ manifest: man(id, 'contextual-element', 'Alpha'), intent: { purpose: 'Record information.' }, provenance: { origin: 'x', basis: 'Synthetic basis.' },
  fields: [{ key: 'f', label: 'Field', type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 1 }, concept: { codeSystem: { id: 'local', version: '0.1.0' }, code: 'pulse-rate', mapping: { status: 'mapped' } }, 'x-emrFieldId': 'hr_bpm' }] });
const pw = (id, label) => ({ manifest: man(id, 'pathway', 'Path'), scope: 'Scope.', elements: [{ id: id + '.a', type: 'contextual-element', range: '0.1.0' }], stages: [],
  entryForm: { sections: [{ id: 'main', label, items: [{ kind: 'element', element: id + '.a' }] }] }, contexts: [{ id: 'ctx', label: 'Context', elements: [id + '.a'] }] });
async function publishSet(d, setId) {
  assert.equal((await d.post(`/api/element-sets/${setId}/versions/1/submit`, {})).status, 200);
  for (const inf of [R.inf1, R.inf2]) { const a = await inf.post(`/api/element-sets/${setId}/versions/1/approve`, { reason: 'Test approval' }); if (a.body.status === 'reviewed') break; }
  assert.equal((await (await as('admin1')).post(`/api/element-sets/${setId}/versions/1/publish`, {})).status, 200);
}
// a package pathway accepted through D6 to D8; returns { pathwayId, doc }
async function imported(d, tag, label = 'Main') {
  const doc = pw(tag, label), st = await d.post('/api/import/packages', { format: 'ccis-package-bundle/1', artefacts: [TERMS, el(tag + '.a'), doc].map(art) });
  assert.equal(st.status, 201, JSON.stringify(st.body));
  const sp = st.body.import.proposals.find(p => p.kind === 'set'), pp = st.body.import.proposals.find(p => p.kind === 'pathway');
  const s = await d.post(`/api/import/package-proposals/${sp.id}/accept`, { rowVersion: 1 }); assert.equal(s.status, 200);
  await publishSet(d, s.body.setId);
  const r = await d.post(`/api/import/package-proposals/${pp.id}/accept-pathway`, { rowVersion: 1 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  return { pathwayId: r.body.pathwayId, doc };
}

test('1. a package pathway: the version read returns entry_form, contexts and the source triple as stored', async () => {
  const d = await as('doctor1'), { pathwayId, doc } = await imported(d, 'rl1');
  const r = await d.get(`/api/pathways/${pathwayId}/versions/1`), v = r.body.version;
  assert.equal(r.status, 200);
  assert.equal(v.entry_form.sections[0].id, 'main'); assert.equal(v.entry_form.sections[0].items[0].set, 'rl1-a'); assert.equal(v.contexts[0].id, 'ctx');
  assert.equal(v.source_artefact_id, doc.manifest.id);
  assert.equal(v.source_version, '0.1.0'); assert.equal(v.source_checksum, sum(doc).slice(7));
});

test('2. the version list of the pathway carries the same fields', async () => {
  const d = await as('doctor1'), { pathwayId } = await imported(d, 'rl2');
  const r = await d.get(`/api/pathways/${pathwayId}`);
  assert.equal(r.status, 200); assert.equal(r.body.versions[0].entry_form.sections[0].id, 'main'); assert.equal(r.body.versions[0].contexts[0].id, 'ctx'); assert.ok(r.body.versions[0].source_checksum);
});

test('3. a hand-made pathway returns null for all five: no layout means the old stacked form', async () => {
  const d = await as('admin1'), s = await d.post('/api/element-sets', { slug: 'rl3-set', kind: 'custom', definition: { title: 'Hand', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
  assert.equal(s.status, 201); await publishSet(d, s.body.set ? s.body.set.id : s.body.id);
  const setId = (await env.pool.query(`SELECT id FROM element_sets WHERE slug = 'rl3-set'`)).rows[0].id;
  const p = await d.post('/api/pathways', { slug: 'rl3-path', title: 'Hand path', steps: [{ setId, version: 1 }] }); assert.equal(p.status, 201, JSON.stringify(p.body));
  const v = (await d.get(`/api/pathways/${p.body.pathway.id}/versions/1`)).body.version;
  for (const k of ['entry_form', 'contexts', 'source_artefact_id', 'source_version', 'source_checksum']) assert.equal(v[k], null, k);
});

test('4. after publish the read returns the same layout and checksum', async () => {
  const d = await as('doctor1'), { pathwayId } = await imported(d, 'rl4'), before = (await d.get(`/api/pathways/${pathwayId}/versions/1`)).body.version;
  assert.equal((await (await as('admin1')).post(`/api/pathways/${pathwayId}/versions/1/publish`, {})).status, 200);
  const after = (await d.get(`/api/pathways/${pathwayId}/versions/1`)).body.version;
  assert.equal(after.status, 'published'); assert.equal(after.checksum, before.checksum); assert.deepEqual(after.entry_form, before.entry_form); assert.deepEqual(after.contexts, before.contexts);
});

test('5. signed out is 401; roles follow the existing sets:read rule', async () => {
  const d = await as('doctor1'), { pathwayId } = await imported(d, 'rl5');
  assert.equal((await client(env.base).get(`/api/pathways/${pathwayId}/versions/1`)).status, 401);
  for (const u of ['nurse1', 'viewer1', 'informatician1']) { const r = await (await as(u)).get(`/api/pathways/${pathwayId}/versions/1`); assert.equal(r.status, 200, u); assert.ok(r.body.version.entry_form, u); }
});

test('6. layout text is returned as stored: hostile text stays a string, nothing is interpreted', async () => {
  const d = await as('doctor1'), bad = '<img src=x onerror=alert(1)>';
  const { pathwayId } = await imported(d, 'rl6', 'Hostile');
  await env.pool.query('ALTER TABLE pathway_versions DISABLE TRIGGER ALL');
  await env.pool.query(`UPDATE pathway_versions SET entry_form = jsonb_set(entry_form, '{sections,0,label}', $2::jsonb) WHERE pathway_id = $1`, [pathwayId, JSON.stringify(bad)]);
  await env.pool.query('ALTER TABLE pathway_versions ENABLE TRIGGER ALL');
  const v = (await d.get(`/api/pathways/${pathwayId}/versions/1`)).body.version;
  assert.equal(v.entry_form.sections[0].label, bad); assert.equal(typeof v.entry_form.sections[0].label, 'string');
});
