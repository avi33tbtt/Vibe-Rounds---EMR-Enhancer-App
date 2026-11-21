'use strict';
// node --test review-lifecycle.test.js  (needs DATABASE_URL; creates and drops its own database)
// 44c1: the review lifecycle seen from outside, in four groups: (1) an approved version is immutable; (2) an edit after approval makes a new draft;
// (3) every review action writes its review_events row and its audit_log row, in the same step; (4) an informatician cannot chart.
// Made-up set ids only. Runs as the restricted emr_app role. The per-route details are in review-requests, review-approve and review-decide tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { ROUTE_ACTIONS, can } = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_lc_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['lc-' + role, 'LC ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const llm = { name: 'mock', model: 'mock-1', complete: async () => '{}' };
const ACC = { view: ['admin'], enter: ['admin'], amend: ['admin'], approve: ['admin'], configure: ['admin'], export: ['admin'] };   // same shape as review-requests.test.js
const REFS = [{ id: 'r1', citation: 'Local protocol (made-up test reference)' }];
const send = (m, u, b, role) => { const q = request(app)[m](u); if (role) q.set('x-test-role', role); return b === undefined ? q : q.send(b); };
const post = (u, b, role) => send('post', u, b, role);
const save = (setId, body, expectedVersion) => post('/api/element-sets', Object.assign({ setId, kind: 'custom', body }, expectedVersion ? { expectedVersion } : {}));
const submit = async (setId, version = 1, role = 'doctor') => { const r = await post('/api/review-requests', { setId, version }, role); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id; };
const decide = (id, what, role = 'informatician', body = {}) => post(`/api/review-requests/${id}/${what}`, body, role);
const row = async (setId, v) => (await owner.query('SELECT * FROM element_sets WHERE set_id=$1 AND version=$2', [setId, v])).rows[0];
const rr = async (id) => (await owner.query('SELECT * FROM review_requests WHERE id=$1', [id])).rows[0];
const evs = async (id) => (await owner.query('SELECT * FROM review_events WHERE request_id=$1 ORDER BY id', [id])).rows;
const auds = async (id) => (await owner.query("SELECT * FROM audit_log WHERE entity='review_request' AND entity_id=$1 ORDER BY id", [id])).rows;

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${pw}'`);
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = pw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb, getActor, llm });
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

// ---------- 1. an approved version is immutable ----------
test('1: approving freezes the version as local-reviewed and leaves its body, hash and version as saved', async () => {
  assert.equal((await save('user.imm', { title: 'Immutable', access: ACC })).status, 201);
  const saved = await row('user.imm', 1);
  assert.equal(saved.tier, 'local-draft');
  const id = await submit('user.imm');
  assert.equal((await decide(id, 'approve')).status, 200);
  const after = await row('user.imm', 1);
  assert.equal(after.tier, 'local-reviewed');
  assert.deepEqual(Object.assign({}, after, { tier: null }), Object.assign({}, saved, { tier: null }), 'only the tier differs');
});

// KNOWN GAP (found while writing 44c1, 21 Nov 2026): 003_audit_grants.sql gives emr_app SELECT, INSERT, UPDATE and DELETE on every table and takes back
// only audit_log and review_events, so 015_review_approve.sql ("UPDATE on ONE column, tier, and nothing wider") does not narrow anything: today the version is
// immutable because no route changes it, not because the database refuses. This test is marked todo (it is run and reported, but a failure does not fail
// the suite). It passes once a migration revokes UPDATE and DELETE on element_sets and grants UPDATE (tier) only. It works on a scratch row, never on a real one.
test('1: the database itself refuses to change the body, hash or version of a stored set version (needs a migration, see the note above)', { todo: 'emr_app still has full UPDATE and DELETE on element_sets (003_audit_grants.sql)' }, async () => {
  await owner.query("INSERT INTO element_sets (set_id, version, kind, body, content_hash) VALUES ('user.scratch', 1, 'custom', '{\"title\":\"S\"}', 'h')");
  try {
    for (const set of ["body='{}'::jsonb", "content_hash='x'", 'version=9', "kind='care'"]) await assert.rejects(appDb.query(`UPDATE element_sets SET ${set} WHERE set_id='user.scratch'`), (e) => e.code === '42501', set);
    await assert.rejects(appDb.query("DELETE FROM element_sets WHERE set_id='user.scratch'"), (e) => e.code === '42501', 'delete');
  } finally { await owner.query("DELETE FROM element_sets WHERE set_id='user.scratch' OR (set_id='user.scratch' AND version=9)"); await owner.query("DELETE FROM element_sets WHERE content_hash='x' AND set_id LIKE 'user.scratch%'"); }
});

