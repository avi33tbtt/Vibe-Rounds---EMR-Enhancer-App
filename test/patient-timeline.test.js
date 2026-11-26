'use strict';
// Task R3g: GET /api/patients/:id/timeline, one read-only timeline across all cases of a patient.
// The permission matrix entry is in safety-routes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, seq = 0;
test.before(async () => { env = await setup(); R = await reviewers(env.base); admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const DEF = { title: 'TL set', fields: [{ id: 'hr', label: 'Heart rate', type: 'number', unit: 'bpm' }] };
async function publishedSet() {
  const made = await R.doctor.post('/api/element-sets', { slug: 'tl-set-' + (++seq), kind: 'custom', definition: DEF });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return made.body.set.id;
}
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Timeline Patient ' + (++seq), mrn: 'TL-' + seq, dob: '1970-01-01', sex: 'M' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const newCase = async (c, pid) => { const k = await c.post(`/api/patients/${pid}/cases`, { title: 'TL case' }); assert.equal(k.status, 201); return k.body.case.id; };
const tl = (c, pid, qs = '') => c.get(`/api/patients/${pid}/timeline${qs}`);

// One patient with two cases; each case has the set applied (a pin) and takes observations.
async function fixture(n) {
  const pid = await newPatient(n), k1 = await newCase(n, pid), k2 = await newCase(n, pid), setId = await publishedSet(), pin = {};
  for (const k of [k1, k2]) { const a = await n.post(`/api/cases/${k}/applied-sets`, { setId, version: 1 }); assert.equal(a.status, 201, JSON.stringify(a.body)); pin[k] = a.body.appliedSet.id; }
  const obs = async (k, value, min) => { const r = await n.post(`/api/cases/${k}/observations`, { observations: [{ appliedSetId: pin[k], fieldKey: 'hr', value, unit: 'bpm', effectiveAt: ago(min), sourceType: 'clinician' }] }); assert.equal(r.status, 201, JSON.stringify(r.body)); };
  return { pid, k1, k2, obs };
}

test('merges observations, signed notes, problems, allergies and medications of ALL cases of the patient, in time order, each with its own source id and case', async () => {
  const n = await as('nurse1'), d = await as('doctor1');
  const { pid, k1, k2, obs } = await fixture(n);
  await obs(k2, 91, 600); await obs(k1, 80, 300);
  const pr = await n.post(`/api/patients/${pid}/problems`, { label: 'Hypertension', originCaseId: k1 });
  const al = await n.post(`/api/patients/${pid}/allergies`, { substance: 'Penicillin' });
  const md = await n.post(`/api/patients/${pid}/medications`, { medication: 'Amlodipine', doseText: 'SECRET-DOSE' });
  const note = await d.post(`/api/cases/${k2}/notes`, { body: 'SECRET-NOTE-BODY' });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const draftOnly = await d.post(`/api/cases/${k2}/notes`, { body: 'unsigned draft' });
  assert.equal(draftOnly.status, 201);
  const signed = await d.post(`/api/notes/${note.body.note.id}/sign`, { rowVersion: note.body.note.row_version });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const t = await tl(n, pid);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const kinds = t.body.events.map(e => e.kind);
  for (const k of ['observation', 'problem', 'allergy', 'medication', 'note']) assert.ok(kinds.includes(k), k);
  assert.equal(kinds.filter(k => k === 'note').length, 1, 'only the signed note');
  assert.ok(t.body.events.every((e, i, a) => i === 0 || new Date(a[i - 1].at) <= new Date(e.at)), 'ascending by time');
  const p = t.body.events.find(e => e.kind === 'problem');
  assert.deepEqual([p.sourceId, p.caseId, p.label, p.status, p.by], [pr.body.problem.id, k1, 'Hypertension', 'active', 'nurse1']);
  assert.equal(t.body.events.find(e => e.kind === 'note').caseId, k2);
  const os = t.body.events.filter(e => e.kind === 'observation');
  assert.deepEqual(os.map(e => [e.caseId, e.value, e.unit, e.fieldKey]), [[k2, 91, 'bpm', 'hr'], [k1, 80, 'bpm', 'hr']], 'both cases, oldest effective time first');
  assert.ok(os.every(e => e.recordedAt && e.effectiveAt), 'effective and recorded time both present');
  assert.ok(os.every(e => /^tl-set-\d+$/.test(e.setSlug)), 'R9e: each observation names the slug of the set it was recorded under');
  assert.ok(t.body.events.filter(e => e.kind !== 'observation').every(e => e.setSlug === undefined), 'only observations carry a set slug');
  assert.equal(t.body.total, t.body.events.length);
  const text = JSON.stringify(t.body);
  assert.ok(!text.includes('SECRET-NOTE-BODY') && !text.includes('SECRET-DOSE'), 'no note text, no dose text');
  void al; void md;
});

test('another patient\'s record never appears; an unknown patient is 404; a bad id is 404', async () => {
  const n = await as('nurse1');
  const a = await newPatient(n), b = await newPatient(n);
  await n.post(`/api/patients/${a}/problems`, { label: 'Only A' });
  await n.post(`/api/patients/${b}/problems`, { label: 'Only B' });
  const t = await tl(n, a);
  assert.deepEqual(t.body.events.map(e => e.label), ['Only A']);
  assert.equal((await tl(n, 999999)).status, 404);
  assert.equal((await tl(n, 'abc')).status, 404);
});

test('entered in error is hidden and counted; includeErrors=1 shows it with its status', async () => {
  const n = await as('nurse1'), pid = await newPatient(n);
  const keep = await n.post(`/api/patients/${pid}/allergies`, { substance: 'Kept' });
  const gone = await n.post(`/api/patients/${pid}/allergies`, { substance: 'Wrong' });
  assert.equal((await n.post(`/api/allergies/${gone.body.allergy.id}/entered-in-error`, { reason: 'typo', rowVersion: 1 })).status, 200);
  const t = await tl(n, pid);
  assert.deepEqual(t.body.events.map(e => e.label), ['Kept']); assert.equal(t.body.hiddenInError, 1);
  const all = await tl(n, pid, '?includeErrors=1');
  assert.deepEqual(all.body.events.map(e => [e.label, e.status]).sort(), [['Kept', 'active'], ['Wrong', 'entered_in_error']]); assert.equal(all.body.hiddenInError, 0);
  void keep;
});

test('window and paging: from and to filter by time, limit and offset page the merged list, bad values are 400', async () => {
  const n = await as('nurse1'), pid = await newPatient(n);
  for (const l of ['One', 'Two', 'Three']) assert.equal((await n.post(`/api/patients/${pid}/problems`, { label: l })).status, 201);
  const all = await tl(n, pid); assert.equal(all.body.total, 3);
  assert.deepEqual((await tl(n, pid, '?limit=2')).body.events.map(e => e.label), ['One', 'Two']);
  const p2 = await tl(n, pid, '?limit=2&offset=2'); assert.deepEqual(p2.body.events.map(e => e.label), ['Three']); assert.equal(p2.body.total, 3);
  const today = new Date().toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10), past = '2000-01-01';
  assert.equal((await tl(n, pid, `?from=${today}`)).body.total, 3);
  assert.equal((await tl(n, pid, `?from=${tomorrow}`)).body.total, 0);
  assert.equal((await tl(n, pid, `?to=${past}`)).body.total, 0);
  assert.equal((await tl(n, pid, `?to=${today}`)).body.total, 3, 'a date-only "to" includes that whole day');
  for (const qs of ['?from=yesterday', '?from=2026-02-30', '?to=2026-13-01', `?from=${tomorrow}&to=${past}`, '?limit=0', '?limit=501', '?limit=x', '?offset=-1', '?offset=1.5']) assert.equal((await tl(n, pid, qs)).status, 400, qs);
});

test('role access follows cases:read (viewer reads); signed-out is refused; the view is audited with counts only', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(n);
  await n.post(`/api/patients/${pid}/problems`, { label: 'Audit me' });
  assert.equal((await tl(v, pid)).status, 200);
  assert.equal((await tl(client(env.base), pid)).status, 401);
  const rows = (await env.pool.query(`SELECT * FROM audit_log WHERE action = 'patient.timeline_view' ORDER BY id DESC LIMIT 1`)).rows;
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows[0]).includes('Audit me'), 'no clinical text in the audit log');
});
