'use strict';
// Task R3a-1: the patient problem list on the server (list, get, add). Matrix and audit scenarios are in safety-routes.test.js;
// the "never deleted" classification is in safety-data.test.js. Resolve and entered-in-error (R3a-2) are at the end of this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Problem Patient ' + (++seq), mrn: 'PRB-' + seq, dob: '1975-05-05', sex: 'M' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const newCase = async (c, pid) => { const k = await c.post(`/api/patients/${pid}/cases`, { title: 'Problem case' }); assert.equal(k.status, 201); return k.body.case.id; };
const add = async (c, pid, body) => c.post(`/api/patients/${pid}/problems`, body);

test('add: nurse and doctor can; the recorder is the signed-in user; the first event is kept', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n);
  const a = await add(n, pid, { label: 'Type 2 diabetes', onsetDate: '2019-03-01' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.problem.recorded_by, 'nurse1'); assert.equal(a.body.problem.status, 'active');
  assert.equal(a.body.problem.onset_date, '2019-03-01'); assert.equal(a.body.problem.row_version, 1); assert.equal(a.body.problem.origin_case_id, null);
  const b = await add(d, pid, { label: 'Hypertension' });
  assert.equal(b.status, 201); assert.equal(b.body.problem.recorded_by, 'doctor1'); assert.equal(b.body.problem.onset_date, null);
  const g = await n.get(`/api/problems/${a.body.problem.id}`);
  assert.equal(g.status, 200); assert.equal(g.body.problem.events.length, 1);
  assert.deepEqual([g.body.problem.events[0].seq, g.body.problem.events[0].from_status, g.body.problem.events[0].to_status, g.body.problem.events[0].by_user], [1, null, 'active', 'nurse1']);
});

test('add: a viewer is refused; a body that names a recorder or status is refused and nothing is saved', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(n);
  assert.equal((await add(v, pid, { label: 'x' })).status, 403);
  for (const extra of [{ recordedBy: 2 }, { recorded_by: 'doctor1' }, { status: 'resolved' }, { resolvedBy: 1 }]) {
    const r = await add(n, pid, { label: 'x', ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.error, 'unknown_field');
  }
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_problems WHERE patient_id = $1', [pid])).rows[0].n, 0);
});

test('add: bad labels, dates and ids are refused; an unknown patient is 404; an archived patient is 409', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n);
  for (const label of ['', '   ', 5, null, 'x'.repeat(201), 'a\u0000b']) assert.equal((await add(n, pid, { label })).status, 400, String(label).slice(0, 10));
  assert.equal((await add(n, pid, {})).status, 400);
  for (const onsetDate of ['2019-02-30', '2019-3-1', 'yesterday', 20190301, '1850-01-01', '2999-01-01']) assert.equal((await add(n, pid, { label: 'x', onsetDate })).status, 400, String(onsetDate));
  for (const originCaseId of ['1', 0, -1, 1.5]) assert.equal((await add(n, pid, { label: 'x', originCaseId })).status, 400, String(originCaseId));
  assert.equal((await add(n, 999999, { label: 'x' })).status, 404);
  assert.equal((await d.raw('PATCH', `/api/patients/${pid}/archive`, { archived: true })).status, 200);
  assert.equal((await add(n, pid, { label: 'x' })).body.error, 'patient_archived');
});

test('origin case: must be a case of the SAME patient (checked in the route and by the database)', async () => {
  const n = await as('nurse1'), p1 = await newPatient(n), p2 = await newPatient(n), k1 = await newCase(n, p1), k2 = await newCase(n, p2);
  const ok = await add(n, p1, { label: 'From a case', originCaseId: k1 });
  assert.equal(ok.status, 201); assert.equal(ok.body.problem.origin_case_id, k1);
  const other = await add(n, p1, { label: 'Wrong case', originCaseId: k2 });
  assert.equal(other.status, 400); assert.equal(other.body.error, 'case_not_of_patient');
  assert.equal((await add(n, p1, { label: 'No such case', originCaseId: 999999 })).status, 400);
  await assert.rejects(env.pool.query('INSERT INTO patient_problems(patient_id, origin_case_id, label, recorded_by) VALUES ($1,$2,$3,1)', [p1, k2, 'direct']), /foreign key/);
});

