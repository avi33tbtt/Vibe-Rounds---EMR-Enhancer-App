'use strict';
// Task 8c: reviewer rules and the frozen approved version. Real PostgreSQL; the app runs as the restricted emr_app role.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, admin, doctor, nurse, inf1, inf2, n = 0;
const uid = async name => (await env.pool.query('SELECT id FROM users WHERE username = $1', [name])).rows[0].id;
const audits = async action => (await env.pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;
const DEF = (title = 'Rule set', extra = {}) => ({ title, fields: [{ id: 'a', label: 'A', type: 'text' }], ...extra });
const TWO = DEF('Needs two', { desc: 'Give 500 mg every 6 hours.', citation: 'Local guideline 2026, section 4' });   // cited dose: lint flags needsTwoReviewers
async function submitted(def = DEF()) {
  const r = await doctor.post('/api/element-sets', { slug: 'rr-' + (++n), kind: 'custom', definition: def });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const s = { id: r.body.set.id, v: 1 };
  const sub = await doctor.post(`/api/element-sets/${s.id}/versions/1/submit`, {});
  assert.equal(sub.status, 200, JSON.stringify(sub.body)); return s;
}
const approve = (s, who, reason = 'Looks right') => who.post(`/api/element-sets/${s.id}/versions/${s.v}/approve`, { reason });
const reject = (s, who, reason = 'Not right') => who.post(`/api/element-sets/${s.id}/versions/${s.v}/reject`, { reason });
const row = async s => (await env.pool.query('SELECT * FROM element_set_versions WHERE element_set_id = $1 AND version = $2', [s.id, s.v])).rows[0];

test.before(async () => {
  env = await setup();
  admin = client(env.base); doctor = client(env.base); nurse = client(env.base); inf1 = client(env.base); inf2 = client(env.base);
  for (const [c, u] of [[admin, 'admin1'], [doctor, 'doctor1'], [nurse, 'nurse1'], [inf1, 'informatician1'], [inf2, 'informatician2']]) assert.equal((await c.login(u)).status, 200);
});
test.after(async () => { await env.close(); });

test('one informatician approves an ordinary set: reviewed, reviewer and reason recorded from the session', async () => {
  const s = await submitted();
  const r = await approve(s, inf1, 'Matches the local template');
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'reviewed'); assert.equal(r.body.approvalsNeeded, 1);
  const g = await nurse.get(`/api/element-sets/${s.id}/versions/1/review`);
  assert.equal(g.body.review.status, 'reviewed'); assert.equal(g.body.reviews.length, 1);
  assert.equal(g.body.reviews[0].reviewer, 'informatician1'); assert.equal(g.body.reviews[0].reason, 'Matches the local template'); assert.ok(g.body.reviews[0].created_at);
  assert.equal((await audits('set.approve')).pop().username, 'informatician1');
});

test('doctors, admins and nurses cannot approve or reject', async () => {
  const s = await submitted();
  for (const who of [doctor, admin, nurse]) { assert.equal((await approve(s, who)).status, 403); assert.equal((await reject(s, who)).status, 403); }
  assert.equal((await row(s)).status, 'in_review');
});

test('a body that names a reviewer, status or time is refused; a reason is required', async () => {
  const s = await submitted();
  for (const body of [{ reason: 'x', reviewer: 'mallory' }, { reason: 'x', status: 'published' }, { reason: 'x', reviewedAt: '2001-01-01' }]) {
    const r = await inf1.post(`/api/element-sets/${s.id}/versions/1/approve`, body);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field');
  }
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 5 }, { reason: 'x'.repeat(1001) }]) assert.equal((await inf1.post(`/api/element-sets/${s.id}/versions/1/approve`, body)).status, 400);
  assert.equal((await row(s)).status, 'in_review');
});

test('the author cannot approve their own set (server rule, audited), and the database refuses it too', async () => {
  // An informatician authors a version (inserted as the owner: no route lets an informatician write); a doctor submits it.
  const i1 = await uid('informatician1');
  const set = (await env.pool.query(`INSERT INTO element_sets(slug, title, kind, created_by) VALUES ('rr-own','Own','custom',$1) RETURNING id`, [i1])).rows[0];
  const def = DEF('Own');
  const { checksumOf } = require('../sets');
  await env.pool.query(`INSERT INTO element_set_versions(element_set_id, version, definition_json, checksum, created_by) VALUES ($1,1,$2,$3,$4)`, [set.id, JSON.stringify(def), checksumOf(def), i1]);
  const s = { id: set.id, v: 1 };
  assert.equal((await doctor.post(`/api/element-sets/${s.id}/versions/1/submit`, {})).status, 200);
  for (const call of [approve, reject]) {
    const r = await call(s, inf1);
    assert.equal(r.status, 403); assert.equal(r.body.error, 'own_version');
  }
  assert.equal((await row(s)).status, 'in_review');
  assert.ok((await audits('set.review_refused')).some(a => a.detail.reason === 'own_version' && a.username === 'informatician1'));
  await assert.rejects(env.pool.query(`INSERT INTO element_set_reviews(element_set_id, version, reviewer_id, decision, reason) VALUES ($1,1,$2,'approve','x')`, [s.id, i1]), /author or the submitter/);
  // another informatician may review it
  assert.equal((await approve(s, inf2)).status, 200);
});

