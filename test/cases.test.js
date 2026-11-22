'use strict';
// Task B1a: persistent cases (server). Runs against real PostgreSQL; the app runs as the restricted emr_app role.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, nurse, doctor, viewer;
const uid = async name => (await env.pool.query('SELECT id FROM users WHERE username = $1', [name])).rows[0].id;
const audits = async action => (await env.pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;
let n = 0;
async function patient() {
  n++;
  const r = await nurse.post('/api/patients', { name: 'Case Patient ' + n, mrn: 'CS-' + n, dob: '1970-02-03', sex: 'F' });
  assert.equal(r.status, 201); return r.body.patient.id;
}
async function openEnc(pid, bed) { const r = await nurse.post(`/api/patients/${pid}/encounters`, { bed }); assert.equal(r.status, 201); return r.body.encounter.id; }
async function newCase(pid, title = 'Chest pain work-up') { const r = await nurse.post(`/api/patients/${pid}/cases`, { title }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.case; }

test.before(async () => {
  env = await setup();
  nurse = client(env.base); doctor = client(env.base); viewer = client(env.base);
  for (const [c, u] of [[nurse, 'nurse1'], [doctor, 'doctor1'], [viewer, 'viewer1']]) assert.equal((await c.login(u)).status, 200);
});
test.after(async () => { await env.close(); });

test('create: the case belongs to the patient, gets a CASE-nnnnnn key, starts active at row_version 1, created_by is the session user', async () => {
  const pid = await patient();
  const c = await newCase(pid, '  Chest   pain  ');
  assert.equal(c.patient_id, pid); assert.equal(c.title, 'Chest pain'); assert.equal(c.status, 'active'); assert.equal(c.row_version, 1);
  assert.match(c.case_key, /^CASE-\d{6}$/);
  assert.equal((await env.pool.query('SELECT created_by FROM clinical_cases WHERE id = $1', [c.id])).rows[0].created_by, await uid('nurse1'));
  assert.equal((await nurse.post(`/api/patients/${pid}/cases`, { title: '   ' })).status, 400);
  assert.equal((await nurse.post(`/api/patients/${pid}/cases`, { title: 'x'.repeat(201) })).status, 400);
});

test('a case cannot reference a missing patient (API says 404; the database foreign key refuses it too)', async () => {
  assert.equal((await nurse.post('/api/patients/99999/cases', { title: 'Ghost' })).status, 404);
  await assert.rejects(env.pool.query(`INSERT INTO clinical_cases(patient_id, title, created_by) VALUES (99999, 'x', 1)`), /foreign key/);
  assert.equal((await nurse.get('/api/cases/99999')).status, 404);
});

test('an archived patient cannot get a new case', async () => {
  const pid = await patient();
  assert.equal((await doctor.patch(`/api/patients/${pid}/archive`, { archived: true })).status, 200);
  const r = await nurse.post(`/api/patients/${pid}/cases`, { title: 'Late' });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'patient_archived');
});

test('one case links to two encounters; the open encounter is linked at creation; duplicates and other patients are refused', async () => {
  const pid = await patient();
  const e1 = await openEnc(pid, 'CB-1');
  assert.equal((await nurse.post(`/api/encounters/${e1}/close`)).status, 200);
  const e2 = await openEnc(pid, 'CB-2');
  const c = await newCase(pid);
  let r = await nurse.get(`/api/cases/${c.id}`);
  assert.deepEqual(r.body.encounters.map(x => [x.encounter_id, x.relation_type]), [[e2, 'opened']], 'open encounter linked automatically');
  r = await nurse.post(`/api/cases/${c.id}/encounters`, { encounterId: e1, relationType: 'reviewed' });
  assert.equal(r.status, 201);
  r = await nurse.get(`/api/cases/${c.id}`);
  assert.deepEqual(r.body.encounters.map(x => x.encounter_id).sort(), [e1, e2].sort());
  const dup = await nurse.post(`/api/cases/${c.id}/encounters`, { encounterId: e1 });
  assert.equal(dup.status, 409); assert.equal(dup.body.error, 'already_linked');
  // an encounter of another patient
  const other = await patient(); const eo = await openEnc(other, 'CB-OTHER');
  const wrong = await nurse.post(`/api/cases/${c.id}/encounters`, { encounterId: eo });
  assert.equal(wrong.status, 409); assert.equal(wrong.body.error, 'encounter_other_patient');
  assert.equal((await audits('case.link_rejected')).length, 1);
  // ... and the database refuses it even if the route were bypassed
  await assert.rejects(env.pool.query(`INSERT INTO case_encounters(case_id, encounter_id, patient_id, linked_by) VALUES ($1,$2,$3,1)`, [c.id, eo, pid]), /foreign key/);
  assert.equal((await nurse.post(`/api/cases/${c.id}/encounters`, { encounterId: 99999 })).status, 404);
  assert.equal((await nurse.post(`/api/cases/${c.id}/encounters`, { encounterId: 'abc' })).status, 400);
  assert.equal((await nurse.post(`/api/cases/${c.id}/encounters`, { encounterId: e1, relationType: 'bogus' })).status, 400);
});

test('stale row_version gives 409 and changes nothing; a matching one succeeds and bumps the version', async () => {
  const pid = await patient(); const c = await newCase(pid);
  const ok = await nurse.patch(`/api/cases/${c.id}`, { title: 'Renamed', rowVersion: 1 });
  assert.equal(ok.status, 200); assert.equal(ok.body.case.row_version, 2); assert.equal(ok.body.case.title, 'Renamed');
  const stale = await doctor.patch(`/api/cases/${c.id}`, { title: 'Doctor edit', rowVersion: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'version_conflict'); assert.equal(stale.body.currentRowVersion, 2);
  assert.equal((await nurse.get(`/api/cases/${c.id}`)).body.case.title, 'Renamed', 'the stale write changed nothing');
  assert.equal((await audits('case.update_rejected')).length >= 1, true);
  assert.equal((await nurse.patch(`/api/cases/${c.id}`, { title: 'No version' })).status, 400);
  assert.equal((await nurse.patch(`/api/cases/${c.id}`, { rowVersion: 2 })).status, 400, 'nothing to change');
  assert.equal((await nurse.patch(`/api/cases/${c.id}`, { status: 'archived', rowVersion: 2 })).status, 400, 'archived only through the archive route');
  assert.equal((await nurse.patch(`/api/cases/${c.id}`, { status: 'deleted', rowVersion: 2 })).status, 400);
});

test('status: closing sets closed_at, reopening clears it', async () => {
  const pid = await patient(); const c = await newCase(pid);
  let r = await nurse.patch(`/api/cases/${c.id}`, { status: 'resolved', rowVersion: 1 });
  assert.equal(r.body.case.status, 'resolved'); assert.equal(r.body.case.closed_at, null);
  r = await nurse.patch(`/api/cases/${c.id}`, { status: 'closed', rowVersion: 2 });
  assert.equal(r.body.case.status, 'closed'); assert.ok(r.body.case.closed_at);
  r = await nurse.patch(`/api/cases/${c.id}`, { status: 'active', rowVersion: 3 });
  assert.equal(r.body.case.status, 'active'); assert.equal(r.body.case.closed_at, null);
});

test('archive is not delete: the case stays readable, is hidden from the default list, and can be restored; an archived case is read-only', async () => {
  const pid = await patient(); const c = await newCase(pid, 'To archive');
  const a = await nurse.patch(`/api/cases/${c.id}/archive`, { archived: true, rowVersion: 1 });
  assert.equal(a.status, 200); assert.equal(a.body.case.status, 'archived'); assert.ok(a.body.case.archived_at);
  const row = (await env.pool.query('SELECT archived_by FROM clinical_cases WHERE id = $1', [c.id])).rows[0];
  assert.equal(row.archived_by, await uid('nurse1'));
  assert.equal((await nurse.get(`/api/patients/${pid}/cases`)).body.cases.length, 0);
  assert.equal((await nurse.get(`/api/patients/${pid}/cases?archived=1`)).body.cases.length, 1);
  assert.equal((await nurse.get(`/api/cases/${c.id}`)).status, 200);
  const e = await nurse.patch(`/api/cases/${c.id}`, { title: 'Edit', rowVersion: a.body.case.row_version });
  assert.equal(e.status, 409); assert.equal(e.body.error, 'case_archived');
  assert.equal((await nurse.post(`/api/cases/${c.id}/narrative`, { body: 'x' })).status, 409);
  const again = await nurse.patch(`/api/cases/${c.id}/archive`, { archived: true, rowVersion: a.body.case.row_version });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'already_archived');
  const back = await nurse.patch(`/api/cases/${c.id}/archive`, { archived: false, rowVersion: a.body.case.row_version });
  assert.equal(back.status, 200); assert.equal(back.body.case.status, 'active'); assert.equal(back.body.case.archived_at, null);
  assert.equal((await nurse.patch(`/api/cases/${c.id}/archive`, { archived: 'yes', rowVersion: 3 })).status, 400);
  assert.equal((await nurse.patch(`/api/cases/${c.id}/archive`, { archived: true, rowVersion: 1 })).status, 409, 'stale version');
});

test('forged actor fields are rejected (not ignored) on every case write, and nothing is written', async () => {
  const pid = await patient(); const c = await newCase(pid);
  const before = (await env.pool.query('SELECT count(*)::int n FROM clinical_cases')).rows[0].n;
  const forged = { createdBy: 1, created_by: 1, userId: 1, authorId: 1, linkedBy: 1, archivedBy: 1, signedBy: 'mallory', patientId: 1 };
  for (const [method, path, body] of [
    ['POST', `/api/patients/${pid}/cases`, { title: 'Forged' }], ['PATCH', `/api/cases/${c.id}`, { title: 'Forged', rowVersion: 1 }],
    ['PATCH', `/api/cases/${c.id}/archive`, { archived: true, rowVersion: 1 }], ['POST', `/api/cases/${c.id}/encounters`, { encounterId: 1 }],
    ['POST', `/api/cases/${c.id}/narrative`, { body: 'Forged' }],
  ]) {
    for (const k of Object.keys(forged)) {
      const r = await nurse.raw(method, path, { ...body, [k]: forged[k] });
      assert.equal(r.status, 400, `${method} ${path} with ${k}`); assert.equal(r.body.error, 'unknown_field');
    }
  }
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM clinical_cases')).rows[0].n, before);
  const cur = (await nurse.get(`/api/cases/${c.id}`)).body;
  assert.equal(cur.case.row_version, 1); assert.equal(cur.case.status, 'active'); assert.equal(cur.narrative, null);
});

test('narrative is append-only, author comes from the session, the latest entry is current, and its text never enters the audit log', async () => {
  const pid = await patient(); const c = await newCase(pid);
  assert.equal((await nurse.post(`/api/cases/${c.id}/narrative`, { body: 'First SECRET-TEXT-ONE' })).status, 201);
  const second = await doctor.post(`/api/cases/${c.id}/narrative`, { body: 'Second entry' });
  assert.equal(second.status, 201); assert.equal(second.body.narrative.author, 'doctor1');
  const cur = (await viewer.get(`/api/cases/${c.id}`)).body;
  assert.equal(cur.narrative.body, 'Second entry'); assert.equal(cur.narrative.author, 'doctor1');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM case_narrative_entries WHERE case_id = $1', [c.id])).rows[0].n, 2, 'the first entry is kept');
  assert.equal((await nurse.post(`/api/cases/${c.id}/narrative`, { body: '   ' })).status, 400);
  assert.equal((await nurse.post(`/api/cases/${c.id}/narrative`, { body: 'x'.repeat(20001) })).status, 400);
  assert.equal((await nurse.post(`/api/cases/${c.id}/narrative`, { body: 123 })).status, 400);
  await assert.rejects(env.pool.query(`UPDATE case_narrative_entries SET body = 'edited' WHERE case_id = $1`, [c.id]), /append-only/);
  await assert.rejects(env.pool.query(`DELETE FROM case_narrative_entries WHERE case_id = $1`, [c.id]), /append-only/);
  const log = JSON.stringify((await env.pool.query('SELECT detail FROM audit_log')).rows);
  assert.ok(!log.includes('SECRET-TEXT-ONE') && !log.includes('Second entry'));
});

test('viewers can read cases but cannot write; nothing is written on a refusal', async () => {
  const pid = await patient(); const c = await newCase(pid);
  assert.equal((await viewer.get(`/api/cases/${c.id}`)).status, 200);
  assert.equal((await viewer.get(`/api/patients/${pid}/cases`)).status, 200);
  const r = await viewer.post(`/api/patients/${pid}/cases`, { title: 'Nope' });
  assert.equal(r.status, 403); assert.equal(r.body.perm, 'cases:write');
  assert.equal((await viewer.patch(`/api/cases/${c.id}`, { title: 'Nope', rowVersion: 1 })).status, 403);
  assert.equal((await nurse.get(`/api/patients/${pid}/cases`)).body.cases.length, 1);
});

test('every write and read leaves an audit row made from the session', async () => {
  const pid = await patient(); const c = await newCase(pid, 'Audited');
  await nurse.get(`/api/cases/${c.id}`); await nurse.get(`/api/patients/${pid}/cases`);
  for (const action of ['case.create', 'case.view', 'case.list']) {
    const rows = (await audits(action)).filter(x => String(x.entity_id) === String(action === 'case.list' ? pid : c.id));
    assert.ok(rows.length >= 1, action); assert.equal(rows.at(-1).username, 'nurse1'); assert.equal(rows.at(-1).role, 'nurse');
  }
});

test('the app role cannot delete, truncate, or rewrite who/what a case belongs to; the owner cannot delete or truncate either', async () => {
  const pid = await patient(); const c = await newCase(pid);
  const denied = /permission denied|must be owner/;
  for (const q of ['DELETE FROM clinical_cases', 'DELETE FROM case_encounters', 'DELETE FROM case_narrative_entries',
    'TRUNCATE clinical_cases', 'TRUNCATE case_encounters', 'TRUNCATE case_narrative_entries', 'DROP TABLE clinical_cases',
    `UPDATE clinical_cases SET created_by = 1`, `UPDATE clinical_cases SET patient_id = 1`, `UPDATE clinical_cases SET created_at = now()`,
    `UPDATE case_encounters SET relation_type = 'related'`, `UPDATE case_narrative_entries SET body = 'x'`]) {
    await assert.rejects(env.appPool.query(q), denied, q);
  }
  await assert.rejects(env.pool.query('DELETE FROM clinical_cases WHERE id = $1', [c.id]), /append-only/);
  await assert.rejects(env.pool.query('TRUNCATE clinical_cases'), /append-only|cannot truncate a table referenced/);   // Postgres refuses a referenced table before the trigger runs
  await assert.rejects(env.pool.query('TRUNCATE clinical_cases CASCADE'), /append-only/);
  await assert.rejects(env.pool.query('TRUNCATE case_encounters'), /append-only/);
  await assert.rejects(env.pool.query('TRUNCATE case_narrative_entries'), /append-only/);
  await assert.rejects(env.pool.query('TRUNCATE patients CASCADE'), /append-only/);
  for (const t of ['clinical_cases', 'case_encounters', 'case_narrative_entries']) {
    for (const priv of ['DELETE', 'TRUNCATE']) assert.equal((await env.pool.query(`SELECT has_table_privilege('emr_app', $1, $2) ok`, [t, priv])).rows[0].ok, false, `${priv} on ${t}`);
  }
});