test('list: one list across cases; everyone who can read sees it; entered-in-error is hidden unless include=all; an unknown patient is 404', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), i = await as('informatician1'), pid = await newPatient(n), other = await newPatient(n), k = await newCase(n, pid);
  await add(n, pid, { label: 'One' }); await add(n, pid, { label: 'Two', originCaseId: k }); await add(n, other, { label: 'Not this patient' });
  const r = await v.get(`/api/patients/${pid}/problems`);
  assert.equal(r.status, 200); assert.deepEqual(r.body.problems.map(p => p.label), ['One', 'Two']);
  assert.equal((await i.get(`/api/patients/${pid}/problems`)).status, 403, 'informatician has no clinical read');
  const bad = r.body.problems[0].id;
  await env.pool.query(`UPDATE patient_problems SET status='entered_in_error', row_version=2, error_by=1, error_at=now(), error_reason='test' WHERE id=$1`, [bad]);
  assert.deepEqual((await v.get(`/api/patients/${pid}/problems`)).body.problems.map(p => p.label), ['Two']);
  assert.deepEqual((await v.get(`/api/patients/${pid}/problems?include=all`)).body.problems.map(p => p.label), ['One', 'Two']);
  assert.equal((await v.get('/api/patients/999999/problems')).status, 404);
  assert.equal((await v.get('/api/problems/999999')).status, 404);
});

test('audit: ids and the label length are logged, never the label text', async () => {
  const n = await as('nurse1'), pid = await newPatient(n);
  const a = await add(n, pid, { label: 'Secret problem wording' });
  await n.get(`/api/patients/${pid}/problems`); await n.get(`/api/problems/${a.body.problem.id}`);
  const rows = (await env.pool.query(`SELECT action, detail, username FROM audit_log WHERE action IN ('problem.add','patient.problems_view','problem.view') AND entity_id = $1`, [String(pid)])).rows;
  assert.deepEqual(rows.map(r => r.action).sort(), ['patient.problems_view', 'problem.add', 'problem.view']);
  assert.ok(rows.every(r => r.username === 'nurse1'));
  assert.ok(!JSON.stringify(rows).includes('Secret problem'));
  assert.equal(rows.find(r => r.action === 'problem.add').detail.length, 22);
});

