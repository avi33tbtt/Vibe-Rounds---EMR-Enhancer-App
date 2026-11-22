'use strict';
// Task B3a: applied sets (the version pin), observations and the clinical timeline on the server.
// The permission matrix and audit scenarios for these routes are in safety-routes.test.js; the "never deleted" classification is in safety-data.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');

let env, R, admin, seq = 0;
test.before(async () => { env = await setup(); R = await reviewers(env.base); admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };   // a fresh session per test keeps clear of the per-session write limit
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const DEF = {
  title: 'Obs set',
  fields: [
    { id: 'hr', label: 'Heart rate', type: 'number', unit: 'bpm' },
    { id: 'rr', label: 'Resp rate', type: 'integer', unit: '/min' },
    { id: 'alert', label: 'Alert', type: 'boolean' },
    { id: 'avpu', label: 'AVPU', type: 'select', options: ['Alert', 'Voice', 'Pain', 'Unresponsive'] },
    { id: 'seen', label: 'Seen at', type: 'datetime' },
    { id: 'comment', label: 'Comment', type: 'text' },
    { id: 'bal', label: 'Balance', type: 'number', derived: true },
  ],
};
// A published set: created by the doctor, approved by the informaticians, published by the admin.
async function publishedSet(def = DEF) {
  const slug = 'obs-set-' + (++seq);
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: def });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  const pub = await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  return { id: made.body.set.id, slug };
}
async function newVersion(setId, def) {   // v2, v3 ... published
  const v = await R.doctor.post(`/api/element-sets/${setId}/versions`, { definition: def });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  await approveVersion(R, setId, v.body.version.version);
  assert.equal((await admin.post(`/api/element-sets/${setId}/versions/${v.body.version.version}/publish`, {})).status, 200);
  return v.body.version.version;
}
async function newCase(c) {
  const p = await c.post('/api/patients', { name: 'Obs Patient ' + (++seq), mrn: 'OBS-' + seq, dob: '1980-01-01', sex: 'F' });
  assert.equal(p.status, 201);
  const k = await c.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Obs case' });
  assert.equal(k.status, 201);
  return k.body.case.id;
}
async function applied(c, caseId, set, version = 1) {
  const r = await c.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.appliedSet;
}
const rec = (c, caseId, ...obs) => c.post(`/api/cases/${caseId}/observations`, { observations: obs });
const dbCount = async caseId => (await env.pool.query('SELECT count(*)::int n FROM observations WHERE case_id = $1', [caseId])).rows[0].n;

test('apply: only a published version; the same version twice, an unknown version and an archived case are refused', async () => {
  const n = await as('nurse1');
  const set = await publishedSet(), caseId = await newCase(n);
  const draft = await R.doctor.post(`/api/element-sets/${set.id}/versions`, { definition: DEF });      // v2 stays a draft
  assert.equal(draft.status, 201);
  let r = await n.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 2 });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_published');
  assert.equal((await n.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 9 })).body.error, 'version_not_found');
  r = await n.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 1, appliedBy: 'mallory' });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field');
  const a = await applied(n, caseId, set);
  assert.equal(a.state, 'active'); assert.equal(a.version, 1); assert.equal(a.applied_by, 'nurse1'); assert.equal(a.slug, set.slug);
  assert.equal((await n.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 1 })).body.error, 'already_applied');
  assert.equal((await n.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 'x' })).status, 400);
  // an archived case takes no new pin
  const d = await as('doctor1'); const cs = (await d.get(`/api/cases/${caseId}`)).body.case;
  assert.equal((await d.patch(`/api/cases/${caseId}/archive`, { archived: true, rowVersion: cs.row_version })).status, 200);
  const other = await publishedSet();
  assert.equal((await n.post(`/api/cases/${caseId}/applied-sets`, { setId: other.id, version: 1 })).body.error, 'case_archived');
});

