'use strict';
// Task DM2a: import and acknowledge CCIS run records (ccis-runs.js, migration 015).
// The permission matrix and audit scenario rows are in safety-routes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');
const { createApp } = require('../app');
const { SECRET, caseWithExport, exportEnvelope, runRecord } = require('./ccis-helpers');

let env, doctor, admin, nurse, viewer;
const login = async u => { const c = client(env.base); assert.equal((await c.login(u)).status, 200, u); return c; };
test.before(async () => {
  env = await setup({ contextSecret: SECRET });
  [doctor, admin, nurse, viewer] = await Promise.all(['doctor1', 'admin1', 'nurse1', 'viewer1'].map(login));
});
test.after(async () => { await env.close(); });

const imp = (c, caseId, rec) => c.post(`/api/cases/${caseId}/ccis-runs`, rec);
const runs = async caseId => (await doctor.get(`/api/cases/${caseId}/ccis-runs`)).body.runs;
const userId = async u => (await env.pool.query('SELECT id FROM users WHERE username = $1', [u])).rows[0].id;
// A digest of every clinical table: if an import or an ack touched any of them, this changes.
const CLINICAL = ['patients', 'encounters', 'clinical_cases', 'case_encounters', 'case_narrative_entries', 'case_applied_sets', 'case_applied_pathways', 'observations', 'clinical_events',
  'case_notes', 'case_note_amendments', 'element_sets', 'element_set_versions', 'element_set_reviews', 'pathways', 'pathway_versions', 'pathway_version_steps', 'context_exports'];
async function digest() {
  const out = {};
  for (const t of CLINICAL) out[t] = (await env.pool.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0];
  return out;
}

test('a record made from an exported envelope of this case imports; importer comes from the session; GET lists it', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const rec = runRecord(k);
  const r = await imp(doctor, k.caseId, rec);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.alreadyImported, false);
  const run = r.body.run;
  assert.equal(run.imported_by, 'doctor1');
  assert.equal(run.case_id, k.caseId);
  assert.equal(run.envelope_sha256, k.sha);
  assert.match(run.run_record_sha256, /^[0-9a-f]{64}$/);
  assert.equal(run.record_id, rec.id);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.run_record, rec, 'the record is kept exactly as received');
  const list = await runs(k.caseId);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, run.id);
  assert.deepEqual(list[0].acks, []);
});

test('the importer is never taken from the body: a record with importedBy is refused as invalid, and nothing is stored', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const r = await imp(doctor, k.caseId, runRecord(k, x => { x.importedBy = 'mallory'; x.imported_by = 1; }));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'run_record_invalid');
  assert.ok(r.body.errors.some(e => /importedBy/.test(e.message)));
  assert.equal((await runs(k.caseId)).length, 0);
});

test('refused: not a run record, bad schema, missing or malformed envelope hash', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const cases = [
    ['array body', [1, 2], 'run_record_invalid'],
    ['empty body', {}, 'run_record_invalid'],
    ['bad engine range fixture', runRecord(k, null, 'run-record-bad-engine-range.json'), 'run_record_invalid'],
    ['no envelope hash', runRecord(k, x => { delete x['x-envelopeSha256']; }), 'envelope_hash_missing'],
    ['hash not hex', runRecord(k, x => { x['x-envelopeSha256'] = 'abc'; }), 'envelope_hash_missing'],
    ['hash not text', runRecord(k, x => { x['x-envelopeSha256'] = 12; }), 'envelope_hash_missing'],
  ];
  for (const [name, body, error] of cases) {
    const r = await imp(doctor, k.caseId, body);
    assert.equal(r.status, 422, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, error, name);
  }
  assert.equal((await runs(k.caseId)).length, 0);
});

test('refused unless it matches an export of THIS case: another case\'s export, a hash never exported, a failed record with no case', async () => {
  const a = await caseWithExport(doctor, env.pool), b = await caseWithExport(doctor, env.pool);
  // case B's record sent to case A: the case reference is not A's
  let r = await imp(doctor, a.caseId, runRecord(b));
  assert.equal(r.status, 422); assert.equal(r.body.error, 'record_not_for_case');
  // A's reference but B's export hash: that envelope was never exported from A
  r = await imp(doctor, a.caseId, runRecord({ ref: a.ref, sha: b.sha }));
  assert.equal(r.status, 422); assert.equal(r.body.error, 'envelope_not_exported');
  // a well-formed hash nobody exported
  r = await imp(doctor, a.caseId, runRecord({ ref: a.ref, sha: 'f'.repeat(64) }));
  assert.equal(r.status, 422); assert.equal(r.body.error, 'envelope_not_exported');
  // CCIS "failed" record whose envelope could not be read carries no case reference: cannot be tied to a case
  r = await imp(doctor, a.caseId, runRecord(a, x => { x.snapshot.case = { ref: 'unreadable-envelope-x' }; }, 'run-record-good-failed.json'));
  assert.equal(r.status, 422); assert.equal(r.body.error, 'record_not_for_case');
  assert.equal((await runs(a.caseId)).length, 0);
  assert.equal((await runs(b.caseId)).length, 0);
});

