'use strict';
// Task D14: reads by concept (current value and series across sets). ED-93 to ED-95.
// Needs PostgreSQL (TEST_DATABASE_URL, a scratch database). Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, seq = 0;
test.before(async () => { env = await setup(); R = await reviewers(env.base); admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const ago = min => new Date(Date.now() - min * 60000).toISOString();
// A published set with one numeric field carrying concept `lab-x` in the given unit, plus a text field with no concept.
async function publishedSet(unit = 'mmol/L', field = 'v') {
  const slug = 'reads-set-' + (++seq);
  const def = { title: 'Reads set', fields: [{ id: field, label: 'Value', type: 'number', unit, concept: 'lab-x' }, { id: 'note', label: 'Note', type: 'text' }] };
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: def });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return { id: made.body.set.id, slug };
}
async function newCase(c) {
  const p = await c.post('/api/patients', { name: 'Reads Patient ' + (++seq), mrn: 'CR-' + seq, dob: '1980-01-01', sex: 'F' });
  const k = await c.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Reads case' });
  assert.equal(k.status, 201);
  return k.body.case.id;
}
const applied = async (c, caseId, set) => (await c.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 1 })).body.appliedSet;
const rec = async (c, caseId, ...obs) => { const r = await c.post(`/api/cases/${caseId}/observations`, { observations: obs }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.observations; };
const val = (a, fieldKey, value, min, extra = {}) => ({ appliedSetId: a.id, fieldKey, value, effectiveAt: ago(min), sourceType: 'clinician', ...extra });
const series = (c, caseId, key = 'lab-x') => c.get(`/api/cases/${caseId}/concepts/${key}`);
const audits = async (action, caseId) => (await env.pool.query('SELECT username, detail FROM audit_log WHERE action = $1 AND entity_id = $2', [action, String(caseId)])).rows;

test('1. two sets share a concept: current is the newest across both; the series keeps each set slug', async () => {
  const n = await as('nurse1'), s1 = await publishedSet(), s2 = await publishedSet('mmol/L', 'w'), caseId = await newCase(n);
  const a1 = await applied(n, caseId, s1), a2 = await applied(n, caseId, s2);
  await rec(n, caseId, val(a1, 'v', 5, 30), val(a2, 'w', 7, 10));
  const r = await series(n, caseId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.current.value, 7); assert.equal(r.body.current.set_slug, s2.slug);
  assert.deepEqual(r.body.series.map(o => [o.value, o.set_slug]), [[5, s1.slug], [7, s2.slug]]);
  const l = await n.get(`/api/cases/${caseId}/concepts`);
  assert.equal(l.body.concepts.length, 1); assert.equal(l.body.concepts[0].concept, 'lab-x'); assert.equal(l.body.concepts[0].count, 2); assert.equal(l.body.concepts[0].current.value, 7);
  assert.equal(l.body.concepts[0].fields.length, 2);
});

test('2. a corrected original is not in the series; the correction is; superseded counts it', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), s = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, s);
  const [first] = await rec(n, caseId, val(a, 'v', 5, 20));
  assert.equal((await d.post(`/api/observations/${first.id}/correct`, { value: 6, sourceType: 'clinician', reason: 'Misread' })).status, 201);
  const r = await series(n, caseId);
  assert.deepEqual(r.body.series.map(o => o.value), [6]); assert.equal(r.body.current.value, 6); assert.equal(r.body.superseded, 1); assert.equal(r.body.hiddenInError, 0);
});

test('3. a correction entered in error does not bring the original back', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), s = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, s);
  const [first] = await rec(n, caseId, val(a, 'v', 5, 20));
  const c = await d.post(`/api/observations/${first.id}/correct`, { value: 6, sourceType: 'clinician', reason: 'Misread' });
  assert.equal((await d.post(`/api/observations/${c.body.observation.id}/entered-in-error`, { reason: 'Wrong patient' })).status, 200);
  const r = await series(n, caseId);
  assert.deepEqual(r.body.series, []); assert.equal(r.body.current, null); assert.equal(r.body.hiddenInError, 1); assert.equal(r.body.superseded, 1);
  assert.equal((await n.get(`/api/cases/${caseId}/concepts`)).body.concepts.length, 0);
});