test('database: no delete or truncate (even as the owner); label cannot change; the history table is append-only; emr_app has no DELETE', async () => {
  const n = await as('nurse1'), pid = await newPatient(n), a = (await add(n, pid, { label: 'Fixed label' })).body.problem;
  await assert.rejects(env.pool.query('DELETE FROM patient_problems WHERE id = $1', [a.id]), /append-only/);
  await assert.rejects(env.pool.query('TRUNCATE patient_problems CASCADE'), /append-only|not allowed/);
  await assert.rejects(env.pool.query('DELETE FROM patient_problem_events WHERE problem_id = $1', [a.id]), /append-only/);
  await assert.rejects(env.pool.query(`UPDATE patient_problem_events SET reason = 'x' WHERE problem_id = $1`, [a.id]), /append-only/);
  await assert.rejects(env.pool.query(`UPDATE patient_problems SET label = 'Changed' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.appPool.query(`UPDATE patient_problems SET label = 'Changed' WHERE id = $1`, [a.id]), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM patient_problems WHERE id = $1', [a.id]), /permission denied/);
  await assert.rejects(env.appPool.query('TRUNCATE patient_problems'), /permission denied/);
  await assert.rejects(env.pool.query(`INSERT INTO patient_problems(patient_id, label, recorded_by, status) VALUES ($1,'x',1,'resolved')`, [pid]), /starts as active|check/);
  await assert.rejects(env.pool.query(`UPDATE patient_problems SET status='resolved' WHERE id=$1`, [a.id]), /check|row_version/);
});

/* ---------- R3a-2: resolve and entered in error ---------- */
const mk = async (c, pid, label = 'Move me') => (await add(c, pid, { label })).body.problem;
const resolve = (c, id, body) => c.post(`/api/problems/${id}/resolve`, body);
const wrong = (c, id, body) => c.post(`/api/problems/${id}/entered-in-error`, body);

test('resolve: nurse and doctor can; the resolver is the session user; history, version and audit are kept; the label is untouched', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n);
  const a = await mk(n, pid, 'Keep this label'), b = await mk(n, pid, 'Second');
  const r = await resolve(d, a.id, { reason: 'Treated and settled', rowVersion: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.problem;
  assert.deepEqual([p.status, p.row_version, p.resolved_by, p.resolution_reason, p.label, p.recorded_by], ['resolved', 2, 'doctor1', 'Treated and settled', 'Keep this label', 'nurse1']);
  assert.ok(p.resolved_at); assert.equal(p.error_by, null);
  assert.deepEqual(p.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'nurse1'], [2, 'active', 'resolved', 'doctor1']]);
  assert.equal((await resolve(n, b.id, { reason: 'ok', rowVersion: 1 })).body.problem.resolved_by, 'nurse1');
  assert.equal((await n.get(`/api/problems/${a.id}`)).body.problem.events.length, 2);
  assert.deepEqual((await n.get(`/api/patients/${pid}/problems`)).body.problems.map(x => x.status), ['resolved', 'resolved']);
});

test('entered in error: from active or from resolved; the earlier resolution stays; hidden from the default list; final', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(n);
  const a = await mk(n, pid, 'A'), b = await mk(n, pid, 'B'), keep = await mk(n, pid, 'C');
  const ea = await wrong(n, a.id, { reason: 'Wrong patient', rowVersion: 1 });
  assert.equal(ea.status, 200, JSON.stringify(ea.body));
  assert.deepEqual([ea.body.problem.status, ea.body.problem.error_by, ea.body.problem.error_reason, ea.body.problem.row_version], ['entered_in_error', 'nurse1', 'Wrong patient', 2]);
  await resolve(n, b.id, { reason: 'Settled', rowVersion: 1 });
  const eb = await wrong(n, b.id, { reason: 'Never had it', rowVersion: 2 });
  assert.equal(eb.status, 200, JSON.stringify(eb.body));
  assert.deepEqual([eb.body.problem.resolved_by, eb.body.problem.resolution_reason, eb.body.problem.error_reason], ['nurse1', 'Settled', 'Never had it']);
  assert.deepEqual(eb.body.problem.events.map(e => [e.seq, e.from_status, e.to_status]), [[1, null, 'active'], [2, 'active', 'resolved'], [3, 'resolved', 'entered_in_error']]);
  assert.deepEqual((await v.get(`/api/patients/${pid}/problems`)).body.problems.map(x => x.label), ['C']);
  assert.equal((await v.get(`/api/patients/${pid}/problems?include=all`)).body.problems.length, 3);
  for (const f of [resolve, wrong]) { const r = await f(n, a.id, { reason: 'again', rowVersion: 2 }); assert.equal(r.status, 409); assert.equal(r.body.error, 'problem_final'); }
  assert.equal((await n.get(`/api/problems/${keep.id}`)).body.problem.status, 'active');
});

test('refused: viewer, unknown ids, missing or bad reason, missing or bad rowVersion, a body that names a user or status; nothing changes', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(n), a = await mk(n, pid);
  for (const f of [resolve, wrong]) {
    assert.equal((await f(v, a.id, { reason: 'x', rowVersion: 1 })).status, 403);
    assert.equal((await f(n, 999999, { reason: 'x', rowVersion: 1 })).status, 404);
    assert.equal((await f(n, 'abc', { reason: 'x', rowVersion: 1 })).status, 404);
    for (const reason of [undefined, '', '   ', 5, null, 'x'.repeat(1001), 'a\u0000b']) assert.equal((await f(n, a.id, { reason, rowVersion: 1 })).status, 400, String(reason).slice(0, 8));
    for (const rowVersion of [undefined, '1', 0, -1, 1.5, null]) assert.equal((await f(n, a.id, { reason: 'x', rowVersion })).status, 400, String(rowVersion));
    for (const extra of [{ resolvedBy: 2 }, { resolved_by: 'doctor1' }, { status: 'active' }, { by: 'admin1' }, { label: 'new' }]) {
      const r = await f(n, a.id, { reason: 'x', rowVersion: 1, ...extra }); assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.error, 'unknown_field');
    }
  }
  const row = (await env.pool.query('SELECT status, row_version FROM patient_problems WHERE id = $1', [a.id])).rows[0];
  assert.deepEqual([row.status, row.row_version], ['active', 1]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_problem_events WHERE problem_id = $1', [a.id])).rows[0].n, 1);
});

test('stale rowVersion gives 409 with the current version; a resolved problem cannot be resolved again but can be marked in error', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n), a = await mk(n, pid);
  assert.equal((await resolve(n, a.id, { reason: 'first', rowVersion: 1 })).status, 200);
  const stale = await resolve(d, a.id, { reason: 'second', rowVersion: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'version_conflict'); assert.equal(stale.body.currentRowVersion, 2);
  const again = await resolve(d, a.id, { reason: 'second', rowVersion: 2 });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'not_active');
  assert.equal((await wrong(d, a.id, { reason: 'stale', rowVersion: 1 })).status, 409);
  assert.equal((await wrong(d, a.id, { reason: 'fine', rowVersion: 2 })).status, 200);
  assert.equal((await env.pool.query('SELECT resolution_reason FROM patient_problems WHERE id = $1', [a.id])).rows[0].resolution_reason, 'first');
});

test('two moves at once: exactly one wins (row lock), the other gets 409', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n), a = await mk(n, pid);
  const rs = await Promise.all([resolve(n, a.id, { reason: 'one', rowVersion: 1 }), resolve(d, a.id, { reason: 'two', rowVersion: 1 })]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_problem_events WHERE problem_id = $1', [a.id])).rows[0].n, 2);
});

test('audit: problem.resolve and problem.error log ids and the reason length, never the reason text', async () => {
  const n = await as('nurse1'), pid = await newPatient(n), a = await mk(n, pid);
  await resolve(n, a.id, { reason: 'Secret resolution wording', rowVersion: 1 });
  await wrong(n, a.id, { reason: 'Secret error wording', rowVersion: 2 });
  const rows = (await env.pool.query(`SELECT action, detail, username FROM audit_log WHERE action IN ('problem.resolve','problem.error') AND entity_id = $1 ORDER BY id`, [String(pid)])).rows;
  assert.deepEqual(rows.map(r => r.action), ['problem.resolve', 'problem.error']);
  assert.ok(rows.every(r => r.username === 'nurse1'));
  assert.ok(!JSON.stringify(rows).includes('Secret'));
});

test('database guards: direct UPDATEs that break the rules are refused (owner and emr_app)', async () => {
  const n = await as('nurse1'), pid = await newPatient(n), a = await mk(n, pid), q = (sql, ...p) => env.pool.query(sql, [a.id, ...p]);
  const R = "status='resolved', resolved_by=1, resolved_at=now(), resolution_reason='r'";
  await assert.rejects(q(`UPDATE patient_problems SET ${R} WHERE id=$1`), /row_version/);                                   // version must advance by one
  await assert.rejects(q(`UPDATE patient_problems SET ${R}, row_version=3 WHERE id=$1`), /row_version/);
  await assert.rejects(q(`UPDATE patient_problems SET status='resolved', row_version=2 WHERE id=$1`), /check/);               // a move needs who, when and reason
  await assert.rejects(q(`UPDATE patient_problems SET status='entered_in_error', row_version=2 WHERE id=$1`), /check/);
  await assert.rejects(q(`UPDATE patient_problems SET status='resolved', row_version=2, resolved_by=1, resolved_at=now(), resolution_reason='  ' WHERE id=$1`), /check/);
  await assert.rejects(q(`UPDATE patient_problems SET ${R}, row_version=2, label='Other' WHERE id=$1`), /cannot be changed/);
  await assert.rejects(env.appPool.query(`UPDATE patient_problems SET ${R}, row_version=2, recorded_by=2 WHERE id=$1`, [a.id]), /permission denied/);
  await assert.rejects(q(`INSERT INTO patient_problem_events(problem_id, seq, from_status, to_status, reason, by_user) VALUES ($1, 5, 'active', 'resolved', 'skip', 1)`), /one after the other/);
  assert.equal((await env.appPool.query(`UPDATE patient_problems SET ${R}, row_version=2 WHERE id=$1`, [a.id])).rowCount, 1);   // the allowed move, as emr_app
  await assert.rejects(q(`UPDATE patient_problems SET status='active', row_version=3, resolved_by=NULL, resolved_at=NULL, resolution_reason=NULL WHERE id=$1`), /cannot move/);   // no way back
  await assert.rejects(q(`UPDATE patient_problems SET status='entered_in_error', row_version=3, error_by=1, error_at=now(), error_reason='e', resolution_reason='changed' WHERE id=$1`), /stays as it was/);
  assert.equal((await q(`UPDATE patient_problems SET status='entered_in_error', row_version=3, error_by=1, error_at=now(), error_reason='e' WHERE id=$1`)).rowCount, 1);
  await assert.rejects(q(`UPDATE patient_problems SET row_version=4 WHERE id=$1`), /final/);                                   // entered in error is final
  await assert.rejects(q(`UPDATE patient_problems SET status='resolved', row_version=4, resolved_by=1, resolved_at=now(), resolution_reason='r' WHERE id=$1`), /final/);
});
