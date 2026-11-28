'use strict';
// Task D12: GET /api/cases/:id/composed-form. Real server and PostgreSQL. Packages go through the real import, review, publish and apply routes. Synthetic data only.
// Prototype. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, C, R, n = 0;
test.before(async () => { env = await setup(); C = await import(pathToFileURL(path.join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href); R = await reviewers(env.base); });
test.after(async () => { await env.close(); });

const as = async u => { const c = client(env.base); assert.equal((await c.login(u)).status, 200); return c; };
const art = doc => ({ checksum: C.checksumOf(C.canonicalize(doc).text), document: doc });
const man = (id, type, name) => ({ id, name, type, version: '0.1.0', status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } });
const loc = code => ({ codeSystem: { id: 'local', version: '0.1.0' }, code, mapping: { status: 'mapped' } });
const TERMS = { manifest: man('t.terms', 'terminology-package', 'Terms'), codeSystem: { id: 'local', version: '0.1.0' }, concepts: [{ key: 'pulse-rate', display: 'Pulse rate' }, { key: 'note-text', display: 'Note' }, { key: 'temp', display: 'Temperature' }] };
const el = (id, name, concept, fid) => ({ manifest: man(id, 'contextual-element', name), intent: { purpose: 'Record information.' }, provenance: { origin: 'x', basis: 'Synthetic basis.' },
  fields: [{ key: 'f', label: 'Field ' + name, type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 1 }, concept: loc(concept), 'x-emrFieldId': fid }] });
const pw = (id, name, ...ids) => ({ manifest: man(id, 'pathway', name), scope: 'Scope.', elements: ids.map(i => ({ id: i, type: 'contextual-element', range: '0.1.0' })), stages: [],
  entryForm: { sections: [{ id: 'main', label: 'Main', items: ids.map(i => ({ kind: 'element', element: i })) }] }, contexts: [{ id: 'ctx', label: 'Context', elements: ids }] });
async function publishSet(d, setId) {
  assert.equal((await d.post(`/api/element-sets/${setId}/versions/1/submit`, {})).status, 200);
  for (const inf of [R.inf1, R.inf2]) { const a = await inf.post(`/api/element-sets/${setId}/versions/1/approve`, { reason: 'Test approval' }); if (a.body.status === 'reviewed') break; }
  assert.equal((await (await as('admin1')).post(`/api/element-sets/${setId}/versions/1/publish`, {})).status, 200);
}
// a published package pathway: returns { pathwayId }
async function pkgPathway(tag, concepts) {
  const d = await as('doctor1'), els = concepts.map((c, i) => el(`${tag}.e${i}`, `${tag}E${i}`, c, `${tag}_f${i}`));
  const r = await d.post('/api/import/packages', { format: 'ccis-package-bundle/1', artefacts: [TERMS, ...els, pw(tag + '.path', tag + ' Path', ...els.map(e => e.manifest.id))].map(art) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const p of r.body.import.proposals.filter(x => x.kind === 'set')) {
    const a = await d.post(`/api/import/package-proposals/${p.id}/accept`, { rowVersion: 1 }); assert.equal(a.status, 200, JSON.stringify(a.body)); await publishSet(d, a.body.setId);
  }
  const pp = r.body.import.proposals.find(x => x.kind === 'pathway'), a = await d.post(`/api/import/package-proposals/${pp.id}/accept-pathway`, { rowVersion: 1 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await (await as('admin1')).post(`/api/pathways/${a.body.pathwayId}/versions/1/publish`, {})).status, 200);
  return { pathwayId: a.body.pathwayId };
}
async function newCase(c) {
  const p = await c.post('/api/patients', { name: 'Composed Patient ' + (++n), mrn: 'CF-' + n, dob: '1980-01-01', sex: 'F' }); assert.equal(p.status, 201);
  const k = await c.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Composed case' }); assert.equal(k.status, 201, JSON.stringify(k.body)); return k.body.case.id;
}
const apply = async (c, caseId, pathwayId) => { const r = await c.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId, version: 1 }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const ids = form => form.sections.flatMap(s => s.items.flatMap(i => (i.fields || []).map(f => f.id)));
const auditRows = async (caseId) => Number((await env.pool.query(`SELECT count(*) n FROM audit_log WHERE action = 'case.composed_form' AND entity_id = $1`, [String(caseId)])).rows[0].n);

test('1. two package pathways sharing a concept: composed, shared concept once with owner and user, pathways in applied order', async () => {
  const d = await as('doctor1'), A = await pkgPathway('cfa', ['pulse-rate', 'note-text']), B = await pkgPathway('cfb', ['pulse-rate', 'temp']), id = await newCase(d);
  await apply(d, id, A.pathwayId); await apply(d, id, B.pathwayId);
  const r = await d.get(`/api/cases/${id}/composed-form`); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.composed, true); assert.deepEqual(r.body.pathways.map(p => p.slug), ['cfa-path', 'cfb-path']);
  assert.equal(r.body.form.shared.length, 1); assert.equal(r.body.form.shared[0].concept, 'pulse-rate');
  assert.equal(ids(r.body.form).filter(x => x === 'cfa_f0' || x === 'cfb_f0').length, 1, 'the shared field is drawn once');
  assert.equal(r.body.pins.length, 4);
});