test('a newer version is an explicit update: the old pin is superseded, its values stay; an older one is refused; withdraw keeps everything; re-apply works', async () => {
  const n = await as('nurse1');
  const set = await publishedSet(), caseId = await newCase(n);
  const a1 = await applied(n, caseId, set);
  const o1 = await rec(n, caseId, { appliedSetId: a1.id, fieldKey: 'hr', value: 80, effectiveAt: ago(30), sourceType: 'clinician' });
  assert.equal(o1.status, 201);
  const v2 = await newVersion(set.id, { ...DEF, title: 'Obs set v2' });
  const a2 = await applied(n, caseId, set, v2);
  assert.equal(a2.supersedes_id, a1.id); assert.equal(a2.version, v2);
  const tl = (await n.get(`/api/cases/${caseId}/timeline`)).body;
  const old = tl.appliedSets.find(x => x.id === a1.id);
  assert.equal(old.state, 'superseded'); assert.equal(old.state_by, 'nurse1'); assert.ok(old.state_at);
  assert.equal(tl.observations.length, 1, 'the value entered under the old pin is still there');
  assert.equal(tl.observations[0].set_version, 1, 'and still says which version it was entered under');
  assert.deepEqual(tl.events.map(e => e.event_type).sort(), ['observation_recorded', 'set_applied', 'set_upgraded']);
  // values go only under the active pin
  const stale = await rec(n, caseId, { appliedSetId: a1.id, fieldKey: 'hr', value: 81, effectiveAt: ago(5), sourceType: 'clinician' });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'set_not_active');
  assert.equal((await n.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 1 })).body.error, 'not_newer');
  // withdraw
  const w = await n.post(`/api/cases/${caseId}/applied-sets/${a2.id}/withdraw`, {});
  assert.equal(w.status, 200); assert.equal(w.body.appliedSet.state, 'withdrawn'); assert.equal(w.body.appliedSet.state_by, 'nurse1');
  assert.equal((await n.post(`/api/cases/${caseId}/applied-sets/${a2.id}/withdraw`, {})).body.error, 'not_active');
  assert.equal((await rec(n, caseId, { appliedSetId: a2.id, fieldKey: 'hr', value: 82, effectiveAt: ago(5), sourceType: 'clinician' })).body.error, 'set_not_active');
  assert.equal((await n.post(`/api/cases/${caseId}/applied-sets/999999/withdraw`, {})).status, 404);
  const a3 = await applied(n, caseId, set, v2);                      // applying it again adds a new row
  assert.ok(a3.id > a2.id && a3.state === 'active' && a3.supersedes_id === null);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM case_applied_sets WHERE case_id = $1', [caseId])).rows[0].n, 3, 'no pin row was removed');
});

