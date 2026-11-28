'use strict';
// Task D7a: an accepted package set takes the EXISTING submit, review and publish path unchanged (ED-90). No new route.
// Every case stages and accepts through the D6 and D7 routes, never by SQL. Fixtures are small synthetic CCIS elements. Prototype. Synthetic data only. Not for clinical use.
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
const TERMS = { manifest: man('t.terms', 'terminology-package', 'Terms'), codeSystem: { id: 'local', version: '0.1.0' }, concepts: [{ key: 'pulse-rate', display: 'Pulse rate' }] };
const el = (id, name = 'Vitals') => ({ manifest: man(id, 'contextual-element', name), intent: { purpose: 'Record vital signs.' }, provenance: { origin: 'x', basis: 'Synthetic basis.' },
  fields: [{ key: 'hr', label: 'Heart rate', type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 'unbounded' }, concept: loc('pulse-rate'), 'x-emrFieldId': 'hr_bpm' }] });
// stage a package and accept its first ready set proposal as `d`; returns { setId, doc }
async function imported(d, doc) {
  const st = await d.post('/api/import/packages', { format: 'ccis-package-bundle/1', artefacts: [art(TERMS), art(doc)] });
  assert.equal(st.status, 201, JSON.stringify(st.body));
  const ok = await d.post(`/api/import/package-proposals/${st.body.import.proposals[0].id}/accept`, { rowVersion: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return { setId: ok.body.setId, doc };
}
const submit = (c, setId) => c.post(`/api/element-sets/${setId}/versions/1/submit`, {});
const vrow = async setId => (await env.pool.query('SELECT * FROM element_set_versions WHERE element_set_id = $1 AND version = 1', [setId])).rows[0];

test('1. the accepting doctor submits the draft: in_review, lint stored, submitter is the session user, audit has no package text', async () => {
  const d = await as('doctor1'), { setId } = await imported(d, el('sub.one', 'Secretive Title'));
  const r = await submit(d, setId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.review.status, 'in_review'); assert.equal(r.body.review.submitted_by, 'doctor1'); assert.equal(r.body.review.created_by, 'doctor1');
  assert.ok((await vrow(setId)).lint_json, 'lint result stored');
  const a = (await env.pool.query(`SELECT username, detail FROM audit_log WHERE action = 'set.submit' AND entity_id = $1`, [setId])).rows[0];
  assert.equal(a.username, 'doctor1'); assert.ok(!/Secretive|Heart rate|Synthetic/.test(JSON.stringify(a.detail)));
});

test('2. nurse, viewer and informatician cannot submit it; a second submit is 409 not_submittable', async () => {
  const d = await as('doctor1'), { setId } = await imported(d, el('sub.two'));
  for (const u of ['nurse1', 'viewer1', 'informatician1']) assert.equal((await submit(await as(u), setId)).status, 403, u);
  assert.equal((await vrow(setId)).status, 'draft');
  assert.equal((await submit(d, setId)).status, 200);
  const again = await submit(d, setId);
  assert.equal(again.status, 409); assert.equal(again.body.error, 'not_submittable');
});

test('3. lint runs on the converted set and its findings are stored (no converter output was found that lint refuses)', async () => {
  const d = await as('doctor1');
  const dose = el('sub.dose', 'Dose set'); dose.fields.push({ key: 'dose', label: 'Dose given', type: 'quantity', units: ['mg'], cardinality: { min: 0, max: 1 } }); delete dose.provenance;
  const { setId } = await imported(d, dose), r = await submit(d, setId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const lint = (await vrow(setId)).lint_json;
  assert.ok(lint && Array.isArray(lint.findings) && typeof lint.needsTwoReviewers === 'boolean', 'the stored lint result has findings and the two-reviewer flag');
  assert.ok(!lint.findings.some(f => f.severity === 'error'), 'a dose-like quantity without a citation gives no lint error here: the converter output passes lint');
});

test('4. full path: submit, approve by informaticians, publish by admin; the checksum is unchanged', async () => {
  const d = await as('doctor1'), { setId } = await imported(d, el('sub.full')), before = await vrow(setId);
  assert.equal((await submit(d, setId)).status, 200);
  for (const inf of [R.inf1, R.inf2]) { const a = await inf.post(`/api/element-sets/${setId}/versions/1/approve`, { reason: 'Test approval' }); assert.equal(a.status, 200, JSON.stringify(a.body)); if (a.body.status === 'reviewed') break; }
  const admin = await as('admin1'), p = await admin.post(`/api/element-sets/${setId}/versions/1/publish`, {});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const after = await vrow(setId);
  assert.equal(after.status, 'published'); assert.equal(after.checksum, before.checksum);
});

test('5. after publish the source columns still equal the package and the concept key is in the stored definition', async () => {
  const d = await as('doctor1'), doc = el('sub.source'), { setId } = await imported(d, doc);
  assert.equal((await submit(d, setId)).status, 200);
  for (const inf of [R.inf1, R.inf2]) { const a = await inf.post(`/api/element-sets/${setId}/versions/1/approve`, { reason: 'Test approval' }); if (a.body.status === 'reviewed') break; }
  assert.equal((await (await as('admin1')).post(`/api/element-sets/${setId}/versions/1/publish`, {})).status, 200);
  const v = await vrow(setId);
  assert.equal(v.source_artefact_id, 'sub.source'); assert.equal(v.source_version, '0.1.0'); assert.equal(v.source_checksum, sum(doc).slice(7));
  assert.equal(v.definition_json.fields[0].concept, 'pulse-rate');
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET source_checksum = $2 WHERE element_set_id = $1`, [setId, 'a'.repeat(64)]), /./);
});

test('6. the accepting doctor cannot approve or publish their own import', async () => {
  const d = await as('doctor1'), { setId } = await imported(d, el('sub.own'));
  assert.equal((await submit(d, setId)).status, 200);
  assert.equal((await d.post(`/api/element-sets/${setId}/versions/1/approve`, { reason: 'Mine' })).status, 403);
  assert.equal((await d.post(`/api/element-sets/${setId}/versions/1/publish`, {})).status, 403);
  assert.equal((await vrow(setId)).status, 'in_review');
});