test('a failed record of this case (status failed, no results) imports and says so; the same record again is not stored twice', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const rec = runRecord(k, null, 'run-record-good-failed.json');
  const first = await imp(doctor, k.caseId, rec);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.run.status, 'failed');
  const again = await imp(admin, k.caseId, JSON.parse(JSON.stringify(rec)));
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyImported, true);
  assert.equal(again.body.run.id, first.body.run.id);
  assert.equal(again.body.run.imported_by, 'doctor1', 'the first importer stays on record');
  assert.equal((await runs(k.caseId)).length, 1);
  const audits = (await env.pool.query(`SELECT 1 FROM audit_log WHERE action = 'ccis.import' AND entity_id = $1`, [String(k.caseId)])).rows.length;
  assert.equal(audits, 1, 'only the real import is audited');
});

test('a newer export of the same case still works; a correction is a second record, the first stays', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const k2 = { ...k, ...(await exportEnvelope(doctor, env.pool, k.caseId)) };
  const r1 = await imp(doctor, k.caseId, runRecord(k));
  const r2 = await imp(doctor, k.caseId, runRecord(k2, x => { x.corrects = r1.body.run.record_id; }));
  assert.equal(r1.status, 201); assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.deepEqual((await runs(k.caseId)).map(x => x.id), [r2.body.run.id, r1.body.run.id], 'newest first, both kept');
});

test('demo-parameter placeholders are flagged in the API so the page can say they are test-only', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const plain = await imp(doctor, k.caseId, runRecord(k));
  const demo = await imp(doctor, k.caseId, runRecord(k, x => { x['x-demo'] = { placeholders: true }; }));
  assert.equal(plain.body.run.demo_placeholders, false);
  assert.equal(demo.body.run.demo_placeholders, true);
});

test('import and ack never change any clinical table (counts and content digests are identical)', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const before = await digest();
  const r = await imp(doctor, k.caseId, runRecord(k));
  assert.equal(r.status, 201);
  assert.equal((await doctor.post(`/api/ccis-runs/${r.body.run.id}/ack`, { note: 'seen' })).status, 201);
  assert.deepEqual(await digest(), before);
});

test('ack: recorded with the session user and time, optional note; once per person; two people can both acknowledge', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const run = (await imp(doctor, k.caseId, runRecord(k))).body.run;
  const a1 = await doctor.post(`/api/ccis-runs/${run.id}/ack`, { note: '  Seen on the ward round.  ' });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.ack.acknowledged_by, 'doctor1');
  assert.equal(a1.body.ack.note, 'Seen on the ward round.');
  assert.ok(Date.now() - new Date(a1.body.ack.acknowledged_at).getTime() < 60000);
  const dup = await doctor.post(`/api/ccis-runs/${run.id}/ack`, {});
  assert.equal(dup.status, 409); assert.equal(dup.body.error, 'already_acknowledged');
  const a2 = await admin.post(`/api/ccis-runs/${run.id}/ack`, {});
  assert.equal(a2.status, 201); assert.equal(a2.body.ack.note, null);
  const acks = (await runs(k.caseId))[0].acks;
  assert.deepEqual(acks.map(a => a.acknowledged_by), ['doctor1', 'admin1']);
});

test('ack input: unknown fields (a forged person), a long or non-text note, an unknown run, an archived case', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const run = (await imp(doctor, k.caseId, runRecord(k))).body.run;
  let r = await doctor.post(`/api/ccis-runs/${run.id}/ack`, { acknowledgedBy: 'mallory' });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field');
  r = await doctor.post(`/api/ccis-runs/${run.id}/ack`, { note: 'x'.repeat(501) });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_note');
  r = await doctor.post(`/api/ccis-runs/${run.id}/ack`, { note: 5 });
  assert.equal(r.status, 400);
  assert.equal((await doctor.post('/api/ccis-runs/999999/ack', {})).status, 404);
  assert.equal((await doctor.post('/api/ccis-runs/abc/ack', {})).status, 404);
  assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM ccis_run_acks WHERE run_id = $1', [run.id])).rows[0].n, 0, 'refused acks store nothing');
  // archived case: import and ack are both refused until it is restored
  const cs = (await doctor.get(`/api/cases/${k.caseId}`)).body.case;
  assert.equal((await doctor.patch(`/api/cases/${k.caseId}/archive`, { archived: true, rowVersion: cs.row_version })).status, 200);
  r = await doctor.post(`/api/ccis-runs/${run.id}/ack`, {});
  assert.equal(r.status, 409); assert.equal(r.body.error, 'case_archived');
  r = await imp(doctor, k.caseId, runRecord(k));
  assert.equal(r.status, 409); assert.equal(r.body.error, 'case_archived');
});

test('who can do what: nurse and viewer can read but not import or ack; unknown case is 404', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const run = (await imp(doctor, k.caseId, runRecord(k))).body.run;
  for (const c of [nurse, viewer]) {
    assert.equal((await c.get(`/api/cases/${k.caseId}/ccis-runs`)).body.runs.length, 1);
    assert.equal((await imp(c, k.caseId, runRecord(k))).status, 403);
    assert.equal((await c.post(`/api/ccis-runs/${run.id}/ack`, {})).status, 403);
  }
  assert.equal((await doctor.get('/api/cases/999999/ccis-runs')).status, 404);
  assert.equal((await imp(doctor, 999999, runRecord(k))).status, 404);
});

