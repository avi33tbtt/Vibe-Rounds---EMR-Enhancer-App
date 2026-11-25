'use strict';
// Task R3c: the patient allergy list on the server (list, get, add, resolve, entered in error). Same rules as allergies.
// Matrix and audit scenarios are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
async function newPatient(c) {
  const p = await c.post('/api/patients', { name: 'Allergy Patient ' + (++seq), mrn: 'ALG-' + seq, dob: '1975-05-05', sex: 'M' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const newCase = async (c, pid) => { const k = await c.post(`/api/patients/${pid}/cases`, { title: 'Allergy case' }); assert.equal(k.status, 201); return k.body.case.id; };
const add = async (c, pid, body) => c.post(`/api/patients/${pid}/allergies`, body);

test('add: nurse and doctor can; the recorder is the signed-in user; the first event is kept', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n);
  const a = await add(n, pid, { substance: 'Penicillin', onsetDate: '2019-03-01' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.allergy.recorded_by, 'nurse1'); assert.equal(a.body.allergy.status, 'active');
  assert.equal(a.body.allergy.onset_date, '2019-03-01'); assert.equal(a.body.allergy.row_version, 1); assert.equal(a.body.allergy.origin_case_id, null);
  const b = await add(d, pid, { substance: 'Peanuts' });
  assert.equal(b.status, 201); assert.equal(b.body.allergy.recorded_by, 'doctor1'); assert.equal(b.body.allergy.onset_date, null);
  const g = await n.get(`/api/allergies/${a.body.allergy.id}`);
  assert.equal(g.status, 200); assert.equal(g.body.allergy.events.length, 1);
  assert.deepEqual([g.body.allergy.events[0].seq, g.body.allergy.events[0].from_status, g.body.allergy.events[0].to_status, g.body.allergy.events[0].by_user], [1, null, 'active', 'nurse1']);
});

test('add: a viewer is refused; a body that names a recorder or status is refused and nothing is saved', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(n);
  assert.equal((await add(v, pid, { substance: 'x' })).status, 403);
  for (const extra of [{ recordedBy: 2 }, { recorded_by: 'doctor1' }, { status: 'resolved' }, { resolvedBy: 1 }]) {
    const r = await add(n, pid, { substance: 'x', ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.error, 'unknown_field');
  }
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_allergies WHERE patient_id = $1', [pid])).rows[0].n, 0);
});

test('add: bad substances, dates and ids are refused; an unknown patient is 404; an archived patient is 409', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n);
  for (const substance of ['', '   ', 5, null, 'x'.repeat(201), 'a\u0000b']) assert.equal((await add(n, pid, { substance })).status, 400, String(substance).slice(0, 10));
  assert.equal((await add(n, pid, {})).status, 400);
  for (const onsetDate of ['2019-02-30', '2019-3-1', 'yesterday', 20190301, '1850-01-01', '2999-01-01']) assert.equal((await add(n, pid, { substance: 'x', onsetDate })).status, 400, String(onsetDate));
  for (const originCaseId of ['1', 0, -1, 1.5]) assert.equal((await add(n, pid, { substance: 'x', originCaseId })).status, 400, String(originCaseId));
  assert.equal((await add(n, 999999, { substance: 'x' })).status, 404);
  assert.equal((await d.raw('PATCH', `/api/patients/${pid}/archive`, { archived: true })).status, 200);
  assert.equal((await add(n, pid, { substance: 'x' })).body.error, 'patient_archived');
});

test('origin case: must be a case of the SAME patient (checked in the route and by the database)', async () => {
  const n = await as('nurse1'), p1 = await newPatient(n), p2 = await newPatient(n), k1 = await newCase(n, p1), k2 = await newCase(n, p2);
  const ok = await add(n, p1, { substance: 'From a case', originCaseId: k1 });
  assert.equal(ok.status, 201); assert.equal(ok.body.allergy.origin_case_id, k1);
  const other = await add(n, p1, { substance: 'Wrong case', originCaseId: k2 });
  assert.equal(other.status, 400); assert.equal(other.body.error, 'case_not_of_patient');
  assert.equal((await add(n, p1, { substance: 'No such case', originCaseId: 999999 })).status, 400);
  await assert.rejects(env.pool.query('INSERT INTO patient_allergies(patient_id, origin_case_id, substance, recorded_by) VALUES ($1,$2,$3,1)', [p1, k2, 'direct']), /foreign key/);
});