test('values are checked against the pinned field and never coerced; a refused batch stores nothing', async () => {
  const n = await as('nurse1');
  const set = await publishedSet(), caseId = await newCase(n), other = await newCase(n);
  const a = await applied(n, caseId, set), foreign = await applied(n, other, set);
  const ok = { appliedSetId: a.id, effectiveAt: ago(10), sourceType: 'clinician' };
  const cases = [   // [entry, expected error code]
    [{ fieldKey: 'nope', value: 1 }, 'unknown_field_key'],
    [{ fieldKey: 'hr', value: '72' }, 'invalid_value'],               // text where a number is expected: not coerced
    [{ fieldKey: 'hr', value: null }, 'invalid_value'],
    [{ fieldKey: 'hr', value: 72, unit: 'mmHg' }, 'invalid_unit'],    // a different unit is refused, not converted
    [{ fieldKey: 'alert', value: true, unit: 'bpm' }, 'invalid_unit'],
    [{ fieldKey: 'rr', value: 3.5 }, 'invalid_value'],
    [{ fieldKey: 'alert', value: 'true' }, 'invalid_value'],
    [{ fieldKey: 'avpu', value: 'Sleepy' }, 'invalid_value'],
    [{ fieldKey: 'seen', value: '2026-11-23T10:30:00' }, 'invalid_value'],       // no offset
    [{ fieldKey: 'seen', value: '2026-02-30T10:00:00Z' }, 'invalid_value'],      // no such day
    [{ fieldKey: 'comment', value: '   ' }, 'invalid_value'],
    [{ fieldKey: 'bal', value: 5 }, 'derived_field'],
    [{ fieldKey: 'hr', value: 72, unknown: true }, 'invalid'],
    [{ fieldKey: 'hr' }, 'invalid'],
    [{ fieldKey: 'hr', value: 72, unknown: false }, 'invalid'],
  ];
  for (const [e, code] of cases) {
    const r = await rec(n, caseId, { ...ok, ...e });
    assert.equal(r.status, 400, JSON.stringify(e)); assert.equal(r.body.error, code, JSON.stringify([e, r.body]));
  }
  const top = [   // refused before the case is even read
    [{ ...ok, fieldKey: 'hr', value: 1, effectiveAt: new Date(Date.now() + 3600e3).toISOString() }, 'in the future'],
    [{ ...ok, fieldKey: 'hr', value: 1, effectiveAt: '2026-11-20 10:00' }, 'offset'],
    [{ ...ok, fieldKey: 'hr', value: 1, sourceType: 'oracle' }, 'sourceType'],
    [{ ...ok, fieldKey: 'hr', value: 1, status: 'amended' }, 'status'],
    [{ ...ok, fieldKey: 'hr', value: 1, status: 'entered_in_error' }, 'status'],
    [{ ...ok, fieldKey: 'hr', value: 1, sourceType: 'ai_proposed', status: 'final' }, 'preliminary'],
    [{ ...ok, fieldKey: 'hr', value: 1, recordedBy: 'mallory' }, undefined],
    [{ ...ok, fieldKey: 'hr', value: 1, recordedAt: '2020-01-01T00:00:00Z' }, undefined],
  ];
  for (const [e, word] of top) {
    const r = await rec(n, caseId, e);
    assert.equal(r.status, 400, JSON.stringify(e)); if (word) assert.match(r.body.message, new RegExp(word), JSON.stringify(r.body));
    else assert.equal(r.body.error, 'unknown_field');
  }
  // a pin from another case, and a batch where the second entry is bad: nothing is stored
  assert.equal((await rec(n, caseId, { ...ok, appliedSetId: foreign.id, fieldKey: 'hr', value: 1 })).body.error, 'applied_set_not_found');
  const half = await rec(n, caseId, { ...ok, fieldKey: 'hr', value: 70 }, { ...ok, fieldKey: 'hr', value: 'x' });
  assert.equal(half.status, 400); assert.equal(half.body.index, 1);
  assert.equal(await dbCount(caseId), 0, 'all or nothing');
  assert.equal((await n.post(`/api/cases/${caseId}/observations`, { observations: [] })).status, 400);

  // what is accepted: each type, a unit taken from the field, an explicit unknown, and the actor from the session
  const r = await rec(n, caseId,
    { ...ok, fieldKey: 'hr', value: 72.5 }, { ...ok, fieldKey: 'rr', value: 18, unit: '/min' }, { ...ok, fieldKey: 'alert', value: false },
    { ...ok, fieldKey: 'avpu', value: 'Voice' }, { ...ok, fieldKey: 'seen', value: '2026-11-23T10:30:00+05:45' }, { ...ok, fieldKey: 'comment', value: 'Drowsy' },
    { ...ok, fieldKey: 'hr', unknown: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.observations.map(o => [o.field_key + (o.value_type === 'unknown' ? '?' : ''), o]));
  assert.equal(by.hr.value, 72.5); assert.equal(by.hr.unit_display, 'bpm'); assert.equal(by.hr.status, 'final');
  assert.equal(by.rr.unit_display, '/min'); assert.equal(by.alert.value, false); assert.equal(by.avpu.value, 'Voice');
  assert.equal(by['hr?'].value_type, 'unknown'); assert.equal(by['hr?'].value, null);
  assert.ok(r.body.observations.every(o => o.recorded_by === 'nurse1'));
  assert.ok(r.body.observations.every(o => Math.abs(new Date(o.recorded_at) - Date.now()) < 60000), 'recorded_at is the server clock');
  assert.equal(await dbCount(caseId), 7);
});

test('the timeline is ordered by when a value was true, keeps recorded_at, and tells the sources apart', async () => {
  const n = await as('nurse1');
  const set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const mk = (min, value, sourceType, extra = {}) => ({ appliedSetId: a.id, fieldKey: 'hr', value, effectiveAt: ago(min), sourceType, ...extra });
  assert.equal((await rec(n, caseId, mk(10, 100, 'clinician'))).status, 201);
  assert.equal((await rec(n, caseId, mk(60, 60, 'patient', { sourceRef: 'self-report' }))).status, 201);       // entered later, but true earlier
  assert.equal((await rec(n, caseId, mk(30, 80, 'device', { sourceRef: 'monitor-7' }), mk(20, 90, 'imported'), mk(15, 95, 'derived'))).status, 201);
  const ai = await rec(n, caseId, mk(5, 99, 'ai_proposed', { sourceRef: 'draft-1' }));
  assert.equal(ai.status, 201); assert.equal(ai.body.observations[0].status, 'preliminary', 'an AI proposal is preliminary, never final');
  const tl = (await n.get(`/api/cases/${caseId}/timeline`)).body;
  assert.deepEqual(tl.observations.map(o => o.value), [60, 80, 90, 95, 100, 99], 'ordered by effective_at');
  assert.deepEqual(tl.observations.map(o => o.source_type), ['patient', 'device', 'imported', 'derived', 'clinician', 'ai_proposed']);
  assert.deepEqual(tl.observations.map(o => o.source_ref), ['self-report', 'monitor-7', null, null, null, 'draft-1']);
  const t100 = tl.observations.find(o => o.value === 100), t60 = tl.observations.find(o => o.value === 60);
  assert.ok(new Date(t60.recorded_at) > new Date(t100.recorded_at), 'recorded_at shows the later entry');
  const one = (await n.get(`/api/cases/${caseId}/timeline?fieldKey=hr&limit=2`)).body;
  assert.equal(one.observations.length, 2);
  assert.equal((await n.get(`/api/cases/${caseId}/timeline?fieldKey=bad%20key`)).status, 400);
  assert.equal((await n.get('/api/cases/999999/timeline')).status, 404);
  // a viewer reads but cannot write
  const v = await as('viewer1');
  assert.equal((await v.get(`/api/cases/${caseId}/timeline`)).status, 200);
  assert.equal((await rec(v, caseId, mk(1, 1, 'clinician'))).status, 403);
  // the read is audited, and the audit log holds ids, never the values
  const audits = (await env.pool.query(`SELECT action, detail FROM audit_log WHERE entity_id = $1 AND action IN ('case.timeline_view','observation.record')`, [String(caseId)])).rows;
  assert.ok(audits.some(x => x.action === 'case.timeline_view') && audits.some(x => x.action === 'observation.record'));
  assert.ok(!JSON.stringify(audits).includes('self-report'));
});

test('a correction is a new row: the original keeps its value and both times; a row is corrected once; a reason is required', async () => {
  const n = await as('nurse1'), d = await as('doctor1');
  const set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const first = (await rec(n, caseId, { appliedSetId: a.id, fieldKey: 'hr', value: 150, effectiveAt: ago(20), sourceType: 'device', sourceRef: 'monitor-1' })).body.observations[0];
  const snapshot = async id => (await env.pool.query('SELECT * FROM observations WHERE id = $1', [id])).rows[0];
  const before = await snapshot(first.id);
  const noReason = await n.post(`/api/observations/${first.id}/correct`, { value: 105, sourceType: 'clinician' });
  assert.equal(noReason.status, 400);
  assert.equal((await n.post(`/api/observations/${first.id}/correct`, { value: '105', sourceType: 'clinician', reason: 'typo' })).body.error, 'invalid_value');
  assert.equal((await n.post(`/api/observations/${first.id}/correct`, { value: 105, sourceType: 'ai_proposed', reason: 'typo' })).status, 400);
  assert.equal((await n.post(`/api/observations/${first.id}/correct`, { value: 105, sourceType: 'clinician', reason: 'typo', recordedBy: 'mallory' })).body.error, 'unknown_field');
  const c = await d.post(`/api/observations/${first.id}/correct`, { value: 105, sourceType: 'clinician', reason: 'Monitor misread' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const fix = c.body.observation;
  assert.equal(fix.status, 'amended'); assert.equal(fix.corrects_id, first.id); assert.equal(fix.change_reason, 'Monitor misread');
  assert.equal(fix.recorded_by, 'doctor1', 'the corrector is the session user'); assert.equal(fix.value, 105); assert.equal(fix.unit_display, 'bpm');
  assert.deepEqual(await snapshot(first.id), before, 'the original row is byte for byte unchanged');
  const same = (await env.pool.query('SELECT a.effective_at = b.effective_at AS eq, b.recorded_at > a.recorded_at AS later FROM observations a, observations b WHERE a.id = $1 AND b.id = $2', [first.id, fix.id])).rows[0];
  assert.deepEqual(same, { eq: true, later: true }, 'effective_at is kept exactly; recorded_at is the new entry time');
  const again = await n.post(`/api/observations/${first.id}/correct`, { value: 106, sourceType: 'clinician', reason: 'Again' });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'already_corrected');
  // a correction may state a new effective time and an explicit unknown; the chain continues from the newest row
  const c2 = await n.post(`/api/observations/${fix.id}/correct`, { unknown: true, effectiveAt: ago(25), sourceType: 'clinician', reason: 'Cannot be confirmed' });
  assert.equal(c2.status, 201); assert.equal(c2.body.observation.value_type, 'unknown');
  const tl = (await n.get(`/api/cases/${caseId}/timeline`)).body;
  assert.equal(tl.observations.length, 3, 'the history is all there');
  assert.equal(tl.observations.find(o => o.id === first.id).corrected_by_id, fix.id);
  assert.equal(tl.observations.find(o => o.id === fix.id).corrected_by_id, c2.body.observation.id);
  assert.equal((await n.post('/api/observations/999999/correct', { value: 1, sourceType: 'clinician', reason: 'x' })).status, 404);
});

test('entered in error: hidden by default, row and value kept, who and when recorded; it cannot be corrected or marked twice', async () => {
  const n = await as('nurse1'), d = await as('doctor1');
  const set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const mk = value => ({ appliedSetId: a.id, fieldKey: 'hr', value, effectiveAt: ago(10), sourceType: 'clinician' });
  const [keep, wrong] = (await rec(n, caseId, mk(70), mk(700))).body.observations;
  assert.equal((await n.post(`/api/observations/${wrong.id}/entered-in-error`, {})).status, 400, 'a reason is required');
  const r = await d.post(`/api/observations/${wrong.id}/entered-in-error`, { reason: 'Wrong patient' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.observation.status, 'entered_in_error'); assert.equal(r.body.observation.error_by, 'doctor1'); assert.ok(r.body.observation.error_at);
  assert.equal(r.body.observation.value, 700, 'the value is kept');
  const def = (await n.get(`/api/cases/${caseId}/timeline`)).body;
  assert.deepEqual(def.observations.map(o => o.id), [keep.id]); assert.equal(def.hiddenInError, 1);
  const all = (await n.get(`/api/cases/${caseId}/timeline?includeErrors=1`)).body;
  assert.equal(all.observations.length, 2); assert.equal(all.hiddenInError, 0);
  assert.equal(all.observations.find(o => o.id === wrong.id).error_reason, 'Wrong patient');
  assert.equal(await dbCount(caseId), 2, 'the row is still in the table');
  assert.equal((await n.post(`/api/observations/${wrong.id}/entered-in-error`, { reason: 'again' })).body.error, 'already_entered_in_error');
  assert.equal((await n.post(`/api/observations/${wrong.id}/correct`, { value: 71, sourceType: 'clinician', reason: 'fix' })).body.error, 'entered_in_error');
  assert.ok((await n.get(`/api/cases/${caseId}/timeline`)).body.events.some(e => e.event_type === 'observation_entered_in_error' && e.actor === 'doctor1'));
});

test('an archived case takes no new pin, value, correction or entered-in-error mark', async () => {
  const n = await as('nurse1'), d = await as('doctor1');
  const set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const o = (await rec(n, caseId, { appliedSetId: a.id, fieldKey: 'hr', value: 70, effectiveAt: ago(10), sourceType: 'clinician' })).body.observations[0];
  const cs = (await d.get(`/api/cases/${caseId}`)).body.case;
  assert.equal((await d.patch(`/api/cases/${caseId}/archive`, { archived: true, rowVersion: cs.row_version })).status, 200);
  for (const r of [
    await rec(n, caseId, { appliedSetId: a.id, fieldKey: 'hr', value: 71, effectiveAt: ago(1), sourceType: 'clinician' }),
    await n.post(`/api/observations/${o.id}/correct`, { value: 72, sourceType: 'clinician', reason: 'x' }),
    await n.post(`/api/observations/${o.id}/entered-in-error`, { reason: 'x' }),
    await n.post(`/api/cases/${caseId}/applied-sets/${a.id}/withdraw`, {}),
  ]) { assert.equal(r.status, 409); assert.equal(r.body.error, 'case_archived'); }
  assert.equal((await n.get(`/api/cases/${caseId}/timeline`)).status, 200, 'it can still be read');
});

test('the database refuses rewrites itself: values, times, sources, pins and events cannot change, nothing is deleted', async () => {
  const n = await as('nurse1');
  const set = await publishedSet(), caseId = await newCase(n), a = await applied(n, caseId, set);
  const o = (await rec(n, caseId, { appliedSetId: a.id, fieldKey: 'hr', value: 70, effectiveAt: ago(10), sourceType: 'clinician' })).body.observations[0];
  const owner = q => env.pool.query(q.replace(/\$1/g, o.id).replace(/\$2/g, a.id));   // ids inlined: they are our own integers
  for (const q of ['UPDATE observations SET value_json = \'71\'::jsonb WHERE id = $1', `UPDATE observations SET effective_at = now() WHERE id = $1`, `UPDATE observations SET recorded_at = now() WHERE id = $1`,
    `UPDATE observations SET recorded_by = 1 WHERE id = $1`, `UPDATE observations SET source_type = 'device' WHERE id = $1`, `UPDATE observations SET field_key = 'rr' WHERE id = $1`])
    await assert.rejects(owner(q), /append-only/, q);
  await assert.rejects(owner(`UPDATE observations SET status = 'final' WHERE id = $1`), /only status change/);
  await assert.rejects(owner('DELETE FROM observations'), /not allowed/);
  await assert.rejects(owner('TRUNCATE observations'), /not allowed/);
  await assert.rejects(owner('DELETE FROM case_applied_sets'), /not allowed/);
  await assert.rejects(owner('UPDATE clinical_events SET detail = \'{}\'::jsonb'), /append-only/);
  await assert.rejects(owner('DELETE FROM clinical_events'), /not allowed/);
  await assert.rejects(owner('UPDATE case_applied_sets SET element_set_version_id = element_set_version_id + 1 WHERE id = $2'), /immutable/);
  await assert.rejects(owner(`UPDATE case_applied_sets SET case_id = case_id + 1 WHERE id = $2`), /immutable/);
  // the app's own database role cannot touch value columns even by mistake
  for (const q of ['UPDATE observations SET value_json = \'71\'::jsonb WHERE id = 1', 'UPDATE observations SET effective_at = now()', 'UPDATE case_applied_sets SET element_set_version_id = 1', 'UPDATE clinical_events SET detail = \'{}\'::jsonb',
    'DELETE FROM observations', 'TRUNCATE observations', 'DELETE FROM clinical_events', 'DELETE FROM case_applied_sets'])
    await assert.rejects(env.appPool.query(q), /permission denied/, q);
  // direct inserts cannot bypass the rules either
  const ins = (extra = '', corrects = 'NULL', status = `'final'`, src = `'clinician'`, reason = 'NULL') => env.pool.query(
    `INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, effective_at, source_type, status, recorded_by, corrects_id, change_reason)
     VALUES ($1, $2, 'hr', 'number', '1'::jsonb, now(), ${src}, ${status}, 1, ${corrects}, ${reason})`, [caseId, a.id]);
  await assert.rejects(ins('', 'NULL', `'entered_in_error'`), /violates check|marking an existing row/);
  await assert.rejects(ins('', 'NULL', `'final'`, `'ai_proposed'`), /violates check/);
  await assert.rejects(ins('', 'NULL', `'amended'`), /violates check/);
  await assert.rejects(env.pool.query(`INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, effective_at, source_type, status, recorded_by) VALUES ($1,$2,'hr','number','"x"'::jsonb,now(),'clinician','final',1)`, [caseId, a.id]), /violates check/);
  await assert.rejects(env.pool.query(`INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, effective_at, source_type, status, recorded_by) VALUES ($1,$2,'rr','integer','1.5'::jsonb,now(),'clinician','final',1)`, [caseId, a.id]), /violates check/);
  // a correction of another field, and a pin of a version that is not published, are refused
  await assert.rejects(env.pool.query(`INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, effective_at, source_type, status, recorded_by, corrects_id, change_reason)
    VALUES ($1,$2,'rr','number','1'::jsonb,now(),'clinician','amended',1,$3,'x')`, [caseId, a.id, o.id]), /same case, set and field/);
  const draft = await R.doctor.post(`/api/element-sets/${set.id}/versions`, { definition: DEF });
  const vid = (await env.pool.query('SELECT id FROM element_set_versions WHERE element_set_id = $1 AND version = $2', [set.id, draft.body.version.version])).rows[0].id;
  await assert.rejects(env.pool.query(`INSERT INTO case_applied_sets(case_id, element_set_id, element_set_version_id, applied_by) VALUES ($1,$2,$3,1)`, [caseId, set.id, vid]), /only a published/);
  assert.equal(await dbCount(caseId), 1, 'nothing slipped in');
});

test('concurrent writers all succeed without loss; two people correcting the same row: exactly one wins', async () => {
  const n1 = await as('nurse1'), n2 = await as('nurse1'), d = await as('doctor1');
  const set = await publishedSet(), caseId = await newCase(n1), a = await applied(n1, caseId, set);
  const mk = (value, i) => ({ appliedSetId: a.id, fieldKey: 'hr', value, effectiveAt: ago(10 + i), sourceType: 'clinician' });
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => rec(i % 2 ? n1 : n2, caseId, mk(60 + i, i))));
  assert.deepEqual(res.map(r => r.status), Array(12).fill(201), JSON.stringify(res.map(r => r.body)));
  assert.equal(await dbCount(caseId), 12, 'no write was lost');
  assert.deepEqual((await n1.get(`/api/cases/${caseId}/timeline`)).body.observations.map(o => o.value).sort((x, y) => x - y), Array.from({ length: 12 }, (_, i) => 60 + i));
  const target = (await rec(n1, caseId, mk(200, 0))).body.observations[0];
  const fix = (c, v) => c.post(`/api/observations/${target.id}/correct`, { value: v, sourceType: 'clinician', reason: 'race' });
  const two = await Promise.all([fix(n1, 201), fix(d, 202)]);
  assert.deepEqual(two.map(r => r.status).sort(), [201, 409], JSON.stringify(two.map(r => r.body)));
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM observations WHERE corrects_id = $1', [target.id])).rows[0].n, 1);
  // a correction racing an entered-in-error mark on the same row: the case lock orders them, and a row entered in error is never corrected
  const t2 = (await rec(n1, caseId, mk(300, 0))).body.observations[0];
  const [mark, corr] = await Promise.all([n1.post(`/api/observations/${t2.id}/entered-in-error`, { reason: 'race' }), d.post(`/api/observations/${t2.id}/correct`, { value: 301, sourceType: 'clinician', reason: 'race' })]);
  assert.equal(mark.status, 200, JSON.stringify(mark.body));                 // marking works whether or not the correction came first
  assert.ok([201, 409].includes(corr.status), JSON.stringify(corr.body));
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM observations WHERE corrects_id = $1', [t2.id])).rows[0].n, corr.status === 201 ? 1 : 0);
  if (corr.status === 409) assert.equal(corr.body.error, 'entered_in_error');
});