test('1: saving the same set again does not touch the approved version; it is still readable as it was, with its own hash', async () => {
  const before = await row('user.imm', 1);
  assert.equal((await save('user.imm', { title: 'Immutable, edited', access: ACC }, 1)).status, 201);
  assert.deepEqual(await row('user.imm', 1), before);
  const v1 = await send('get', '/api/element-sets/user.imm/versions/1');
  assert.equal(v1.status, 200); assert.equal(v1.body.tier, 'local-reviewed'); assert.equal(v1.body.body.title, 'Immutable'); assert.equal(v1.body.contentHash, before.content_hash);
});

test('1: an approved version cannot be submitted, approved, sent back or rejected again, and a decided request cannot be decided twice', async () => {
  assert.equal((await save('user.imm0', { title: 'Zero', access: ACC })).status, 201);
  assert.equal((await decide(await submit('user.imm0'), 'approve')).status, 200);
  const r = await post('/api/review-requests', { setId: 'user.imm0', version: 1 }, 'doctor');
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'already_reviewed');
  const old = await post('/api/review-requests', { setId: 'user.imm', version: 1 }, 'doctor');   // version 1 of user.imm has a newer version by now
  assert.equal(old.status, 409);
  assert.equal((await save('user.imm2', { title: 'Two', access: ACC })).status, 201);
  const id = await submit('user.imm2');
  assert.equal((await decide(id, 'reject', 'informatician', { comment: 'no' })).status, 200);
  for (const w of ['approve', 'request-changes', 'reject']) assert.equal((await decide(id, w, 'admin', { comment: 'again' })).status, 409, w);
  assert.equal((await rr(id)).status, 'rejected');
});

test('1: the tier cannot be set from outside: a save that claims tier local-reviewed is refused or stored as a draft', async () => {
  const r = await post('/api/element-sets', { setId: 'user.forge', kind: 'custom', body: { title: 'Forge', access: ACC }, tier: 'local-reviewed' });
  if (r.status === 201) assert.equal((await row('user.forge', 1)).tier, 'local-draft');
  else assert.ok([400, 422].includes(r.status), String(r.status));
  const r2 = await post('/api/element-sets', { setId: 'user.forge2', kind: 'custom', body: { title: 'Forge', access: ACC, tier: 'local-reviewed' } });
  if (r2.status === 201) assert.equal((await row('user.forge2', 1)).tier, 'local-draft');
});

// ---------- 2. an edit after approval makes a draft ----------
test('2: editing an approved set saves version 2 as a local-draft with a new hash; version 1 stays reviewed; the latest version is the draft', async () => {
  const v1 = await row('user.imm', 1), v2 = await row('user.imm', 2);
  assert.ok(v2, 'version 2 exists'); assert.equal(v2.tier, 'local-draft'); assert.notEqual(v2.content_hash, v1.content_hash);
  assert.equal(v1.tier, 'local-reviewed');
  const latest = await send('get', '/api/element-sets/user.imm');
  assert.equal(latest.status, 200); assert.equal(latest.body.version, 2); assert.equal(latest.body.tier, 'local-draft');
  const idx = (await send('get', '/api/element-sets')).body.find((x) => x.setId === 'user.imm' || x.set_id === 'user.imm');
  if (idx) assert.equal(idx.tier, 'local-draft');
});

test('2: the new draft needs its own review: it can be submitted, and approving it does not need or change version 1', async () => {
  const id = await submit('user.imm', 2);
  assert.equal((await rr(id)).set_version, 2);
  assert.equal((await decide(id, 'approve')).status, 200);
  assert.equal((await row('user.imm', 2)).tier, 'local-reviewed'); assert.equal((await row('user.imm', 1)).tier, 'local-reviewed');
  assert.equal((await row('user.imm', 1)).body.title, 'Immutable');
});

test('2: editing after a decision never rewrites the old request: an approved request keeps its status, reviewer and hash', async () => {
  const old = (await owner.query("SELECT * FROM review_requests WHERE set_id='user.imm' AND set_version=1")).rows[0];
  assert.equal((await save('user.imm', { title: 'Immutable, third', access: ACC }, 2)).status, 201);
  const now = (await owner.query("SELECT * FROM review_requests WHERE set_id='user.imm' AND set_version=1")).rows[0];
  assert.equal(now.status, 'approved'); assert.equal(now.reviewer_id, old.reviewer_id); assert.equal(now.content_hash, old.content_hash);
  assert.equal((await row('user.imm', 3)).tier, 'local-draft');
});

