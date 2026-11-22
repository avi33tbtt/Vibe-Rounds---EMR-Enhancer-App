'use strict';
// Task 8c-2: only an approved version can be published. Route and database both refuse anything else.
// Real PostgreSQL; the app runs as the restricted emr_app role.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, doctor, inf1, inf2, n = 0;
const audits = async action => (await env.pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;
const DEF = (title = 'Publish me', extra = {}) => ({ title, fields: [{ id: 'a', label: 'A', type: 'text' }], ...extra });
const TWO = DEF('Needs two', { desc: 'Give 500 mg every 6 hours.', citation: 'Local guideline 2026, section 4' });   // lint flags needsTwoReviewers
async function draft(def = DEF()) {
  const r = await doctor.post('/api/element-sets', { slug: 'pr-' + (++n), kind: 'custom', definition: def });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.set.id;
}
const publish = (id, who = admin, v = 1) => who.post(`/api/element-sets/${id}/versions/${v}/publish`, {});
const status = async id => (await env.pool.query('SELECT status, published_by FROM element_set_versions WHERE element_set_id = $1 AND version = 1', [id])).rows[0];
// What the restricted app role could do if the route code were bypassed.
const forcePublish = (pool, id) => pool.query(`UPDATE element_set_versions SET status = 'published', published_by = 1, published_at = now() WHERE element_set_id = $1 AND version = 1`, [id]);

test.before(async () => {
  env = await setup();
  R = await reviewers(env.base); doctor = R.doctor; inf1 = R.inf1; inf2 = R.inf2;
  admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200);
});
test.after(async () => { await env.close(); });

test('a draft cannot be published: refused, nothing changes, the refusal is audited', async () => {
  const id = await draft();
  const r = await publish(id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_reviewed');
  assert.deepEqual(await status(id), { status: 'draft', published_by: null });
  const a = (await audits('set.publish_rejected')).pop();
  assert.equal(a.detail.reason, 'not_reviewed'); assert.equal(a.username, 'admin1');
  assert.equal((await audits('set.publish')).length, 0);
});

test('a version still in review cannot be published', async () => {
  const id = await draft();
  assert.equal((await doctor.post(`/api/element-sets/${id}/versions/1/submit`, {})).status, 200);
  const r = await publish(id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_reviewed');
  assert.equal((await status(id)).status, 'in_review');
});

test('an approved version is published by an admin; the publisher is the session user, not the reviewer', async () => {
  const id = await draft();
  await approveVersion(R, id, 1);
  assert.equal((await status(id)).status, 'reviewed');
  const r = await publish(id);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.version.status, 'published'); assert.equal(r.body.version.published_by, 'admin1');
  assert.equal((await audits('set.publish')).pop().username, 'admin1');
  assert.equal((await publish(id)).status, 409, 'already published');
});

test('reviewers and doctors cannot publish an approved version either (publish stays admin-only)', async () => {
  const id = await draft();
  await approveVersion(R, id, 1);
  for (const who of [inf1, inf2, doctor]) assert.equal((await publish(id, who)).status, 403);
  assert.equal((await status(id)).status, 'reviewed');
});

test('a set that needs two reviewers cannot be published after one approval', async () => {
  const id = await draft(TWO);
  assert.equal((await doctor.post(`/api/element-sets/${id}/versions/1/submit`, {})).status, 200);
  assert.equal((await inf1.post(`/api/element-sets/${id}/versions/1/approve`, { reason: 'First look' })).body.status, 'in_review');
  assert.equal((await publish(id)).status, 409);
  assert.equal((await inf2.post(`/api/element-sets/${id}/versions/1/approve`, { reason: 'Second look' })).body.status, 'reviewed');
  assert.equal((await publish(id)).status, 200);
});

test('a rejected version cannot be published', async () => {
  const id = await draft();
  assert.equal((await doctor.post(`/api/element-sets/${id}/versions/1/submit`, {})).status, 200);
  assert.equal((await inf1.post(`/api/element-sets/${id}/versions/1/reject`, { reason: 'Not right' })).status, 200);
  const r = await publish(id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_publishable');
});

test('the database refuses to publish a draft or an in-review version, as the app role and as the owner', async () => {
  const d = await draft();
  for (const pool of [env.appPool, env.pool]) await assert.rejects(forcePublish(pool, d), /only an approved/);
  assert.equal((await doctor.post(`/api/element-sets/${d}/versions/1/submit`, {})).status, 200);
  for (const pool of [env.appPool, env.pool]) await assert.rejects(forcePublish(pool, d), /only an approved/);
  assert.equal((await status(d)).status, 'in_review');
  // an approved version still publishes through SQL: the database rule is "reviewed first", not "never"
  const ok = await draft(); await approveVersion(R, ok, 1);
  await forcePublish(env.appPool, ok);
  assert.equal((await status(ok)).status, 'published');
});
