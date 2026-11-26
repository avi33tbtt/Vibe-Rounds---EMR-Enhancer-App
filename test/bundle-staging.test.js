'use strict';
// Task R6f-2a: bundle staging on the server (stage, list, read, reject). Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const count = async t => Number((await env.pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);
const CLINICAL_TABLES = ['patients', 'observations', 'patient_problems', 'patient_allergies', 'patient_medications', 'medication_orders', 'clinical_cases'];
const NAME = 'Zorro Quincy Secretname', IDV = 'SECRET-ID-' + 7781, NOTE = 'Secret note text about the patient';

// A small collection bundle. `tag` makes each bundle different (the same bundle can be staged once).
function bundle(tag = 'a' + (++seq), extra = []) {
  return {
    resourceType: 'Bundle', type: 'collection',
    entry: [
      { fullUrl: 'urn:uuid:p1', resource: { resourceType: 'Patient', identifier: [{ system: 'urn:x', value: IDV }], name: [{ family: NAME }] } },
      { fullUrl: 'urn:uuid:o1', resource: { resourceType: 'Observation', status: 'final', code: { text: 'Heart rate ' + tag, coding: [{ system: 'http://x', code: '1' }] }, valueQuantity: { value: 88, unit: '/min' }, effectiveDateTime: '2026-11-20T09:30:00+05:45', note: [{ text: NOTE }] } },
      { fullUrl: 'urn:uuid:o2', resource: { resourceType: 'Observation', status: 'final', code: { text: 'Temp ' + tag }, valueQuantity: { value: 38.2, unit: 'C' }, effectiveDateTime: '2026-11-20' } },
      { fullUrl: 'urn:uuid:c1', resource: { resourceType: 'Condition', code: { text: 'Pneumonia ' + tag }, clinicalStatus: { coding: [{ code: 'active' }] } } },
      { fullUrl: 'urn:uuid:a1', resource: { resourceType: 'AllergyIntolerance', code: { text: 'Penicillin ' + tag }, clinicalStatus: { coding: [{ code: 'active' }] } } },
      { fullUrl: 'urn:uuid:m1', resource: { resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: 'Amoxicillin ' + tag }, dosageInstruction: [{ text: 'as typed ' + tag }] } },
      ...extra,
    ],
  };
}
const stage = (c, b) => c.post('/api/import/bundles', b);
const get = async (c, id) => (await c.get('/api/import/bundles/' + id)).body.bundle;

test('stage: doctor and admin can; nurse, viewer and informatician cannot; the stager is the signed-in user; proposals show ready and blocked', async () => {
  const d = await as('doctor1');
  for (const u of ['nurse1', 'viewer1', 'informatician1']) { const r = await stage(await as(u), bundle()); assert.equal(r.status, 403, u); assert.equal(r.body.perm, 'import:write'); }
  assert.equal(await count('import_bundles'), 0, 'a refused caller stages nothing');
  const r = await stage(d, bundle('one'));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.bundle;
  assert.deepEqual([b.staged_by, b.bundle_type, b.summary.proposals, b.summary.ready, b.summary.blocked, b.summary.patients, b.summary.notesDropped, b.summary.codingsDropped], ['doctor1', 'collection', 5, 3, 2, 1, 1, 1]);
  const by = Object.fromEntries(b.proposals.map(p => [p.kind + (p.ready ? '+' : '-'), p]));
  assert.ok(by['Observation+'] && by['Observation-'] && by['Condition+'] && by['AllergyIntolerance+'] && by['MedicationRequest-']);
  assert.deepEqual([by['Observation+'].status, by['Observation+'].row_version, by['Observation+'].starts_as], ['staged', 1, 'preliminary']);
  assert.ok(by['Observation-'].blockers.length >= 1, 'a date-only effective time blocks');
  assert.ok(by['MedicationRequest-'].blockers.some(x => /never creates an order/.test(x)), 'a MedicationRequest is always blocked');
  assert.equal((await stage(await as('admin1'), bundle('two'))).status, 201);
});

