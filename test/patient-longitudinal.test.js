'use strict';
// Task R9e: GET /api/patients/:id/longitudinal. Same rows as the R3g timeline, projected (R9b), labelled by context (R9c), filtered.
// Synthetic data only. The permission matrix entry is in safety-routes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, seq = 0;
test.before(async () => { env = await setup(); R = await reviewers(env.base); admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const sets = {};   // slug -> set id, published once per file (slugs are the ones context-map.js lists)
async function publishedSet(slug, field) {
  if (sets[slug]) return sets[slug];
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: { title: slug, fields: [{ id: field, label: field, type: 'number', unit: 'u' }] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return (sets[slug] = made.body.set.id);
}
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Longitudinal Patient ' + (++seq), mrn: 'LG-' + seq, dob: '1960-01-01', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const lg = (c, pid, qs = '') => c.get(`/api/patients/${pid}/longitudinal${qs}`);

// One patient, one case, pins for diabetes (dm_ctx), CKD (ckd_ctx) and the shared vitals set; one value each.
async function fixture(n) {
  const pid = await newPatient(n);
  const k = (await n.post(`/api/patients/${pid}/cases`, { title: 'LG case' })).body.case.id;
  const pin = {};
  for (const [slug, field] of [['dm_ctx', 'hba1c'], ['ckd_ctx', 'creat'], ['vitals', 'hr']]) {
    const a = await n.post(`/api/cases/${k}/applied-sets`, { setId: await publishedSet(slug, field), version: 1 });
    assert.equal(a.status, 201, JSON.stringify(a.body)); pin[slug] = a.body.appliedSet.id;
  }
  const obs = async (slug, field, value, min) => {
    const r = await n.post(`/api/cases/${k}/observations`, { observations: [{ appliedSetId: pin[slug], fieldKey: field, value, unit: 'u', effectiveAt: ago(min), sourceType: 'clinician' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body;
  };
  await obs('dm_ctx', 'hba1c', 7, 900); await obs('ckd_ctx', 'creat', 2, 600); await obs('vitals', 'hr', 70, 300);
  return { pid, k, pin, obs };
}
const keyOf = e => e.kind + ':' + e.sourceId;

test('overall view: every source row once, with set slug, context reasons, shared and unmapped labels, effective and recorded time apart', async () => {
  const n = await as('nurse1'), { pid } = await fixture(n);
  assert.equal((await n.post(`/api/patients/${pid}/problems`, { label: 'Something else' })).status, 201);   // no case, not a listed term: unmapped
  const t = await lg(n, pid);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const o = f => t.body.events.find(e => e.kind === 'observation' && e.fieldKey === f);
  assert.deepEqual([o('hba1c').setSlug, o('hba1c').scope, o('hba1c').contexts.map(c => [c.key, c.reasons])], ['dm_ctx', 'condition', [['diabetes', ['set:dm_ctx']]]]);
  assert.deepEqual([o('creat').contexts.map(c => c.key), o('hr').scope, o('hr').scopeLabel, o('hr').contexts.length], [['ckd'], 'shared', 'no single condition', 0]);
  const p = t.body.events.find(e => e.kind === 'problem');
  assert.deepEqual([p.scope, p.scopeLabel], ['unmapped', 'unmapped']);
  assert.ok(o('hba1c').effectiveAt && o('hba1c').recordedAt && o('hba1c').effectiveAt !== o('hba1c').recordedAt, 'both times kept apart');
  assert.equal(new Set(t.body.events.map(keyOf)).size, t.body.events.length, 'one key per source row');
  assert.deepEqual([t.body.total, t.body.counts.all, t.body.counts.diabetes, t.body.counts.ckd, t.body.counts.shared, t.body.counts.unmapped], [4, 4, 1, 1, 1, 1]);
  assert.deepEqual(t.body.contexts, []);
  assert.deepEqual(t.body.available.map(a => a.key), ['diabetes', 'ckd', 'hypertension']);
  assert.ok(t.body.events.every((e, i, a) => i === 0 || new Date(a[i - 1].at) <= new Date(e.at)), 'ascending by time');
});

test('one context, two contexts and a row that sits in several contexts is shown once in the combined view', async () => {
  const n = await as('nurse1'), { pid, k } = await fixture(n);
  // Listed term AND a case that pins both diabetes and CKD sets: three memberships, one source row.
  const pr = await n.post(`/api/patients/${pid}/problems`, { label: 'Hypertension', originCaseId: k });
  assert.equal(pr.status, 201, JSON.stringify(pr.body));
  const pkey = 'problem:' + pr.body.problem.id;
  const dm = await lg(n, pid, '?context=diabetes'), ckd = await lg(n, pid, '?context=ckd'), both = await lg(n, pid, '?context=diabetes,ckd');
  assert.deepEqual(dm.body.events.map(e => e.fieldKey || e.label).sort(), ['Hypertension', 'hba1c']);
  assert.deepEqual(ckd.body.events.map(e => e.fieldKey || e.label).sort(), ['Hypertension', 'creat']);
  const keys = both.body.events.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, 'no duplicates in the combined view');
  assert.equal(both.body.total, 3); assert.equal(keys.filter(x => x === pkey).length, 1);
  const p = both.body.events.find(e => keyOf(e) === pkey);
  assert.deepEqual(p.contexts.map(c => c.key).sort(), ['ckd', 'diabetes', 'hypertension']);
  assert.ok(p.contexts.find(c => c.key === 'hypertension').reasons.includes('term:Hypertension'));
  assert.deepEqual(both.body.contexts, ['diabetes', 'ckd']);
  assert.equal(both.body.counts.all, 4, 'counts cover the whole window, not the filter');
  assert.equal((await lg(n, pid, '?context=hypertension')).body.total, 1);
});

test('a withdrawn pin stops placing notes-like records by case, but observations keep the set they were recorded under', async () => {
  const n = await as('nurse1'), { pid, k, pin } = await fixture(n);
  const pr = await n.post(`/api/patients/${pid}/problems`, { label: 'Unlisted label', originCaseId: k });
  assert.deepEqual((await lg(n, pid, '?context=diabetes')).body.events.map(e => e.fieldKey || e.label).sort(), ['Unlisted label', 'hba1c']);
  assert.equal((await n.post(`/api/cases/${k}/applied-sets/${pin.dm_ctx}/withdraw`, {})).status, 200);
  const after = await lg(n, pid, '?context=diabetes');
  assert.deepEqual(after.body.events.map(e => e.fieldKey || e.label), ['hba1c'], 'problem left the view; the value stays under its own set');
  void pr;
});

test('a pathway-applied pin adds the pathway as a second reason only where the set already qualifies', async () => {
  const n = await as('nurse1'), pid = await newPatient(n);
  const k = (await n.post(`/api/patients/${pid}/cases`, { title: 'PW case' })).body.case.id;
  const setId = await publishedSet('dm_ctx', 'hba1c');
  const pw = await R.doctor.post('/api/pathways', { slug: 'pw_dm', title: 'DM pathway', description: 'Synthetic', steps: [{ setId, version: 1 }] });
  assert.equal(pw.status, 201, JSON.stringify(pw.body));
  assert.equal((await admin.post(`/api/pathways/${pw.body.pathway.id}/versions/1/publish`, {})).status, 200);
  const ap = await n.post(`/api/cases/${k}/applied-pathways`, { pathwayId: pw.body.pathway.id, version: 1 });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  const pin = (await env.pool.query('SELECT id FROM case_applied_sets WHERE case_id = $1 AND state = $2', [k, 'active'])).rows[0].id;
  assert.equal((await n.post(`/api/cases/${k}/observations`, { observations: [{ appliedSetId: pin, fieldKey: 'hba1c', value: 6, unit: 'u', effectiveAt: ago(10), sourceType: 'clinician' }] })).status, 201);
  const t = await lg(n, pid, '?context=diabetes');
  assert.deepEqual(t.body.events[0].contexts[0].reasons, ['set:dm_ctx', 'pathway:pw_dm']);
});

test('another patient never appears (not even in counts); unknown patient and bad id are 404; read does not write clinical rows', async () => {
  const n = await as('nurse1'), a = await fixture(n), b = await fixture(n);
  const before = Number((await env.pool.query('SELECT count(*) FROM observations')).rows[0].count);
  const t = await lg(n, a.pid);
  assert.equal(t.body.total, 3); assert.equal(t.body.counts.all, 3);
  assert.ok(t.body.events.every(e => e.caseId === a.k), 'only this patient\'s case');
  assert.ok(!t.body.events.some(e => e.caseId === b.k));
  assert.equal((await lg(n, 999999)).status, 404); assert.equal((await lg(n, 'abc')).status, 404);
  assert.equal(Number((await env.pool.query('SELECT count(*) FROM observations')).rows[0].count), before);
});

test('entered in error is hidden and counted; includeErrors=1 shows it as its own state', async () => {
  const n = await as('nurse1'), pid = await newPatient(n);
  const keep = await n.post(`/api/patients/${pid}/allergies`, { substance: 'Kept' });
  const gone = await n.post(`/api/patients/${pid}/allergies`, { substance: 'Wrong' });
  assert.equal((await n.post(`/api/allergies/${gone.body.allergy.id}/entered-in-error`, { reason: 'typo', rowVersion: 1 })).status, 200);
  const t = await lg(n, pid); assert.deepEqual(t.body.events.map(e => e.label), ['Kept']); assert.equal(t.body.hiddenInError, 1);
  const all = await lg(n, pid, '?includeErrors=1');
  assert.deepEqual(all.body.events.map(e => [e.label, e.status, e.inError]).sort(), [['Kept', 'active', false], ['Wrong', 'entered_in_error', true]]);
  void keep;
});

test('window, paging after the filter, and bad query values are 400', async () => {
  const n = await as('nurse1'), { pid } = await fixture(n);
  const all = await lg(n, pid, '?context=diabetes,ckd&limit=1');
  assert.equal(all.body.events.length, 1); assert.equal(all.body.total, 2);
  assert.equal((await lg(n, pid, '?context=diabetes,ckd&limit=1&offset=1')).body.events[0].fieldKey, 'creat');
  const today = new Date().toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.equal((await lg(n, pid, `?from=${tomorrow}`)).body.total, 0);
  assert.equal((await lg(n, pid, `?to=${today}`)).body.total, 3);
  for (const qs of ['?context=asthma', '?context=diabetes,diabetes', '?context=diabetes,', '?context=ckd&context=diabetes', '?from=yesterday', '?from=2026-02-30', '?limit=0', '?limit=501', '?offset=-1']) assert.equal((await lg(n, pid, qs)).status, 400, qs);
});

test('role access follows cases:read; signed out is 401; the view is audited with counts and context keys only, no clinical text', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(n);
  await n.post(`/api/patients/${pid}/problems`, { label: 'Audit me please' });
  assert.equal((await lg(v, pid)).status, 200);
  assert.equal((await lg(client(env.base), pid)).status, 401);
  assert.equal((await lg(n, pid, '?context=ckd')).status, 200);
  const row = (await env.pool.query(`SELECT * FROM audit_log WHERE action = 'patient.longitudinal_view' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(row.username, 'nurse1'); assert.deepEqual(row.detail.contexts, ['ckd']);
  assert.ok(!JSON.stringify(row).includes('Audit me'), 'no clinical text in the audit log');
});