test('list: one list across cases; everyone who can read sees it; entered-in-error is hidden unless include=all; an unknown patient is 404', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), i = await as('informatician1'), pid = await newPatient(n), other = await newPatient(n), k = await newCase(n, pid);
  await add(n, pid, { substance: 'One' }); await add(n, pid, { substance: 'Two', originCaseId: k }); await add(n, other, { substance: 'Not this patient' });
  const r = await v.get(`/api/patients/${pid}/allergies`);
  assert.equal(r.status, 200); assert.deepEqual(r.body.allergies.map(p => p.substance), ['One', 'Two']);
  assert.equal((await i.get(`/api/patients/${pid}/allergies`)).status, 403, 'informatician has no clinical read');
  const bad = r.body.allergies[0].id;
  await env.pool.query(`UPDATE patient_allergies SET status='entered_in_error', row_version=2, error_by=1, error_at=now(), error_reason='test' WHERE id=$1`, [bad]);
  assert.deepEqual((await v.get(`/api/patients/${pid}/allergies`)).body.allergies.map(p => p.substance), ['Two']);
  assert.deepEqual((await v.get(`/api/patients/${pid}/allergies?include=all`)).body.allergies.map(p => p.substance), ['One', 'Two']);
  assert.equal((await v.get('/api/patients/999999/allergies')).status, 404);
  assert.equal((await v.get('/api/allergies/999999')).status, 404);
});

test('audit: ids and the substance length are logged, never the substance text', async () => {
  const n = await as('nurse1'), pid = await newPatient(n);
  const a = await add(n, pid, { substance: 'Secret allergy wording' });
  await n.get(`/api/patients/${pid}/allergies`); await n.get(`/api/allergies/${a.body.allergy.id}`);
  const rows = (await env.pool.query(`SELECT action, detail, username FROM audit_log WHERE action IN ('allergy.add','patient.allergies_view','allergy.view') AND entity_id = $1`, [String(pid)])).rows;
  assert.deepEqual(rows.map(r => r.action).sort(), ['patient.allergies_view', 'allergy.add', 'allergy.view']);
  assert.ok(rows.every(r => r.username === 'nurse1'));
  assert.ok(!JSON.stringify(rows).includes('Secret allergy'));
  assert.equal(rows.find(r => r.action === 'allergy.add').detail.substanceLength, 22);
});