test('2. one pathway applied: composed false, fewer-than-two-pathways', async () => {
  const d = await as('doctor1'), A = await pkgPathway('cfc', ['note-text']), id = await newCase(d); await apply(d, id, A.pathwayId);
  const r = await d.get(`/api/cases/${id}/composed-form`); assert.equal(r.status, 200); assert.deepEqual(r.body, { composed: false, reason: 'fewer-than-two-pathways' });
});

test('3. a hand-made pathway (no entry_form) among two: composed false, no-layout', async () => {
  const d = await as('doctor1'), A = await pkgPathway('cfd', ['note-text']), id = await newCase(d);
  const s = await d.post('/api/element-sets', { slug: 'hand-set', kind: 'custom', definition: { title: 'Hand', fields: [{ id: 'h1', label: 'H', type: 'text' }] } }); assert.equal(s.status, 201, JSON.stringify(s.body));
  await publishSet(d, s.body.set.id);
  const p = await d.post('/api/pathways', { slug: 'hand-path', title: 'Hand path', description: 'x', steps: [{ setId: s.body.set.id, version: 1 }] }); assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal((await (await as('admin1')).post(`/api/pathways/${p.body.pathway.id}/versions/1/publish`, {})).status, 200);
  await apply(d, id, A.pathwayId); await apply(d, id, p.body.pathway.id);
  const r = await d.get(`/api/cases/${id}/composed-form`); assert.deepEqual(r.body, { composed: false, reason: 'no-layout' });
});

test('4. a withdrawn pin is not included', async () => {
  const d = await as('doctor1'), A = await pkgPathway('cfe', ['pulse-rate']), B = await pkgPathway('cff', ['temp']), id = await newCase(d);
  await apply(d, id, A.pathwayId); const b = await apply(d, id, B.pathwayId);
  assert.equal((await d.post(`/api/cases/${id}/applied-sets/${b.appliedSets[0].id}/withdraw`, {})).status, 200);
  const r = await d.get(`/api/cases/${id}/composed-form`); assert.equal(r.body.composed, false); assert.equal(r.body.reason, 'fewer-than-two-pathways');
});

test('5. a newer published set version does not change the pin: the pinned definition is read', async () => {
  const d = await as('doctor1'), A = await pkgPathway('cfg', ['note-text']), B = await pkgPathway('cfh', ['temp']), id = await newCase(d);
  const a = await apply(d, id, A.pathwayId); await apply(d, id, B.pathwayId);
  const setId = a.appliedSets[0].element_set_id, v2 = await d.post(`/api/element-sets/${setId}/versions`, { definition: { title: 'Newer', fields: [{ id: 'zz', label: 'ZZ', type: 'text' }] } });
  assert.equal(v2.status, 201, JSON.stringify(v2.body)); await approveVersion(R, setId, v2.body.version.version);
  assert.equal((await (await as('admin1')).post(`/api/element-sets/${setId}/versions/${v2.body.version.version}/publish`, {})).status, 200);
  const r = await d.get(`/api/cases/${id}/composed-form`);
  assert.deepEqual(ids(r.body.form).sort(), ['cfg_f0', 'cfh_f0']); assert.deepEqual(r.body.pins.map(p => p.version), [1, 1]);
});

test('6. roles: viewer allowed, anonymous 401, unknown and bad ids 404', async () => {
  const d = await as('doctor1'), v = await as('viewer1'), id = await newCase(d);
  assert.equal((await v.get(`/api/cases/${id}/composed-form`)).status, 200);
  assert.equal((await client(env.base).get(`/api/cases/${id}/composed-form`)).status, 401);
  assert.equal((await d.get('/api/cases/99999999/composed-form')).status, 404); assert.equal((await d.get('/api/cases/abc/composed-form')).status, 404);
});

test('7. one audit row per read, actor from the session', async () => {
  const d = await as('doctor1'), id = await newCase(d), before = await auditRows(id);
  await d.get(`/api/cases/${id}/composed-form`); assert.equal(await auditRows(id), before + 1);
  const row = (await env.pool.query(`SELECT username, entity_type FROM audit_log WHERE action = 'case.composed_form' AND entity_id = $1`, [String(id)])).rows[0];
  assert.equal(row.username, 'doctor1'); assert.equal(row.entity_type, 'case');
});

test('8. the response carries layout and ids only: no observation values', async () => {
  const d = await as('doctor1'), A = await pkgPathway('cfi', ['pulse-rate']), B = await pkgPathway('cfj', ['temp']), id = await newCase(d);
  await apply(d, id, A.pathwayId); await apply(d, id, B.pathwayId);
  const r = await d.get(`/api/cases/${id}/composed-form`), text = JSON.stringify(r.body);
  assert.deepEqual(Object.keys(r.body).sort(), ['composed', 'form', 'pathways', 'pins']); assert.ok(!/"value"|observations/.test(text));
});
