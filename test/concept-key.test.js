'use strict';
// Task D3: field `concept` in a set definition and `observations.concept_key` set at write from the pinned field.
// Needs PostgreSQL (TEST_DATABASE_URL, a scratch database). Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, seq = 0;
test.before(async () => { env = await setup(); R = await reviewers(env.base); admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const DEF = { title: 'Concept set', fields: [
  { id: 'hr', label: 'Heart rate', type: 'number', unit: 'bpm', concept: 'pulse-rate' },
  { id: 'note', label: 'Note', type: 'text' },
] };
async function publishedSet(def = DEF) {
  const slug = 'concept-set-' + (++seq);
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: def });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return { id: made.body.set.id };
}
async function newCase(c) {
  const p = await c.post('/api/patients', { name: 'Concept Patient ' + (++seq), mrn: 'CK-' + seq, dob: '1980-01-01', sex: 'F' });
  const k = await c.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Concept case' });
  assert.equal(k.status, 201);
  return k.body.case.id;
}
const applied = async (c, caseId, set) => (await c.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 1 })).body.appliedSet;
const rec = (c, caseId, ...obs) => c.post(`/api/cases/${caseId}/observations`, { observations: obs });
const row = async id => (await env.pool.query('SELECT * FROM observations WHERE id = $1', [id])).rows[0];
const draft = (field, slug) => R.doctor.post('/api/element-sets', { slug: slug || 'concept-draft-' + (++seq), kind: 'custom', definition: { title: 'T', fields: [{ id: 'x', label: 'X', type: 'text', ...field }] } });

test('1. a field concept is accepted; capitals, a space, 65 characters or an object are refused with a path', async () => {
  assert.equal((await draft({ concept: 'creatinine' })).status, 201);
  for (const bad of ['Creatinine', 'pulse rate', 'a'.repeat(65), { code: 'x' }, '']) {
    const r = await draft({ concept: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(JSON.stringify(r.body), /concept/);
  }
});

test('2. a set without any concept still validates', async () => {
  assert.equal((await draft({})).status, 201);
});

test('3. a value stores the concept of its field; a field without one stores NULL', async () => {
  const n = await as('nurse1'), set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const r = await rec(n, caseId,
    { appliedSetId: a.id, fieldKey: 'hr', value: 80, effectiveAt: ago(10), sourceType: 'clinician' },
    { appliedSetId: a.id, fieldKey: 'note', value: 'ok', effectiveAt: ago(10), sourceType: 'clinician' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await row(r.body.observations[0].id)).concept_key, 'pulse-rate');
  assert.equal((await row(r.body.observations[1].id)).concept_key, null);
});

test('4. a concept key sent in the body is refused and nothing is stored', async () => {
  const n = await as('nurse1'), set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  for (const extra of [{ concept_key: 'hacked' }, { conceptKey: 'hacked' }]) {
    const r = await rec(n, caseId, { appliedSetId: a.id, fieldKey: 'hr', value: 80, effectiveAt: ago(10), sourceType: 'clinician', ...extra });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM observations WHERE case_id = $1', [caseId])).rows[0].n, 0);
});

test('5. a correction carries the same concept key as the row it corrects', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const first = (await rec(n, caseId, { appliedSetId: a.id, fieldKey: 'hr', value: 150, effectiveAt: ago(20), sourceType: 'device' })).body.observations[0];
  const c = await d.post(`/api/observations/${first.id}/correct`, { value: 105, sourceType: 'clinician', reason: 'Monitor misread' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await row(c.body.observation.id)).concept_key, 'pulse-rate');
});

test('6. entered in error keeps the concept key; changing it by UPDATE is refused, also on a NULL row', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const [h, t] = (await rec(n, caseId,
    { appliedSetId: a.id, fieldKey: 'hr', value: 70, effectiveAt: ago(10), sourceType: 'clinician' },
    { appliedSetId: a.id, fieldKey: 'note', value: 'x', effectiveAt: ago(10), sourceType: 'clinician' })).body.observations;
  assert.equal((await d.post(`/api/observations/${h.id}/entered-in-error`, { reason: 'Wrong patient' })).status, 200);
  assert.equal((await row(h.id)).concept_key, 'pulse-rate');
  for (const o of [h, t]) await assert.rejects(env.pool.query("UPDATE observations SET concept_key = 'other' WHERE id = $1", [o.id]), /append-only/);
});

test('7. the database refuses a malformed concept key', async () => {
  const n = await as('nurse1'), set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const o = (await rec(n, caseId, { appliedSetId: a.id, fieldKey: 'note', value: 'x', effectiveAt: ago(10), sourceType: 'clinician' })).body.observations[0];
  await assert.rejects(env.pool.query(
    `INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, effective_at, source_type, status, recorded_by, concept_key)
     SELECT case_id, applied_set_id, 'note', 'text', '"y"'::jsonb, now(), 'clinician', 'final', recorded_by, 'Bad Key' FROM observations WHERE id = $1`, [o.id]), /concept_key|check/i);
});

test('8. two sets with the same field concept both store it under one key (no owner check yet)', async () => {
  const n = await as('nurse1'), caseId = await newCase(n);
  const s1 = await publishedSet(), s2 = await publishedSet();
  const a1 = await applied(n, caseId, s1), a2 = await applied(n, caseId, s2);
  const r = await rec(n, caseId,
    { appliedSetId: a1.id, fieldKey: 'hr', value: 80, effectiveAt: ago(10), sourceType: 'clinician' },
    { appliedSetId: a2.id, fieldKey: 'hr', value: 82, effectiveAt: ago(5), sourceType: 'clinician' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = (await env.pool.query("SELECT DISTINCT concept_key FROM observations WHERE case_id = $1", [caseId])).rows;
  assert.deepEqual(rows.map(x => x.concept_key), ['pulse-rate']);
});