test('2: a stale save (not the latest version) is refused and creates nothing', async () => {
  const r = await save('user.imm', { title: 'Stale', access: ACC }, 1);
  assert.equal(r.status, 409);
  assert.equal(await row('user.imm', 4), undefined);
});

// ---------- 3. every action writes review_events and audit_log ----------
const SEEN = [];   // [action, requestId] for every review action below, checked together at the end
const oneEach = async (id, event, action, user) => {
  const e = (await evs(id)).filter((x) => x.event === event), a = (await auds(id)).filter((x) => x.action === action);
  assert.equal(e.length, 1, event + ' event'); assert.equal(a.length, 1, action + ' audit row');
  assert.equal(e[0].user_id, user.id); assert.equal(a[0].user_id, user.id);
  return { e: e[0], a: a[0] };
};

test('3: submit writes one "submitted" event and one review.submit audit row, by the submitter', async () => {
  assert.equal((await save('user.ev1', { title: 'E1', access: ACC })).status, 201);
  const id = await submit('user.ev1'); SEEN.push(id);
  const { a } = await oneEach(id, 'submitted', 'review.submit', actors.doctor);
  assert.equal(a.after.status, 'submitted'); assert.equal(a.after.setId, 'user.ev1');
});

test('3: approve writes one "approved" event and one review.approve audit row, by the reviewer', async () => {
  assert.equal((await save('user.ev2', { title: 'E2', access: ACC })).status, 201);
  const id = await submit('user.ev2'); SEEN.push(id);
  assert.equal((await decide(id, 'approve', 'informatician', { comment: 'fine' })).status, 200);
  const { a } = await oneEach(id, 'approved', 'review.approve', actors.informatician);
  assert.equal(a.after.status, 'approved'); assert.equal(a.after.finalized, true);
  assert.ok(!JSON.stringify(a).includes('fine'), 'the comment text is not copied into the audit row');
});

test('3: the first of two approvals writes "approval_recorded" and a review.approve row; the second writes "approved" and a second row', async () => {
  assert.equal((await save('user.ev3', { title: 'E3', access: ACC, rules: [{ op: '>', threshold: 38 }], references: REFS })).status, 201);
  const id = await submit('user.ev3'); SEEN.push(id);
  assert.equal((await decide(id, 'approve', 'informatician')).status, 200);
  assert.deepEqual((await evs(id)).map((x) => x.event), ['submitted', 'approval_recorded']);
  assert.deepEqual((await auds(id)).map((x) => x.action), ['review.submit', 'review.approve']);
  assert.equal((await decide(id, 'approve', 'admin')).status, 200);
  assert.deepEqual((await evs(id)).map((x) => x.event), ['submitted', 'approval_recorded', 'approved']);
  assert.deepEqual((await auds(id)).map((x) => x.action), ['review.submit', 'review.approve', 'review.approve']);
});

test('3: request-changes and reject each write one event and one audit row, by the reviewer, with the comment in the event only', async () => {
  for (const [what, event, action, set] of [['request-changes', 'changes_requested', 'review.request_changes', 'user.ev4'], ['reject', 'rejected', 'review.reject', 'user.ev5']]) {
    assert.equal((await save(set, { title: set, access: ACC })).status, 201);
    const id = await submit(set); SEEN.push(id);
    assert.equal((await decide(id, what, 'informatician', { comment: 'Secret reason ' + set })).status, 200, what);
    const { e, a } = await oneEach(id, event, action, actors.informatician);
    assert.ok(JSON.stringify(e.detail).includes('Secret reason ' + set));
    assert.ok(!JSON.stringify(a).includes('Secret reason'), 'the audit row holds no comment text');
  }
});

test('3: a refused action writes nothing: wrong role, own request, missing comment, bad status', async () => {
  assert.equal((await save('user.ev6', { title: 'E6', access: ACC })).status, 201);
  const id = await submit('user.ev6');
  const n = async () => [(await evs(id)).length, (await auds(id)).length];
  const start = await n();
  assert.equal((await decide(id, 'approve', 'nurse')).status, 403);
  assert.equal((await decide(id, 'reject', 'viewer', { comment: 'x' })).status, 403);
  assert.equal((await decide(id, 'approve', 'doctor')).status, 403);   // the author
  assert.equal((await decide(id, 'reject', 'informatician', {})).status, 400);
  assert.equal((await decide(id, 'request-changes', 'informatician', { comment: '' })).status, 400);
  assert.deepEqual(await n(), start);
  assert.equal((await rr(id)).status, 'submitted');
});