test('4. a newest unknown row is the current value; the older known value stays in the series', async () => {
  const n = await as('nurse1'), s = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, s);
  await rec(n, caseId, val(a, 'v', 5, 30), { appliedSetId: a.id, fieldKey: 'v', unknown: true, effectiveAt: ago(5), sourceType: 'clinician' });
  const r = await series(n, caseId);
  assert.equal(r.body.current.value_type, 'unknown'); assert.equal(r.body.current.value, null); assert.equal(r.body.series.length, 2); assert.equal(r.body.series[0].value, 5);
});

test('5. an old row with concept_key NULL is found through its pinned field concept', async () => {
  const n = await as('nurse1'), s = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, s);
  const uid = (await env.pool.query(`SELECT id FROM users WHERE username = 'nurse1'`)).rows[0].id;
  await env.pool.query(`INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, unit_display, effective_at, source_type, status, recorded_by)
                        VALUES ($1,$2,'v','number','9','mmol/L', now() - interval '1 hour', 'clinician', 'final', $3)`, [caseId, a.id, uid]);
  assert.equal((await env.pool.query('SELECT concept_key FROM observations WHERE case_id = $1', [caseId])).rows[0].concept_key, null);
  const r = await series(n, caseId);
  assert.equal(r.body.series.length, 1); assert.equal(r.body.current.value, 9);
});

test('6. two units under one concept are listed as recorded, never converted; mixedUnits is true', async () => {
  const n = await as('nurse1'), s1 = await publishedSet('mmol/L'), s2 = await publishedSet('mg/dL', 'w'), caseId = await newCase(n);
  const a1 = await applied(n, caseId, s1), a2 = await applied(n, caseId, s2);
  await rec(n, caseId, val(a1, 'v', 5, 30), val(a2, 'w', 90, 10));
  const r = await series(n, caseId);
  assert.deepEqual(r.body.units, ['mg/dL', 'mmol/L']); assert.equal(r.body.mixedUnits, true);
  assert.deepEqual(r.body.series.map(o => [o.value, o.unit_display]), [[5, 'mmol/L'], [90, 'mg/dL']]);
  assert.equal((await n.get(`/api/cases/${caseId}/concepts`)).body.concepts[0].mixedUnits, true);
});

test('7. roles and input: viewer allowed, anonymous 401, unknown case 404, bad key 400; a field with no concept is counted', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), s = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, s);
  await rec(n, caseId, val(a, 'v', 5, 10), val(a, 'note', 'fine', 10));
  assert.equal((await series(v, caseId)).status, 200);
  assert.equal((await v.get(`/api/cases/${caseId}/concepts`)).body.withoutConcept, 1);
  const anon = client(env.base);
  assert.equal((await anon.get(`/api/cases/${caseId}/concepts`)).status, 401); assert.equal((await series(anon, caseId)).status, 401);
  assert.equal((await v.get('/api/cases/99999999/concepts')).status, 404); assert.equal((await series(v, 99999999)).status, 404);
  assert.equal((await series(v, caseId, 'Bad_Key')).status, 400);
  assert.equal((await series(v, caseId, 'no-such-concept')).body.current, null);
});

test('8. one audit row per read, actor from the session, no value in the detail', async () => {
  const n = await as('nurse1'), s = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, s);
  await rec(n, caseId, val(a, 'v', 424242, 10));
  await n.get(`/api/cases/${caseId}/concepts`); await series(n, caseId);
  const l = await audits('case.concepts_view', caseId), r = await audits('case.concept_series_view', caseId);
  assert.equal(l.length, 1); assert.equal(r.length, 1); assert.equal(l[0].username, 'nurse1'); assert.equal(r[0].username, 'nurse1');
  assert.ok(!JSON.stringify([l, r]).includes('424242'));
});
