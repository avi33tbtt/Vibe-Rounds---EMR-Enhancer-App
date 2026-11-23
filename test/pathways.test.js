'use strict';
// Task B4a: pathways with immutable versions (server) and applying a pathway to a case.
// The permission matrix and audit scenarios for these routes are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, seq = 0;
test.before(async () => { env = await setup(); R = await reviewers(env.base); admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };   // a fresh session per test keeps clear of the per-session write limit
const DEF = t => ({ title: t, fields: [{ id: 'hr', label: 'Heart rate', type: 'number', unit: 'bpm' }] });
async function publishedSet(title = 'Path set') {
  const slug = 'path-set-' + (++seq);
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: DEF(title) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return { id: made.body.set.id, slug };
}
async function newSetVersion(set) {      // the next version, published
  const v = await R.doctor.post(`/api/element-sets/${set.id}/versions`, { definition: DEF('Path set next') });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  const n = v.body.version.version;
  await approveVersion(R, set.id, n);
  assert.equal((await admin.post(`/api/element-sets/${set.id}/versions/${n}/publish`, {})).status, 200);
  return n;
}
const steps = (...pairs) => pairs.map(([s, v = 1]) => ({ setId: s.id, version: v }));
async function publishedPathway(...pairs) {
  const slug = 'pw-' + (++seq);
  const made = await R.doctor.post('/api/pathways', { slug, title: 'Pathway ' + seq, description: 'A starter', steps: steps(...pairs) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pub = await admin.post(`/api/pathways/${made.body.pathway.id}/versions/1/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  return { id: made.body.pathway.id, slug };
}
async function newCase(c) {
  const p = await c.post('/api/patients', { name: 'Path Patient ' + (++seq), mrn: 'PATH-' + seq, dob: '1980-01-01', sex: 'F' });
  assert.equal(p.status, 201);
  const k = await c.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Path case' });
  assert.equal(k.status, 201);
  return k.body.case.id;
}

test('create: ordered steps name exact published set versions; the actor and checksum come from the server', async () => {
  const a = await publishedSet(), b = await publishedSet();
  const r = await R.doctor.post('/api/pathways', { slug: 'pw-create-' + (++seq), title: 'Two step', description: 'Plain text', steps: steps([b], [a]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.version.version, 1); assert.equal(r.body.version.status, 'draft'); assert.equal(r.body.version.created_by, 'doctor1');
  assert.match(r.body.version.checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.body.version.steps.map(s => [s.position, s.set_slug, s.set_version]), [[1, b.slug, 1], [2, a.slug, 1]], 'the order is kept');
  assert.equal((await R.doctor.get(`/api/pathways/${r.body.pathway.id}/versions/1`)).body.version.steps.length, 2);
  assert.equal((await (await as('viewer1')).get('/api/pathways')).status, 200, 'anyone who can read sets can read pathways');
  assert.equal((await (await as('nurse1')).post('/api/pathways', { slug: 'pw-nurse', title: 'x', steps: steps([a]) })).status, 403);
});

test('create: refuses unknown fields, bad slugs and text, empty or duplicate steps, missing or unpublished set versions, a reused slug', async () => {
  const a = await publishedSet();
  const d = await R.doctor.post(`/api/element-sets/${a.id}/versions`, { definition: DEF('Draft only') });      // v2 stays a draft
  assert.equal(d.status, 201);
  const mk = (extra = {}) => R.doctor.post('/api/pathways', { slug: 'pw-bad-' + (++seq), title: 'T', steps: steps([a]), ...extra });
  let r = await mk({ createdBy: 'mallory' }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field');
  r = await mk({ status: 'published' }); assert.equal(r.body.error, 'unknown_field');
  assert.equal((await mk({ slug: 'Bad Slug' })).status, 400);
  assert.equal((await mk({ title: '  ' })).status, 400);
  assert.equal((await mk({ title: 'x <script>alert(1)</script>' })).status, 400, 'markup-like text is refused');
  assert.equal((await mk({ steps: [] })).status, 400);
  assert.equal((await mk({ steps: [{ setId: a.id, version: 1 }, { setId: a.id, version: 1 }] })).status, 400, 'a set appears once');
  assert.equal((await mk({ steps: [{ setId: a.id }] })).status, 400, 'a step names an exact version');
  assert.equal((await mk({ steps: [{ setId: a.id, version: 1, extra: 1 }] })).status, 400);
  assert.equal((await mk({ steps: [{ setId: a.id, version: 99 }] })).body.error, 'step_not_found');
  r = await mk({ steps: [{ setId: a.id, version: 2 }] }); assert.equal(r.status, 409); assert.equal(r.body.error, 'member_not_published');
  const ok = await mk({ slug: 'pw-reuse' }); assert.equal(ok.status, 201);
  r = await mk({ slug: 'pw-reuse' }); assert.equal(r.status, 409); assert.equal(r.body.error, 'slug_taken');
});

test('publish: admin only, once; a pathway whose member set was retired cannot be published; the database agrees', async () => {
  const a = await publishedSet(), b = await publishedSet();
  const made = await R.doctor.post('/api/pathways', { slug: 'pw-pub-' + (++seq), title: 'Pub', steps: steps([a], [b]) });
  const id = made.body.pathway.id;
  assert.equal((await R.doctor.post(`/api/pathways/${id}/versions/1/publish`, {})).status, 403, 'a doctor cannot publish');
  assert.equal((await admin.post(`/api/pathways/${id}/versions/1/publish`, { publishedBy: 'mallory' })).body.error, 'unknown_field');
  assert.equal((await admin.post(`/api/element-sets/${b.id}/versions/1/retire`, {})).status, 200);
  const rej = await admin.post(`/api/pathways/${id}/versions/1/publish`, {});
  assert.equal(rej.status, 409); assert.equal(rej.body.error, 'member_not_published');
  assert.equal((await env.pool.query('SELECT status FROM pathway_versions WHERE pathway_id = $1', [id])).rows[0].status, 'draft');
  await assert.rejects(env.pool.query(`UPDATE pathway_versions SET status = 'published', published_by = 1, published_at = now() WHERE pathway_id = $1`, [id]), /every step must name a published/);
  const ok = await publishedPathway([a]);
  const again = await admin.post(`/api/pathways/${ok.id}/versions/1/publish`, {});
  assert.equal(again.status, 409); assert.equal(again.body.error, 'not_publishable');
  assert.equal((await admin.get(`/api/pathways/${ok.id}/versions/1`)).body.version.published_by, 'admin1');
});

test('apply: pins the exact set versions, links each pin to the pathway version, records one timeline event, refuses unpublished and archived', async () => {
  const n = await as('nurse1');
  const a = await publishedSet(), b = await publishedSet();
  const pw = await publishedPathway([a], [b]);
  await newSetVersion(a);                                     // the set moves on; the pathway version still names v1
  const caseId = await newCase(n);
  assert.equal((await n.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId: pw.id, version: 1, appliedBy: 'mallory' })).body.error, 'unknown_field');
  assert.equal((await n.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId: pw.id, version: 9 })).body.error, 'version_not_found');
  const r = await n.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId: pw.id, version: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.appliedSets.map(x => [x.slug, x.version, x.state, x.applied_by, x.from_pathway_slug, x.from_pathway_version]),
    [[a.slug, 1, 'active', 'nurse1', pw.slug, 1], [b.slug, 1, 'active', 'nurse1', pw.slug, 1]], 'exact versions, in order, traceable to the pathway version');
  assert.deepEqual(r.body.skipped, []);
  const t = (await n.get(`/api/cases/${caseId}/timeline`)).body;
  assert.equal(t.appliedSets.length, 2); assert.equal(t.appliedSets[0].from_pathway_slug, pw.slug, 'the case timeline shows the source');
  assert.equal(t.events.filter(e => e.event_type === 'pathway_applied').length, 1);
  assert.equal(t.events.filter(e => e.event_type === 'set_applied').length, 2);
  // a draft pathway version and an archived case are refused
  const draft = await R.doctor.post(`/api/pathways/${pw.id}/versions`, { title: 'Next', steps: steps([a, 2]) });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const other = await newCase(n);
  const d = await n.post(`/api/cases/${other}/applied-pathways`, { pathwayId: pw.id, version: 2 });
  assert.equal(d.status, 409); assert.equal(d.body.error, 'not_published');
  const row = (await n.get(`/api/cases/${other}`)).body.case;
  assert.equal((await n.patch(`/api/cases/${other}/archive`, { archived: true, rowVersion: row.row_version })).status, 200);
  assert.equal((await n.post(`/api/cases/${other}/applied-pathways`, { pathwayId: pw.id, version: 1 })).body.error, 'case_archived');
  assert.equal((await n.post('/api/cases/abc/applied-pathways', { pathwayId: pw.id, version: 1 })).status, 404);
});

test('apply: each pin stays removable on its own; the source stays recorded; an existing pin is never changed by a pathway', async () => {
  const n = await as('nurse1');
  const a = await publishedSet(), b = await publishedSet(), c = await publishedSet();
  const pw = await publishedPathway([a], [b], [c]);
  const caseId = await newCase(n);
  const aV2 = await newSetVersion(a);
  const pre = await n.post(`/api/cases/${caseId}/applied-sets`, { setId: a.id, version: aV2 });       // the case already has a newer pin of a
  assert.equal(pre.status, 201);
  const r = await n.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId: pw.id, version: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.appliedSets.map(x => x.slug), [b.slug, c.slug], 'the pin the case already had is left alone');
  assert.deepEqual(r.body.skipped.map(x => [x.slug, x.reason, x.appliedVersion, x.pathwayVersion]), [[a.slug, 'other_version_applied', aV2, 1]]);
  // withdraw one of the pathway's sets: the other stays active and both keep their source
  const bPin = r.body.appliedSets[0], cPin = r.body.appliedSets[1];
  assert.equal((await n.post(`/api/cases/${caseId}/applied-sets/${bPin.id}/withdraw`, {})).status, 200);
  const list = (await n.get(`/api/cases/${caseId}/timeline`)).body.appliedSets;
  const byId = Object.fromEntries(list.map(x => [x.id, x]));
  assert.equal(byId[bPin.id].state, 'withdrawn'); assert.equal(byId[bPin.id].from_pathway_slug, pw.slug, 'the withdrawn pin still names its pathway');
  assert.equal(byId[cPin.id].state, 'active');
  assert.equal(byId[pre.body.appliedSet.id].from_pathway_slug, null, 'a plain pin has no pathway');
  // applying again adds only what is missing (the withdrawn set), and a full pathway is refused
  const again = await n.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId: pw.id, version: 1 });
  assert.equal(again.status, 201); assert.deepEqual(again.body.appliedSets.map(x => x.slug), [b.slug]);
  assert.equal(again.body.skipped.length, 2);
  const full = await n.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId: pw.id, version: 1 });
  assert.equal(full.status, 409); assert.equal(full.body.error, 'nothing_to_apply');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM case_applied_pathways WHERE case_id = $1', [caseId])).rows[0].n, 2, 'a refused apply leaves no application row');
});

test('apply is all or nothing: a retired member set stops it and nothing is written', async () => {
  const n = await as('nurse1');
  const a = await publishedSet(), b = await publishedSet();
  const pw = await publishedPathway([a], [b]);
  assert.equal((await admin.post(`/api/element-sets/${b.id}/versions/1/retire`, {})).status, 200);
  const caseId = await newCase(n);
  const r = await n.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId: pw.id, version: 1 });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'member_not_published');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM case_applied_sets WHERE case_id = $1', [caseId])).rows[0].n, 0);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM case_applied_pathways WHERE case_id = $1', [caseId])).rows[0].n, 0);
});

test('a new pathway version never changes an older one; v1 keeps its exact members', async () => {
  const a = await publishedSet(), b = await publishedSet();
  const pw = await publishedPathway([a]);
  const v2 = await R.doctor.post(`/api/pathways/${pw.id}/versions`, { title: 'Pathway v2', description: 'More', steps: steps([a], [b]) });
  assert.equal(v2.status, 201); assert.equal(v2.body.version.version, 2); assert.equal(v2.body.version.status, 'draft');
  assert.equal((await admin.post(`/api/pathways/${pw.id}/versions/2/publish`, {})).status, 200);
  const v1 = (await admin.get(`/api/pathways/${pw.id}/versions/1`)).body.version;
  assert.equal(v1.steps.length, 1); assert.equal(v1.status, 'published');
  const list = (await admin.get('/api/pathways')).body.pathways.find(p => p.id === pw.id);
  assert.equal(list.latest_version, 2); assert.equal(list.published_version, 2); assert.equal(list.title, 'Pathway v2');
  assert.equal((await admin.get(`/api/pathways/${pw.id}`)).body.versions.length, 2);
});

test('the database itself refuses rewrites and deletes of pathways, steps, applications and pin sources', async () => {
  const n = await as('nurse1');
  const a = await publishedSet();
  const pw = await publishedPathway([a]);
  const caseId = await newCase(n);
  const r = await n.post(`/api/cases/${caseId}/applied-pathways`, { pathwayId: pw.id, version: 1 });
  assert.equal(r.status, 201);
  const q = sql => env.pool.query(sql);
  await assert.rejects(q(`UPDATE pathway_versions SET title = 'changed' WHERE pathway_id = ${pw.id}`), /immutable/);
  await assert.rejects(q(`UPDATE pathway_versions SET checksum = repeat('0', 64) WHERE pathway_id = ${pw.id}`), /immutable/);
  await assert.rejects(q(`UPDATE pathway_versions SET status = 'draft' WHERE pathway_id = ${pw.id}`), /cannot go back/);
  await assert.rejects(q(`UPDATE pathways SET slug = 'renamed' WHERE id = ${pw.id}`), /immutable/);
  await assert.rejects(q(`UPDATE pathway_version_steps SET position = 2`), /not allowed/);
  await assert.rejects(q(`DELETE FROM pathway_version_steps`), /not allowed/);
  await assert.rejects(q(`DELETE FROM pathway_versions`), /not allowed/);
  await assert.rejects(q(`DELETE FROM pathways`), /not allowed/);
  await assert.rejects(q(`TRUNCATE pathways CASCADE`), /not allowed/);
  await assert.rejects(q(`UPDATE case_applied_pathways SET applied_by = 1`), /not allowed/);
  await assert.rejects(q(`DELETE FROM case_applied_pathways`), /not allowed/);
  await assert.rejects(q(`UPDATE case_applied_sets SET from_applied_pathway_id = NULL WHERE case_id = ${caseId}`), /immutable/);
  const vid = (await q(`SELECT id FROM pathway_versions WHERE pathway_id = ${pw.id}`)).rows[0].id;
  await assert.rejects(q(`INSERT INTO pathway_version_steps(pathway_version_id, position, element_set_id, element_set_version_id) SELECT ${vid}, 2, element_set_id, id FROM element_set_versions LIMIT 1`), /draft pathway version/);
  // the app's own role has no DELETE and cannot edit content columns either
  await assert.rejects(env.appPool.query('DELETE FROM pathways'), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE pathway_versions SET title = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE case_applied_sets SET from_applied_pathway_id = NULL`), /permission denied/);
  // a pin cannot name another case's pathway application (same-case foreign key)
  const other = await newCase(n);
  const ap = (await q(`SELECT id FROM case_applied_pathways WHERE case_id = ${caseId}`)).rows[0].id;
  await assert.rejects(q(`INSERT INTO case_applied_sets(case_id, element_set_id, element_set_version_id, applied_by, from_applied_pathway_id)
                           SELECT ${other}, element_set_id, id, 1, ${ap} FROM element_set_versions WHERE status = 'published' LIMIT 1`), /foreign key|violates/);
});