test('without CONTEXT_REF_SECRET the import refuses with 503 and stores nothing', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const rec = runRecord(k);
  const srv = createApp(env.appPool, { quiet: true, contextSecret: 'short' }).listen(0, '127.0.0.1');   // a second app on the same database, no secret set
  await new Promise(r => srv.once('listening', r));
  try {
    const d = client(`http://127.0.0.1:${srv.address().port}`); assert.equal((await d.login('doctor1')).status, 200);
    const r = await imp(d, k.caseId, rec);
    assert.equal(r.status, 503); assert.equal(r.body.error, 'context_not_configured');
    assert.equal((await runs(k.caseId)).length, 0);
  } finally { await new Promise(r => srv.close(r)); }
});

test('size: a record far above the 50 kb default imports; one over the route limit gets 413 and stores nothing', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const big = runRecord(k, x => { x['x-padding'] = 'p'.repeat(300 * 1024); });
  const r = await imp(doctor, k.caseId, big);
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  const huge = runRecord(k, x => { x['x-padding'] = 'p'.repeat(3 * 1024 * 1024); });
  const h = await imp(doctor, k.caseId, huge);
  assert.equal(h.status, 413); assert.equal(h.body.error, 'too_large');
  // every other write route keeps the small limit
  const small = await doctor.post('/api/patients', { name: 'x'.repeat(60 * 1024), mrn: 'BIG-1', dob: '1980-01-01', sex: 'F' });
  assert.equal(small.status, 413);
  assert.equal((await runs(k.caseId)).length, 1);
});

test('audit: import and ack leave rows with ids, counts and hashes only, never record values or the note text', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const rec = runRecord(k);
  const run = (await imp(doctor, k.caseId, rec)).body.run;
  await doctor.post(`/api/ccis-runs/${run.id}/ack`, { note: 'private note text' });
  const rows = (await env.pool.query(`SELECT * FROM audit_log WHERE action IN ('ccis.import','ccis.ack') AND (entity_id = $1 OR entity_id = $2) ORDER BY id`, [String(k.caseId), String(run.id)])).rows;
  assert.deepEqual(rows.map(r => r.action), ['ccis.import', 'ccis.ack']);
  assert.equal(rows[0].username, 'doctor1');
  assert.equal(rows[0].detail.envelopeSha256, k.sha);
  assert.equal(rows[0].detail.runRecordSha256, run.run_record_sha256);
  assert.equal(rows[0].detail.results, rec.results.length);
  assert.equal(rows[1].detail.hasNote, true);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('private note text') && !text.includes('synthetic-label') && !text.includes(k.ref), 'no note text, parameter value or case reference in the audit log');
});

test('database: records and acks are append-only for everyone; the app role has no UPDATE, DELETE or TRUNCATE; a row needs a real export', async () => {
  const k = await caseWithExport(doctor, env.pool);
  const run = (await imp(doctor, k.caseId, runRecord(k))).body.run;
  await doctor.post(`/api/ccis-runs/${run.id}/ack`, {});
  for (const sql of ['UPDATE ccis_runs SET envelope_sha256 = envelope_sha256', 'DELETE FROM ccis_runs', 'TRUNCATE ccis_runs CASCADE',
    'UPDATE ccis_run_acks SET note = $$x$$', 'DELETE FROM ccis_run_acks', 'TRUNCATE ccis_run_acks']) {
    await assert.rejects(env.pool.query(sql), /append-only/, sql);   // the owner connection too
  }
  for (const [t, p] of [['ccis_runs', 'UPDATE'], ['ccis_runs', 'DELETE'], ['ccis_runs', 'TRUNCATE'], ['ccis_run_acks', 'UPDATE'], ['ccis_run_acks', 'DELETE'], ['ccis_run_acks', 'TRUNCATE']]) {
    assert.equal((await env.pool.query(`SELECT has_table_privilege('emr_app', $1, $2) AS ok`, [t, p])).rows[0].ok, false, `emr_app must not have ${p} on ${t}`);
  }
  const uid = await userId('doctor1');
  await assert.rejects(env.pool.query(`INSERT INTO ccis_runs(case_id, run_record, run_record_sha256, envelope_sha256, imported_by) VALUES ($1, '{}'::jsonb, $2, $3, $4)`,
    [k.caseId, 'b'.repeat(64), 'c'.repeat(64), uid]), /never exported/);
  const other = await caseWithExport(doctor, env.pool);
  await assert.rejects(env.pool.query(`INSERT INTO ccis_runs(case_id, run_record, run_record_sha256, envelope_sha256, imported_by) VALUES ($1, '{}'::jsonb, $2, $3, $4)`,
    [k.caseId, 'd'.repeat(64), other.sha, uid]), /never exported/, 'another case\'s export does not count');
});