test('3: a new version that withdraws a request writes the withdrawal into the set.save audit row', async () => {
  assert.equal((await save('user.ev7', { title: 'E7', access: ACC })).status, 201);
  const id = await submit('user.ev7');
  assert.equal((await save('user.ev7', { title: 'E7 b', access: ACC }, 1)).status, 201);
  assert.equal((await rr(id)).status, 'withdrawn');
  const a = (await owner.query("SELECT * FROM audit_log WHERE action='set.save' AND entity_id='user.ev7' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual(a.after.withdrawnRequests, [{ id, version: 1 }]);
});

test('3: every review event row names a request, a user and an event; every review audit row names the actor\'s role', async () => {
  for (const id of SEEN) for (const e of await evs(id)) { assert.ok(e.request_id && e.user_id && e.event && e.at); }
  const all = (await owner.query("SELECT * FROM audit_log WHERE action LIKE 'review.%'")).rows;
  assert.ok(all.length >= 8);
  for (const a of all) { assert.ok(a.user_id && a.role, a.action); assert.equal(a.entity, 'review_request'); }
});

test('3: no review route is missing from the audit-coverage list: each POST review route has an action', () => {
  for (const k of ['POST /review-requests', 'POST /review-requests/:id/approve', 'POST /review-requests/:id/request-changes', 'POST /review-requests/:id/reject']) assert.ok(ROUTE_ACTIONS[k], k);
});

// ---------- 4. an informatician cannot chart ----------
const ID = '00000000-0000-4000-8000-000000000001';
const CHART = [
  ['post', '/api/cases', {}], ['patch', `/api/cases/${ID}`, {}], ['post', `/api/cases/${ID}/rows`, {}], ['patch', `/api/cases/${ID}/rows/${ID}`, {}], ['post', `/api/cases/${ID}/rows/${ID}/error`, {}],
  ['put', `/api/cases/${ID}/values`, {}], ['post', `/api/cases/${ID}/notes`, {}], ['post', `/api/cases/${ID}/notes/${ID}/sign`, {}], ['post', `/api/cases/${ID}/link`, {}],
  ['post', `/api/cases/${ID}/alert-acks`, {}], ['post', `/api/cases/${ID}/handover`, {}],
  ['post', '/api/patients', {}], ['patch', `/api/patients/${ID}`, {}], ['post', `/api/patients/${ID}/encounters`, {}], ['patch', `/api/encounters/${ID}`, {}], ['post', `/api/encounters/${ID}/close`, {}],
];
const READS_IDENTITY = [['get', '/api/patients'], ['get', `/api/patients/${ID}`], ['get', `/api/cases/${ID}/export`]];

const COUNT = async () => { const o = {}; for (const t of ['patients', 'encounters', 'cases', 'case_values', 'case_rows', 'case_notes']) o[t] = +(await owner.query(`SELECT count(*) FROM ${t}`)).rows[0].count; return o; };
test('4: every charting route refuses an informatician with 403 and writes nothing', async () => {
  const start = await COUNT();
  for (const [m, u, b] of CHART) assert.equal((await send(m, u, b, 'informatician')).status, 403, m + ' ' + u);
  assert.deepEqual(await COUNT(), start);
});

test('4: the same calls as a doctor are not refused for role (so the 403 above is about the informatician role)', async () => {
  for (const [m, u, b] of CHART) assert.notEqual((await send(m, u, b, 'doctor')).status, 403, 'doctor ' + m + ' ' + u);
});

test('4: an informatician cannot read patient identities or export a case', async () => {
  for (const [m, u] of READS_IDENTITY) assert.equal((await send(m, u, undefined, 'informatician')).status, 403, u);
});

test('4: the informatician does have the content actions, and none of the charting, signing, approval or export-with-identity ones', () => {
  const u = { role: 'informatician' };
  for (const a of ['content.review', 'content.submit', 'set.write', 'code.write', 'analytics.export']) assert.equal(can(u, a), true, a);
  for (const a of ['case.create', 'row.add', 'row.amend_own', 'row.amend_any', 'value.write', 'note.write', 'note.sign', 'patient.read', 'patient.write', 'encounter.write', 'case.link', 'case.export', 'rule.approve', 'protocol.approve', 'alert.ack', 'handover.mark']) assert.equal(can(u, a), false, a);
});