test('stage: only proposal fields are stored; no names, identifiers, notes or raw bundle; no clinical record is created', async () => {
  const d = await as('doctor1');
  const before = Object.fromEntries(await Promise.all(CLINICAL_TABLES.map(async t => [t, await count(t)])));
  assert.equal((await stage(d, bundle('store'))).status, 201);
  const dump = JSON.stringify((await env.pool.query('SELECT * FROM import_bundles')).rows) + JSON.stringify((await env.pool.query('SELECT * FROM import_proposals')).rows);
  for (const secret of [NAME, IDV, NOTE, 'urn:uuid', 'resourceType']) assert.ok(!dump.includes(secret), 'not stored: ' + secret);
  for (const t of CLINICAL_TABLES) assert.equal(await count(t), before[t], t + ' unchanged');
  const cols = (await env.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'import_proposals'`)).rows.map(r => r.column_name);
  assert.ok(!cols.includes('patient_id'), 'a proposal has no patient until a person accepts it into a chart');
});

test('stage: bad bundles are refused, nothing is stored, and the refusal is audited without content', async () => {
  const d = await as('doctor1'), n0 = await count('import_bundles');
  const entry = i => ({ resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' + i }, valueInteger: i, effectiveDateTime: '2026-11-20T09:30:00Z' } });
  const cases = [
    ['not a bundle', { resourceType: 'Patient' }], ['a search set', { resourceType: 'Bundle', type: 'searchset', entry: [entry(1)] }],
    ['no entries', { resourceType: 'Bundle', type: 'collection', entry: [] }], ['a list', []], ['an empty object', {}],
    ['501 entries', { resourceType: 'Bundle', type: 'collection', entry: Array.from({ length: 501 }, (_, i) => entry(i)) }],
  ];
  for (const [why, body] of cases) { const r = await stage(d, body); assert.equal(r.status, 400, why); assert.equal(r.body.error, 'invalid_bundle', why); }
  const big = await stage(d, { resourceType: 'Bundle', type: 'collection', entry: [entry(1)], pad: 'x'.repeat(2.2 * 1024 * 1024) });
  assert.equal(big.status, 413, 'over 2 MB is refused');
  assert.equal(await count('import_bundles'), n0);
  const refused = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'import.refused'`)).rows;
  assert.ok(refused.length >= cases.length);
  for (const r of refused) assert.deepEqual(Object.keys(r.detail), ['reason']);
});

test('stage: a bundle larger than the 50 kb default but within 2 MB is accepted; entries that cannot be read are listed, not stored as proposals', async () => {
  const d = await as('doctor1');
  const many = Array.from({ length: 300 }, (_, i) => ({ resource: { resourceType: 'Observation', status: 'final', code: { text: 'Big sample ' + i + ' ' + 'y'.repeat(150) }, valueInteger: i, effectiveDateTime: '2026-11-20T09:30:00Z' } }));
  const r = await stage(d, { resourceType: 'Bundle', type: 'collection', entry: [...many, { resource: { resourceType: 'Procedure' } }] });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
  assert.deepEqual([r.body.bundle.summary.proposals, r.body.bundle.summary.rejected, r.body.bundle.rejected.length], [300, 1, 1]);
  assert.equal(r.body.bundle.proposals.length, 300);
});

test('stage: the same bundle is staged once; the second try gives 409 and the first id', async () => {
  const d = await as('doctor1'), b = bundle('dup');
  const first = await stage(d, b); assert.equal(first.status, 201);
  const n = await count('import_bundles'), np = await count('import_proposals');
  const again = await stage(await as('admin1'), JSON.parse(JSON.stringify(b)));
  assert.equal(again.status, 409); assert.equal(again.body.error, 'already_staged'); assert.equal(again.body.bundleId, first.body.bundle.id);
  assert.equal(await count('import_bundles'), n); assert.equal(await count('import_proposals'), np);
});

test('list and read: only import:write, newest first with counts; unknown ids are 404', async () => {
  const d = await as('doctor1'), v = await as('viewer1');
  const r = await stage(d, bundle('list')); const id = r.body.bundle.id;
  assert.equal((await v.get('/api/import/bundles')).status, 403); assert.equal((await v.get('/api/import/bundles/' + id)).status, 403);
  const l = (await d.get('/api/import/bundles')).body.bundles;
  assert.equal(l[0].id, id, 'newest first');
  assert.deepEqual([l[0].staged_count, l[0].rejected_count, l[0].accepted_count], [5, 0, 0]);
  assert.equal(l[0].proposals, undefined, 'the list carries counts, not proposals');
  const one = (await d.get('/api/import/bundles/' + id)).body.bundle;
  assert.equal(one.proposals.length, 5); assert.equal(one.bundle_hash, r.body.bundle.bundle_hash);
  for (const bad of ['/api/import/bundles/999999', '/api/import/bundles/abc', '/api/import/bundles/0']) assert.equal((await d.get(bad)).status, 404, bad);
});

