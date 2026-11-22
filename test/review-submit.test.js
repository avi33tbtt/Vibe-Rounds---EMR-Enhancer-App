'use strict';
// Task 8b: submit a draft element-set version for review. Real PostgreSQL; the app runs as the restricted emr_app role.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, admin, doctor, nurse, viewer, n = 0;
const audits = async action => (await env.pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;
const DEF = (title = 'Review me', extra = {}) => ({ title, fields: [{ id: 'a', label: 'A', type: 'text' }], ...extra });
async function newSet(def = DEF(), who = doctor) {
  const r = await who.post('/api/element-sets', { slug: 'rv-' + (++n), kind: 'custom', definition: def });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return { id: r.body.set.id, v: r.body.version.version };
}
const submit = (s, who = doctor, body = {}) => who.post(`/api/element-sets/${s.id}/versions/${s.v}/submit`, body);
const row = async s => (await env.pool.query('SELECT * FROM element_set_versions WHERE element_set_id = $1 AND version = $2', [s.id, s.v])).rows[0];

test.before(async () => {
  env = await setup();
  admin = client(env.base); doctor = client(env.base); nurse = client(env.base); viewer = client(env.base);
  for (const [c, u] of [[admin, 'admin1'], [doctor, 'doctor1'], [nurse, 'nurse1'], [viewer, 'viewer1']]) assert.equal((await c.login(u)).status, 200);
});
test.after(async () => { await env.close(); });

test('submit moves a draft to in_review; submitter and time come from the session and the server', async () => {
  const s = await newSet();
  const r = await submit(s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.review.status, 'in_review'); assert.equal(r.body.review.submitted_by, 'doctor1');
  assert.ok(r.body.review.submitted_at); assert.equal(r.body.review.lint.ok, true);
  const db = await row(s);
  assert.equal(db.status, 'in_review'); assert.ok(db.lint_json && db.lint_json.ok);
  assert.equal((await audits('set.submit')).pop().username, 'doctor1');
});

test('a body that names an author, status or time is refused and nothing changes', async () => {
  const s = await newSet();
  for (const body of [{ submittedBy: 'mallory' }, { status: 'approved' }, { submittedAt: '2001-01-01' }, { lint: { ok: true } }]) {
    const r = await submit(s, doctor, body);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field');
  }
  assert.equal((await row(s)).status, 'draft');
});

test('lint errors block the submit; the version stays a draft; the refusal is audited', async () => {
  const dose = await newSet(DEF('Dose set', { desc: 'Give 500 mg every 6 hours.' }));
  let r = await submit(dose);
  assert.equal(r.status, 422); assert.equal(r.body.error, 'lint_errors');
  assert.ok(r.body.lint.findings.some(f => f.rule === 'dose-no-citation'));
  assert.equal((await row(dose)).status, 'draft');
  const code = await newSet(DEF('Code set', { fields: [{ id: 'a', label: 'A', type: 'text', bindings: [{ system: 'loinc', code: '2160-0', display: 'Creatinine' }] }] }));
  r = await submit(code);
  assert.equal(r.status, 422); assert.ok(r.body.lint.findings.some(f => f.rule === 'unverified-code'));
  const rej = await audits('set.submit_rejected');
  assert.ok(rej.length >= 2); assert.equal(rej[rej.length - 1].detail.reason, 'lint_errors');
});

test('a cited dose passes, and is flagged as needing two reviewers', async () => {
  const s = await newSet(DEF('Cited dose', { desc: 'Give 500 mg every 6 hours.', citation: 'Local guideline 2026, section 4' }));
  const r = await submit(s);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.review.lint.needsTwoReviewers, true);
});

test('only a draft can be submitted; a second submit is refused', async () => {
  const s = await newSet();
  assert.equal((await submit(s)).status, 200);
  const again = await submit(s);
  assert.equal(again.status, 409); assert.equal(again.body.error, 'not_submittable');
  assert.equal((await submit({ id: s.id, v: 99 })).status, 404);
  assert.equal((await submit({ id: 999999, v: 1 })).status, 404);
});

test('an in-review version cannot be published directly', async () => {
  const s = await newSet(); assert.equal((await submit(s)).status, 200);
  const r = await admin.post(`/api/element-sets/${s.id}/versions/${s.v}/publish`, {});
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_reviewed');
});

test('permissions: nurse and viewer cannot submit; everyone signed in can read the review and the queue', async () => {
  const s = await newSet();
  assert.equal((await submit(s, nurse)).status, 403); assert.equal((await submit(s, viewer)).status, 403);
  assert.equal((await row(s)).status, 'draft');
  assert.equal((await submit(s, admin)).status, 200);
  const g = await viewer.get(`/api/element-sets/${s.id}/versions/${s.v}/review`);
  assert.equal(g.status, 200); assert.equal(g.body.review.submitted_by, 'admin1');
  const q = await nurse.get('/api/review-queue');
  assert.equal(q.status, 200); assert.ok(q.body.queue.some(x => x.set_id === s.id && x.version === s.v));
  assert.equal((await client(env.base).get('/api/review-queue')).status, 401);
});

test('the database freezes a submitted version: content, submitter and lint cannot change, status cannot go back', async () => {
  const s = await newSet(); assert.equal((await submit(s)).status, 200);
  for (const sql of [`UPDATE element_set_versions SET definition_json = '{"title":"x"}' WHERE element_set_id = $1 AND version = $2`,
                     `UPDATE element_set_versions SET lint_json = '{}' WHERE element_set_id = $1 AND version = $2`,
                     `UPDATE element_set_versions SET status = 'draft' WHERE element_set_id = $1 AND version = $2`]) {
    await assert.rejects(env.pool.query(sql, [s.id, s.v]), /immutable|cannot go back/);
  }
  await assert.rejects(env.appPool.query(`UPDATE element_set_versions SET definition_json = '{"title":"x"}' WHERE element_set_id = $1 AND version = $2`, [s.id, s.v]), /permission denied/);
  assert.equal((await row(s)).status, 'in_review');
});

test('concurrent submits of one draft: exactly one wins', async () => {
  const s = await newSet();
  const rs = await Promise.all([submit(s, doctor), submit(s, admin), submit(s, doctor)]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409, 409]);
  assert.equal((await audits('set.submit')).filter(a => a.entity_id === String(s.id)).length, 1);
});