test('a set with a dose needs two different reviewers; the same reviewer twice is refused', async () => {
  const s = await submitted(TWO);
  let r = await approve(s, inf1);
  assert.equal(r.status, 200); assert.equal(r.body.status, 'in_review'); assert.equal(r.body.approvalsNeeded, 2);
  const again = await approve(s, inf1);
  assert.equal(again.status, 409); assert.equal(again.body.error, 'already_reviewed');
  assert.equal((await reject(s, inf1)).status, 409);
  assert.equal((await row(s)).status, 'in_review');
  r = await approve(s, inf2);
  assert.equal(r.status, 200); assert.equal(r.body.status, 'reviewed');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM element_set_reviews WHERE element_set_id = $1', [s.id])).rows[0].n, 2);
});

test('one reject ends the version; it can no longer be approved or published; a new draft version starts over', async () => {
  const s = await submitted(TWO);
  assert.equal((await approve(s, inf1)).status, 200);
  const r = await reject(s, inf2, 'Dose wording is unclear');
  assert.equal(r.status, 200); assert.equal(r.body.status, 'rejected');
  assert.equal((await approve(s, inf1)).status, 409);
  assert.equal((await admin.post(`/api/element-sets/${s.id}/versions/1/publish`, {})).status, 409);
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET status = 'reviewed' WHERE element_set_id = $1 AND version = 1`, [s.id]), /final/);
  const v2 = await doctor.post(`/api/element-sets/${s.id}/versions`, { definition: TWO });
  assert.equal(v2.status, 201); assert.equal(v2.body.version.version, 2); assert.equal(v2.body.version.status, 'draft');
});

test('review needs a version in review: a draft, an unknown version and a signed-out call are refused', async () => {
  const d = await doctor.post('/api/element-sets', { slug: 'rr-draft', kind: 'custom', definition: DEF('Draft') });
  assert.equal((await approve({ id: d.body.set.id, v: 1 }, inf1)).status, 409);
  assert.equal((await approve({ id: d.body.set.id, v: 9 }, inf1)).status, 404);
  assert.equal((await approve({ id: 999999, v: 1 }, inf1)).status, 404);
  assert.equal((await approve({ id: d.body.set.id, v: 1 }, client(env.base))).status, 401);
});

test('an approved version cannot be changed: not through the app role, not even by the owner, and it cannot be deleted', async () => {
  const s = await submitted(); assert.equal((await approve(s, inf1)).status, 200);
  const upd = col => `UPDATE element_set_versions SET ${col} WHERE element_set_id = $1 AND version = $2`;
  for (const sql of [upd(`definition_json = '{"title":"x"}'`), upd(`checksum = repeat('a',64)`), upd(`lint_json = '{}'`), upd(`submitted_by = 1`), upd(`status = 'draft'`), upd(`status = 'in_review'`)]) {
    await assert.rejects(env.appPool.query(sql, [s.id, s.v]), /permission denied|immutable|cannot go back/, 'app role: ' + sql);
    await assert.rejects(env.pool.query(sql, [s.id, s.v]), /immutable|cannot go back/, 'owner: ' + sql);
  }
  await assert.rejects(env.appPool.query('DELETE FROM element_set_versions WHERE element_set_id = $1', [s.id]), /permission denied/);
  await assert.rejects(env.pool.query('DELETE FROM element_set_versions WHERE element_set_id = $1', [s.id]), /append-only|not allowed/);
  await assert.rejects(env.pool.query('UPDATE element_set_reviews SET decision = \'reject\' WHERE element_set_id = $1', [s.id]), /append-only/);
  assert.equal((await row(s)).status, 'reviewed');
});

test('approval is earned in the database: the status cannot be set to reviewed without the approvals', async () => {
  const s = await submitted(TWO);
  const set = sql => env.pool.query(sql, [s.id]);
  await assert.rejects(set(`UPDATE element_set_versions SET status = 'reviewed' WHERE element_set_id = $1 AND version = 1`), /needs 2 different approving/);
  assert.equal((await approve(s, inf1)).status, 200);
  await assert.rejects(set(`UPDATE element_set_versions SET status = 'reviewed' WHERE element_set_id = $1 AND version = 1`), /needs 2 different approving/);
  const draft = await doctor.post('/api/element-sets', { slug: 'rr-skip', kind: 'custom', definition: DEF('Skip') });
  await assert.rejects(env.pool.query(`UPDATE element_set_versions SET status = 'reviewed' WHERE element_set_id = $1`, [draft.body.set.id]), /only a version in review/);
  // a reviewer must be an informatician
  await assert.rejects(env.pool.query(`INSERT INTO element_set_reviews(element_set_id, version, reviewer_id, decision, reason) VALUES ($1,1,$2,'approve','x')`, [s.id, await uid('admin1')]), /only an informatician/);
});

test('concurrent approvals by two reviewers of a two-reviewer set both count; double-clicks by one reviewer count once', async () => {
  const s = await submitted(TWO);
  const rs = await Promise.all([approve(s, inf1), approve(s, inf2), approve(s, inf1)]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 200, 409]);
  assert.equal((await row(s)).status, 'reviewed');
});

test('the review read route lists reviews and how many approvals are needed', async () => {
  const s = await submitted(TWO); await approve(s, inf1, 'First look');
  const g = await inf2.get(`/api/element-sets/${s.id}/versions/1/review`);
  assert.equal(g.status, 200); assert.equal(g.body.approvalsNeeded, 2); assert.deepEqual(g.body.reviews.map(x => x.reviewer), ['informatician1']);
});