test('reject: needs a reason and the loaded row_version; unknown fields refused; the rejecter is the session user; rejected is final; stale gives 409', async () => {
  const d = await as('doctor1'), a = await as('admin1');
  const b = (await stage(d, bundle('rej'))).body.bundle, p = b.proposals.find(x => x.kind === 'Condition');
  const url = `/api/import/proposals/${p.id}/reject`;
  assert.equal((await a.post(url, { rowVersion: 1 })).status, 400, 'a reason is required');
  assert.equal((await a.post(url, { reason: '   ', rowVersion: 1 })).status, 400);
  assert.equal((await a.post(url, { reason: 'Wrong patient' })).status, 400, 'rowVersion is required');
  for (const extra of [{ rejectedBy: 'mallory' }, { status: 'accepted' }, { patientId: 1 }]) { const r = await a.post(url, { reason: 'x', rowVersion: 1, ...extra }); assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field'); }
  assert.equal((await (await as('nurse1')).post(url, { reason: 'x', rowVersion: 1 })).status, 403);
  const stale = await a.post(url, { reason: 'Wrong patient', rowVersion: 5 }); assert.equal(stale.status, 409); assert.equal(stale.body.error, 'version_conflict'); assert.equal(stale.body.currentRowVersion, 1);
  const ok = await a.post(url, { reason: '  Wrong patient  ', rowVersion: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.proposal.status, ok.body.proposal.row_version, ok.body.proposal.rejected_by, ok.body.proposal.reject_reason], ['rejected', 2, 'admin1', 'Wrong patient']);
  const again = await a.post(url, { reason: 'Again', rowVersion: 2 }); assert.equal(again.status, 409); assert.equal(again.body.error, 'proposal_final');
  assert.equal((await a.post('/api/import/proposals/999999/reject', { reason: 'x', rowVersion: 1 })).status, 404);
  const l = (await d.get('/api/import/bundles')).body.bundles.find(x => x.id === b.id);
  assert.deepEqual([l.staged_count, l.rejected_count], [4, 1]);
  assert.equal((await get(d, b.id)).proposals.find(x => x.id === p.id).status, 'rejected');
  assert.equal(await count('observations'), 0, 'rejecting creates nothing');
});

test('audit: counts, ids and a hash only; never labels, values, reasons, names or identifiers', async () => {
  const d = await as('doctor1');
  const b = (await stage(d, bundle('aud'))).body.bundle;
  await d.post(`/api/import/proposals/${b.proposals[0].id}/reject`, { reason: 'Secret rejection reason', rowVersion: 1 });
  await d.get('/api/import/bundles'); await d.get('/api/import/bundles/' + b.id);
  const rows = (await env.pool.query(`SELECT * FROM audit_log WHERE action LIKE 'import.%' ORDER BY id`)).rows;
  const acts = rows.map(r => r.action);
  for (const a of ['import.stage', 'import.proposal_reject', 'import.bundles_view', 'import.bundle_view']) assert.ok(acts.includes(a), a);
  const all = JSON.stringify(rows);
  for (const secret of ['Heart rate', 'Pneumonia', 'Penicillin', 'Amoxicillin', 'Secret rejection reason', NAME, IDV, NOTE]) assert.ok(!all.includes(secret), 'not in audit: ' + secret);
  const st = rows.find(r => r.action === 'import.stage' && r.entity_id === String(b.id));
  assert.equal(st.username, 'doctor1'); assert.match(st.detail.hash, /^[0-9a-f]{64}$/); assert.equal(st.detail.proposals, 5);
  const rj = rows.find(r => r.action === 'import.proposal_reject');
  assert.deepEqual(Object.keys(rj.detail).sort(), ['kind', 'length', 'proposalId', 'rowVersion']);
});

test('database guards: a blocked proposal and a MedicationRequest can never be accepted, staged content cannot change, nothing is deleted, the app role cannot edit content', async () => {
  const d = await as('doctor1');
  const b = (await stage(d, bundle('db'))).body.bundle;
  const pick = (kind, ready) => b.proposals.find(p => p.kind === kind && p.ready === ready).id;
  const accept = (id, extra = '') => env.pool.query(`UPDATE import_proposals SET status = 'accepted', row_version = row_version + 1, accepted_by = (SELECT id FROM users WHERE username = 'doctor1'), accepted_at = now(),
    accepted_patient_id = (SELECT id FROM patients LIMIT 1), accepted_record_type = 'observation', accepted_record_id = 1 ${extra} WHERE id = $1`, [id]);
  const pid = (await (await as('nurse1')).post('/api/patients', { name: 'Guard Patient', mrn: 'GUARD-1', dob: '1970-01-01', sex: 'F' })).body.patient.id;
  assert.ok(pid);
  await assert.rejects(accept(pick('Observation', false)), /violates check constraint/, 'blocked');
  await assert.rejects(accept(pick('MedicationRequest', false)), /violates check constraint/, 'MedicationRequest');
  await assert.rejects(env.pool.query(`UPDATE import_proposals SET fields = '{}'::jsonb WHERE id = $1`, [pick('Condition', true)]), /what was staged cannot be changed/);
  await assert.rejects(env.pool.query(`UPDATE import_proposals SET blockers = '[]'::jsonb, ready = true WHERE id = $1`, [pick('MedicationRequest', false)]), /what was staged cannot be changed/);
  await assert.rejects(env.pool.query(`INSERT INTO import_proposals(bundle_id, key, kind, entry_index, fields, blockers, ready) VALUES ($1, 'MedicationRequest#99', 'MedicationRequest', 99, '{}', '[]', true)`, [b.id]), /violates check constraint/);
  await assert.rejects(env.pool.query(`INSERT INTO import_proposals(bundle_id, key, kind, entry_index, fields, blockers, ready, status) VALUES ($1, 'Observation#98', 'Observation', 98, '{}', '[]', true, 'rejected')`, [b.id]), /starts as staged|violates check constraint/);
  await assert.rejects(env.pool.query('UPDATE import_bundles SET bundle_type = $1', ['transaction']), /append-only/);
  for (const q of ['DELETE FROM import_bundles', 'DELETE FROM import_proposals', 'TRUNCATE import_proposals']) await assert.rejects(env.pool.query(q), /not allowed|cannot truncate a table referenced/, q);
  await assert.rejects(env.appPool.query(`UPDATE import_proposals SET fields = '{}'::jsonb`), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM import_proposals'), /permission denied/);
  // the database does allow a ready, non-order proposal to be accepted by a later step (proof that the rules above are the only barrier); rolled back
  const c = await env.pool.connect();
  try { await c.query('BEGIN'); const r = await c.query(`UPDATE import_proposals SET status = 'accepted', row_version = row_version + 1, accepted_by = (SELECT id FROM users WHERE username = 'doctor1'), accepted_at = now(), accepted_patient_id = $2, accepted_record_type = 'problem', accepted_record_id = 1 WHERE id = $1`, [pick('Condition', true), pid]); assert.equal(r.rowCount, 1); await assert.rejects(c.query(`UPDATE import_proposals SET status = 'rejected', row_version = row_version + 1 WHERE id = $1`, [pick('Condition', true)]), /is final/); }
  finally { await c.query('ROLLBACK'); c.release(); }
});

test('patient isolation: a Patient entry that matches a registered patient is not matched, linked or changed; no chart is chosen at staging', async () => {
  const n = await as('nurse1'), d = await as('doctor1');
  const pid = (await n.post('/api/patients', { name: 'Match Me', mrn: 'MATCH-1', dob: '1980-01-01', sex: 'M' })).body.patient.id;
  const before = (await env.pool.query('SELECT * FROM patients WHERE id = $1', [pid])).rows[0];
  const b = bundle('iso'); b.entry[0].resource.identifier = [{ system: 'urn:mrn', value: 'MATCH-1' }]; b.entry[0].resource.name = [{ family: 'Match Me' }];
  const r = await stage(d, b); assert.equal(r.status, 201);
  assert.deepEqual((await env.pool.query('SELECT * FROM patients WHERE id = $1', [pid])).rows[0], before);
  assert.equal(Number((await env.pool.query('SELECT count(*) n FROM import_proposals WHERE accepted_patient_id IS NOT NULL')).rows[0].n), 0);
  assert.ok(!JSON.stringify(r.body).includes('MATCH-1'), 'the identifier is not even returned');
  for (const t of ['patient_problems', 'patient_allergies', 'patient_medications', 'medication_orders', 'observations']) assert.equal((await env.pool.query(`SELECT count(*) n FROM ${t} WHERE patient_id = $1`.replace('observations WHERE patient_id', 'observations WHERE case_id'), [pid])).rows[0].n, '0', t);
});