test('database: no delete or truncate (even as the owner); substance cannot change; the history table is append-only; emr_app has no DELETE', async () => {
  const n = await as('nurse1'), pid = await newPatient(n), a = (await add(n, pid, { substance: 'Fixed substance' })).body.allergy;
  await assert.rejects(env.pool.query('DELETE FROM patient_allergies WHERE id = $1', [a.id]), /append-only/);
  await assert.rejects(env.pool.query('TRUNCATE patient_allergies CASCADE'), /append-only|not allowed/);
  await assert.rejects(env.pool.query('DELETE FROM patient_allergy_events WHERE allergy_id = $1', [a.id]), /append-only/);
  await assert.rejects(env.pool.query(`UPDATE patient_allergy_events SET reason = 'x' WHERE allergy_id = $1`, [a.id]), /append-only/);
  await assert.rejects(env.pool.query(`UPDATE patient_allergies SET substance = 'Changed' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.appPool.query(`UPDATE patient_allergies SET substance = 'Changed' WHERE id = $1`, [a.id]), /permission denied/);
  await assert.rejects(env.appPool.query('DELETE FROM patient_allergies WHERE id = $1', [a.id]), /permission denied/);
  await assert.rejects(env.appPool.query('TRUNCATE patient_allergies'), /permission denied/);
  await assert.rejects(env.pool.query(`INSERT INTO patient_allergies(patient_id, substance, recorded_by, status) VALUES ($1,'x',1,'resolved')`, [pid]), /starts as active|check/);
  await assert.rejects(env.pool.query(`UPDATE patient_allergies SET status='resolved' WHERE id=$1`, [a.id]), /check|row_version/);
});

/* ---------- R3a-2: resolve and entered in error ---------- */
const mk = async (c, pid, substance = 'Move me') => (await add(c, pid, { substance })).body.allergy;
const resolve = (c, id, body) => c.post(`/api/allergies/${id}/resolve`, body);
const wrong = (c, id, body) => c.post(`/api/allergies/${id}/entered-in-error`, body);

test('resolve: nurse and doctor can; the resolver is the session user; history, version and audit are kept; the substance is untouched', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n);
  const a = await mk(n, pid, 'Keep this substance'), b = await mk(n, pid, 'Second');
  const r = await resolve(d, a.id, { reason: 'Treated and settled', rowVersion: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.allergy;
  assert.deepEqual([p.status, p.row_version, p.resolved_by, p.resolution_reason, p.substance, p.recorded_by], ['resolved', 2, 'doctor1', 'Treated and settled', 'Keep this substance', 'nurse1']);
  assert.ok(p.resolved_at); assert.equal(p.error_by, null);
  assert.deepEqual(p.events.map(e => [e.seq, e.from_status, e.to_status, e.by_user]), [[1, null, 'active', 'nurse1'], [2, 'active', 'resolved', 'doctor1']]);
  assert.equal((await resolve(n, b.id, { reason: 'ok', rowVersion: 1 })).body.allergy.resolved_by, 'nurse1');
  assert.equal((await n.get(`/api/allergies/${a.id}`)).body.allergy.events.length, 2);
  assert.deepEqual((await n.get(`/api/patients/${pid}/allergies`)).body.allergies.map(x => x.status), ['resolved', 'resolved']);
});

test('entered in error: from active or from resolved; the earlier resolution stays; hidden from the default list; final', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(n);
  const a = await mk(n, pid, 'A'), b = await mk(n, pid, 'B'), keep = await mk(n, pid, 'C');
  const ea = await wrong(n, a.id, { reason: 'Wrong patient', rowVersion: 1 });
  assert.equal(ea.status, 200, JSON.stringify(ea.body));
  assert.deepEqual([ea.body.allergy.status, ea.body.allergy.error_by, ea.body.allergy.error_reason, ea.body.allergy.row_version], ['entered_in_error', 'nurse1', 'Wrong patient', 2]);
  await resolve(n, b.id, { reason: 'Settled', rowVersion: 1 });
  const eb = await wrong(n, b.id, { reason: 'Never had it', rowVersion: 2 });
  assert.equal(eb.status, 200, JSON.stringify(eb.body));
  assert.deepEqual([eb.body.allergy.resolved_by, eb.body.allergy.resolution_reason, eb.body.allergy.error_reason], ['nurse1', 'Settled', 'Never had it']);
  assert.deepEqual(eb.body.allergy.events.map(e => [e.seq, e.from_status, e.to_status]), [[1, null, 'active'], [2, 'active', 'resolved'], [3, 'resolved', 'entered_in_error']]);
  assert.deepEqual((await v.get(`/api/patients/${pid}/allergies`)).body.allergies.map(x => x.substance), ['C']);
  assert.equal((await v.get(`/api/patients/${pid}/allergies?include=all`)).body.allergies.length, 3);
  for (const f of [resolve, wrong]) { const r = await f(n, a.id, { reason: 'again', rowVersion: 2 }); assert.equal(r.status, 409); assert.equal(r.body.error, 'allergy_final'); }
  assert.equal((await n.get(`/api/allergies/${keep.id}`)).body.allergy.status, 'active');
});

test('refused: viewer, unknown ids, missing or bad reason, missing or bad rowVersion, a body that names a user or status; nothing changes', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), pid = await newPatient(n), a = await mk(n, pid);
  for (const f of [resolve, wrong]) {
    assert.equal((await f(v, a.id, { reason: 'x', rowVersion: 1 })).status, 403);
    assert.equal((await f(n, 999999, { reason: 'x', rowVersion: 1 })).status, 404);
    assert.equal((await f(n, 'abc', { reason: 'x', rowVersion: 1 })).status, 404);
    for (const reason of [undefined, '', '   ', 5, null, 'x'.repeat(1001), 'a\u0000b']) assert.equal((await f(n, a.id, { reason, rowVersion: 1 })).status, 400, String(reason).slice(0, 8));
    for (const rowVersion of [undefined, '1', 0, -1, 1.5, null]) assert.equal((await f(n, a.id, { reason: 'x', rowVersion })).status, 400, String(rowVersion));
    for (const extra of [{ resolvedBy: 2 }, { resolved_by: 'doctor1' }, { status: 'active' }, { by: 'admin1' }, { substance: 'new' }]) {
      const r = await f(n, a.id, { reason: 'x', rowVersion: 1, ...extra }); assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.error, 'unknown_field');
    }
  }
  const row = (await env.pool.query('SELECT status, row_version FROM patient_allergies WHERE id = $1', [a.id])).rows[0];
  assert.deepEqual([row.status, row.row_version], ['active', 1]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_allergy_events WHERE allergy_id = $1', [a.id])).rows[0].n, 1);
});

test('stale rowVersion gives 409 with the current version; a resolved allergy cannot be resolved again but can be marked in error', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n), a = await mk(n, pid);
  assert.equal((await resolve(n, a.id, { reason: 'first', rowVersion: 1 })).status, 200);
  const stale = await resolve(d, a.id, { reason: 'second', rowVersion: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'version_conflict'); assert.equal(stale.body.currentRowVersion, 2);
  const again = await resolve(d, a.id, { reason: 'second', rowVersion: 2 });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'not_active');
  assert.equal((await wrong(d, a.id, { reason: 'stale', rowVersion: 1 })).status, 409);
  assert.equal((await wrong(d, a.id, { reason: 'fine', rowVersion: 2 })).status, 200);
  assert.equal((await env.pool.query('SELECT resolution_reason FROM patient_allergies WHERE id = $1', [a.id])).rows[0].resolution_reason, 'first');
});

test('two moves at once: exactly one wins (row lock), the other gets 409', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), pid = await newPatient(n), a = await mk(n, pid);
  const rs = await Promise.all([resolve(n, a.id, { reason: 'one', rowVersion: 1 }), resolve(d, a.id, { reason: 'two', rowVersion: 1 })]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_allergy_events WHERE allergy_id = $1', [a.id])).rows[0].n, 2);
});

test('audit: allergy.resolve and allergy.error log ids and the reason length, never the reason text', async () => {
  const n = await as('nurse1'), pid = await newPatient(n), a = await mk(n, pid);
  await resolve(n, a.id, { reason: 'Secret resolution wording', rowVersion: 1 });
  await wrong(n, a.id, { reason: 'Secret error wording', rowVersion: 2 });
  const rows = (await env.pool.query(`SELECT action, detail, username FROM audit_log WHERE action IN ('allergy.resolve','allergy.error') AND entity_id = $1 ORDER BY id`, [String(pid)])).rows;
  assert.deepEqual(rows.map(r => r.action), ['allergy.resolve', 'allergy.error']);
  assert.ok(rows.every(r => r.username === 'nurse1'));
  assert.ok(!JSON.stringify(rows).includes('Secret'));
});

test('database guards: direct UPDATEs that break the rules are refused (owner and emr_app)', async () => {
  const n = await as('nurse1'), pid = await newPatient(n), a = await mk(n, pid), q = (sql, ...p) => env.pool.query(sql, [a.id, ...p]);
  const R = "status='resolved', resolved_by=1, resolved_at=now(), resolution_reason='r'";
  await assert.rejects(q(`UPDATE patient_allergies SET ${R} WHERE id=$1`), /row_version/);                                   // version must advance by one
  await assert.rejects(q(`UPDATE patient_allergies SET ${R}, row_version=3 WHERE id=$1`), /row_version/);
  await assert.rejects(q(`UPDATE patient_allergies SET status='resolved', row_version=2 WHERE id=$1`), /check/);               // a move needs who, when and reason
  await assert.rejects(q(`UPDATE patient_allergies SET status='entered_in_error', row_version=2 WHERE id=$1`), /check/);
  await assert.rejects(q(`UPDATE patient_allergies SET status='resolved', row_version=2, resolved_by=1, resolved_at=now(), resolution_reason='  ' WHERE id=$1`), /check/);
  await assert.rejects(q(`UPDATE patient_allergies SET ${R}, row_version=2, substance='Other' WHERE id=$1`), /cannot be changed/);
  await assert.rejects(env.appPool.query(`UPDATE patient_allergies SET ${R}, row_version=2, recorded_by=2 WHERE id=$1`, [a.id]), /permission denied/);
  await assert.rejects(q(`INSERT INTO patient_allergy_events(allergy_id, seq, from_status, to_status, reason, by_user) VALUES ($1, 5, 'active', 'resolved', 'skip', 1)`), /one after the other/);
  assert.equal((await env.appPool.query(`UPDATE patient_allergies SET ${R}, row_version=2 WHERE id=$1`, [a.id])).rowCount, 1);   // the allowed move, as emr_app
  await assert.rejects(q(`UPDATE patient_allergies SET status='active', row_version=3, resolved_by=NULL, resolved_at=NULL, resolution_reason=NULL WHERE id=$1`), /cannot move/);   // no way back
  await assert.rejects(q(`UPDATE patient_allergies SET status='entered_in_error', row_version=3, error_by=1, error_at=now(), error_reason='e', resolution_reason='changed' WHERE id=$1`), /stays as it was/);
  assert.equal((await q(`UPDATE patient_allergies SET status='entered_in_error', row_version=3, error_by=1, error_at=now(), error_reason='e' WHERE id=$1`)).rowCount, 1);
  await assert.rejects(q(`UPDATE patient_allergies SET row_version=4 WHERE id=$1`), /final/);                                   // entered in error is final
  await assert.rejects(q(`UPDATE patient_allergies SET status='resolved', row_version=4, resolved_by=1, resolved_at=now(), resolution_reason='r' WHERE id=$1`), /final/);
});

/* ---------- allergy-only fields: reaction and severity ---------- */
test('reaction and severity: optional, kept as given, null when left out', async () => {
  const n = await as('nurse1'), pid = await newPatient(n);
  const a = await add(n, pid, { substance: 'Penicillin', reaction: 'Hives and swelling', severity: 'severe' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual([a.body.allergy.reaction, a.body.allergy.severity], ['Hives and swelling', 'severe']);
  const b = await add(n, pid, { substance: 'Latex', reaction: null, severity: null });
  assert.equal(b.status, 201); assert.deepEqual([b.body.allergy.reaction, b.body.allergy.severity], [null, null]);
  const c = await add(n, pid, { substance: 'Dust' });
  assert.deepEqual([c.body.allergy.reaction, c.body.allergy.severity], [null, null]);
  for (const severity of ['SEVERE', 'bad', '', 3, true]) assert.equal((await add(n, pid, { substance: 'x', severity })).status, 400, String(severity));
  for (const reaction of ['', '   ', 5, 'x'.repeat(501), 'a\u0000b']) assert.equal((await add(n, pid, { substance: 'x', reaction })).status, 400, String(reaction).slice(0, 8));
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM patient_allergies WHERE patient_id = $1', [pid])).rows[0].n, 3);
});

test('reaction text is never written to the audit log; reaction and severity cannot change in the database', async () => {
  const n = await as('nurse1'), pid = await newPatient(n);
  const a = (await add(n, pid, { substance: 'Sulfa', reaction: 'Secret reaction wording', severity: 'mild' })).body.allergy;
  const rows = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'allergy.add' AND entity_id = $1`, [String(pid)])).rows;
  assert.ok(!JSON.stringify(rows).includes('Secret reaction'));
  await assert.rejects(env.pool.query(`UPDATE patient_allergies SET reaction = 'Changed' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.pool.query(`UPDATE patient_allergies SET severity = 'severe' WHERE id = $1`, [a.id]), /cannot be changed/);
  await assert.rejects(env.appPool.query(`UPDATE patient_allergies SET severity = 'severe' WHERE id = $1`, [a.id]), /permission denied/);
  await assert.rejects(env.pool.query(`INSERT INTO patient_allergies(patient_id, substance, severity, recorded_by) VALUES ($1,'x','extreme',1)`, [pid]), /check/);
});
