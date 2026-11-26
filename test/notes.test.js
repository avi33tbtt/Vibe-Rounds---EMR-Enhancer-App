'use strict';
// Task B3c-1: notes and signing on the server. Matrix and audit scenarios are in safety-routes.test.js;
// the "never deleted" classification is in safety-data.test.js; the stale-version race is in safety-concurrency.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, seq = 0;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };   // a fresh session per test keeps clear of the per-session write limit
async function newCase(c, { encounter = false } = {}) {
  const p = await c.post('/api/patients', { name: 'Note Patient ' + (++seq), mrn: 'NOTE-' + seq, dob: '1980-01-01', sex: 'F' });
  assert.equal(p.status, 201);
  if (encounter) assert.equal((await c.post(`/api/patients/${p.body.patient.id}/encounters`, { bed: 'N-' + seq })).status, 201);
  const k = await c.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Note case' });
  assert.equal(k.status, 201);
  return k.body.case.id;
}
const draft = async (c, caseId, body = 'Seen at bedside.') => { const r = await c.post(`/api/cases/${caseId}/notes`, { body }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.note; };
const row = async id => (await env.pool.query('SELECT * FROM case_notes WHERE id = $1', [id])).rows[0];
const asApp = (sql, p) => env.appPool.query(sql, p);   // the restricted role the app really runs as

test('draft: the author is the signed-in user; a body that names an author, status or signer is refused; the open encounter is linked', async () => {
  const n = await as('nurse1'), caseId = await newCase(n, { encounter: true });
  for (const extra of [{ authorId: 2 }, { author: 'doctor1' }, { status: 'signed' }, { signedBy: 'doctor1' }]) {
    const r = await n.post(`/api/cases/${caseId}/notes`, { body: 'x', ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.error, 'unknown_field');
  }
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM case_notes WHERE case_id = $1', [caseId])).rows[0].n, 0);
  const note = await draft(n, caseId, 'First note');
  assert.equal(note.author, 'nurse1'); assert.equal(note.status, 'draft'); assert.equal(note.row_version, 1);
  assert.equal(note.signed_by, null); assert.ok(note.encounter_id, 'linked to the open encounter');
  for (const bad of ['', '   ', 5, null, 'x'.repeat(20001), 'a\u0000b']) assert.equal((await n.post(`/api/cases/${caseId}/notes`, { body: bad })).status, 400, String(bad).slice(0, 10));
  assert.equal((await n.post(`/api/cases/${caseId}/notes`, { body: 'x', encounterId: 999999 })).body.error, 'encounter_not_linked');
  assert.equal((await n.post('/api/cases/999999/notes', { body: 'x' })).status, 404);
});

test('list: everyone who can read cases sees the notes; the audit log keeps ids and lengths, never the text', async () => {
  const n = await as('nurse1'), v = await as('viewer1'), caseId = await newCase(n);
  await draft(n, caseId, 'SECRET-NOTE-TEXT-123');
  const r = await v.get(`/api/cases/${caseId}/notes`);
  assert.equal(r.status, 200); assert.equal(r.body.notes.length, 1); assert.equal(r.body.notes[0].body, 'SECRET-NOTE-TEXT-123');
  assert.equal((await v.post(`/api/cases/${caseId}/notes`, { body: 'x' })).status, 403);
  assert.equal((await v.get('/api/cases/999999/notes')).status, 404);
  const logged = (await env.pool.query(`SELECT detail::text d FROM audit_log WHERE action LIKE 'note.%' OR action = 'case.notes_view'`)).rows.map(x => x.d).join(' ');
  assert.doesNotMatch(logged, /SECRET-NOTE-TEXT/);
});

test('edit: only the author; a stale rowVersion gets 409 and changes nothing; the version goes up by one', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), caseId = await newCase(n);
  const note = await draft(n, caseId, 'v1');
  assert.equal((await d.patch(`/api/notes/${note.id}`, { body: 'hijack', rowVersion: 1 })).body.error, 'not_author');
  assert.equal((await d.post(`/api/notes/${note.id}/sign`, { rowVersion: 1 })).status, 403, 'only the author signs');
  assert.equal((await d.post(`/api/notes/${note.id}/discard`, { rowVersion: 1 })).status, 403);
  const e = await n.patch(`/api/notes/${note.id}`, { body: 'v2', rowVersion: 1 });
  assert.equal(e.status, 200); assert.equal(e.body.note.row_version, 2); assert.equal(e.body.note.body, 'v2');
  const stale = await n.patch(`/api/notes/${note.id}`, { body: 'stale', rowVersion: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'version_conflict'); assert.equal(stale.body.currentRowVersion, 2);
  assert.equal((await row(note.id)).body, 'v2');
  for (const b of [{ body: 'x' }, { body: 'x', rowVersion: 0 }, { body: 'x', rowVersion: '2' }, { rowVersion: 2 }, { body: ' ', rowVersion: 2 }, { body: 'x', rowVersion: 2, authorId: 1 }])
    assert.equal((await n.patch(`/api/notes/${note.id}`, b)).status, 400, JSON.stringify(b));
  assert.equal((await n.patch('/api/notes/999999', { body: 'x', rowVersion: 1 })).status, 404);
  const rej = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'note.update_rejected' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(rej.detail.reason, 'version_conflict');
});

test('sign: the signer is the signed-in author; a signed note cannot be edited, signed again or discarded by any route', async () => {
  const n = await as('nurse1'), caseId = await newCase(n), note = await draft(n, caseId, 'To sign');
  assert.equal((await n.post(`/api/notes/${note.id}/sign`, { rowVersion: 1, signedBy: 'doctor1' })).body.error, 'unknown_field', 'a typed signer is refused');
  assert.equal((await n.post(`/api/notes/${note.id}/sign`, {})).status, 400, 'rowVersion is required');
  assert.equal((await n.post(`/api/notes/${note.id}/sign`, { rowVersion: 5 })).status, 409, 'signing a stale version is refused');
  const s = await n.post(`/api/notes/${note.id}/sign`, { rowVersion: 1 });
  assert.equal(s.status, 200); assert.equal(s.body.note.status, 'signed'); assert.equal(s.body.note.signed_by, 'nurse1'); assert.ok(s.body.note.signed_at);
  const before = await row(note.id);
  for (const [m, p, b] of [['patch', `/api/notes/${note.id}`, { body: 'changed', rowVersion: 2 }], ['post', `/api/notes/${note.id}/sign`, { rowVersion: 2 }], ['post', `/api/notes/${note.id}/discard`, { rowVersion: 2 }]]) {
    const r = await n[m](p, b); assert.equal(r.status, 409, p); assert.equal(r.body.error, 'not_draft');
  }
  assert.deepEqual(await row(note.id), before, 'the signed row did not change');
});

test('discard: the draft is kept and marked, with who and when; it cannot be edited or signed afterwards', async () => {
  const n = await as('nurse1'), caseId = await newCase(n), note = await draft(n, caseId, 'Wrong patient');
  const r = await n.post(`/api/notes/${note.id}/discard`, { rowVersion: 1 });
  assert.equal(r.status, 200); assert.equal(r.body.note.status, 'discarded'); assert.equal(r.body.note.discarded_by, 'nurse1');
  assert.equal((await row(note.id)).body, 'Wrong patient', 'the text is kept');
  assert.equal((await n.get(`/api/cases/${caseId}/notes`)).body.notes[0].status, 'discarded');
  assert.equal((await n.patch(`/api/notes/${note.id}`, { body: 'x', rowVersion: 2 })).body.error, 'not_draft');
  assert.equal((await n.post(`/api/notes/${note.id}/sign`, { rowVersion: 2 })).body.error, 'not_draft');
  assert.equal((await n.post(`/api/notes/${note.id}/amend`, { body: 'x', reason: 'r', amendmentCount: 0 })).body.error, 'not_signed');
});

test('amend: a reason is required, the original stays, anyone who can write cases may amend, and the amender is the session', async () => {
  const n = await as('nurse1'), d = await as('doctor1'), caseId = await newCase(n), note = await draft(n, caseId, 'Original text');
  assert.equal((await d.post(`/api/notes/${note.id}/amend`, { body: 'New', reason: 'r', amendmentCount: 0 })).body.error, 'not_signed', 'a draft is edited, not amended');
  assert.equal((await n.post(`/api/notes/${note.id}/sign`, { rowVersion: 1 })).status, 200);
  for (const b of [{ body: 'New', amendmentCount: 0 }, { body: 'New', reason: '  ', amendmentCount: 0 }, { body: 'New', reason: 'r' }, { body: ' ', reason: 'r', amendmentCount: 0 },
                   { body: 'New', reason: 'r', amendmentCount: 0, amendedBy: 'x' }, { body: 'New', reason: 'x'.repeat(1001), amendmentCount: 0 }])
    assert.equal((await d.post(`/api/notes/${note.id}/amend`, b)).status, 400, JSON.stringify(b).slice(0, 60));
  assert.equal((await d.post(`/api/notes/${note.id}/amend`, { body: 'Original text', reason: 'same', amendmentCount: 0 })).body.error, 'unchanged');
  const a1 = await d.post(`/api/notes/${note.id}/amend`, { body: 'Corrected text', reason: 'Wrong side recorded', amendmentCount: 0 });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.note.body, 'Original text', 'the original stays'); assert.equal(a1.body.note.currentBody, 'Corrected text');
  assert.deepEqual(a1.body.note.amendments.map(m => [m.seq, m.reason, m.amended_by]), [[1, 'Wrong side recorded', 'doctor1']]);
  const stale = await d.post(`/api/notes/${note.id}/amend`, { body: 'Another', reason: 'late', amendmentCount: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.body.currentAmendmentCount, 1);
  const a2 = await n.post(`/api/notes/${note.id}/amend`, { body: 'Corrected again', reason: 'Typo', amendmentCount: 1 });
  assert.equal(a2.status, 201); assert.equal(a2.body.note.amendmentCount, 2); assert.equal(a2.body.note.currentBody, 'Corrected again');
  const listed = (await n.get(`/api/cases/${caseId}/notes`)).body.notes[0];
  assert.equal(listed.body, 'Original text'); assert.deepEqual(listed.amendments.map(m => m.seq), [1, 2]);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM case_note_amendments WHERE note_id = $1', [note.id])).rows[0].n, 2);
});

test('archived case: no note can be started, edited, signed or amended until the case is restored', async () => {
  const n = await as('nurse1'), caseId = await newCase(n), a = await draft(n, caseId, 'a'), b = await draft(n, caseId, 'b');
  assert.equal((await n.post(`/api/notes/${b.id}/sign`, { rowVersion: 1 })).status, 200);
  const cur = (await n.get(`/api/cases/${caseId}`)).body.case;
  assert.equal((await n.patch(`/api/cases/${caseId}/archive`, { archived: true, rowVersion: cur.row_version })).status, 200);
  assert.equal((await n.post(`/api/cases/${caseId}/notes`, { body: 'x' })).body.error, 'case_archived');
  assert.equal((await n.patch(`/api/notes/${a.id}`, { body: 'x', rowVersion: 1 })).body.error, 'case_archived');
  assert.equal((await n.post(`/api/notes/${a.id}/sign`, { rowVersion: 1 })).body.error, 'case_archived');
  assert.equal((await n.post(`/api/notes/${b.id}/amend`, { body: 'x', reason: 'r', amendmentCount: 0 })).body.error, 'case_archived');
  assert.equal((await n.get(`/api/cases/${caseId}/notes`)).body.notes.length, 2, 'reading still works');
});

test('database: a signed note refuses every UPDATE and DELETE, even for the table owner; amendments are append-only; only the author can be the signer', async () => {
  const n = await as('nurse1'), caseId = await newCase(n), note = await draft(n, caseId, 'DB rules');
  const nurseId = (await env.pool.query(`SELECT id FROM users WHERE username = 'nurse1'`)).rows[0].id;
  const doctorId = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  // a draft cannot be signed by someone else, signed without a signer, or have its version skipped
  await assert.rejects(env.pool.query(`UPDATE case_notes SET status = 'signed', signed_by = $2, signed_at = now(), row_version = 2 WHERE id = $1`, [note.id, doctorId]), /check constraint/);
  await assert.rejects(env.pool.query(`UPDATE case_notes SET status = 'signed', row_version = 2 WHERE id = $1`, [note.id]), /check constraint/);
  await assert.rejects(env.pool.query(`UPDATE case_notes SET body = 'x', row_version = 9 WHERE id = $1`, [note.id]), /row_version must advance/);
  await assert.rejects(env.pool.query(`UPDATE case_notes SET author_id = $2, row_version = 2 WHERE id = $1`, [note.id, doctorId]), /cannot be changed/);
  await assert.rejects(env.pool.query(`UPDATE case_notes SET status = 'signed', signed_by = $2, signed_at = now(), body = 'swapped', row_version = 2 WHERE id = $1`, [note.id, nurseId]), /exactly as it was last saved/);
  await assert.rejects(env.pool.query(`INSERT INTO case_notes(case_id, author_id, body, status, signed_by, signed_at) VALUES ($1,$2,'x','signed',$2,now())`, [caseId, nurseId]), /starts as a draft/);
  assert.equal((await n.post(`/api/notes/${note.id}/sign`, { rowVersion: 1 })).status, 200);
  for (const sql of [`UPDATE case_notes SET body = 'tampered' WHERE id = $1`, `UPDATE case_notes SET status = 'draft', signed_by = NULL, signed_at = NULL, row_version = 3 WHERE id = $1`,
                     `UPDATE case_notes SET signed_by = ${doctorId} WHERE id = $1`])
    await assert.rejects(env.pool.query(sql, [note.id]), /cannot be changed/, sql);
  await assert.rejects(env.pool.query('DELETE FROM case_notes WHERE id = $1', [note.id]), /not allowed/);
  await assert.rejects(env.pool.query('TRUNCATE case_notes'), /not allowed|foreign key/);
  // the restricted role the app runs as: no DELETE and no TRUNCATE grant at all, and no UPDATE of the author or text of a signed row
  await assert.rejects(asApp('DELETE FROM case_notes WHERE id = $1', [note.id]), /permission denied|not allowed/);
  await assert.rejects(asApp('TRUNCATE case_notes'), /permission denied/);
  await assert.rejects(asApp(`UPDATE case_notes SET author_id = $2 WHERE id = $1`, [note.id, doctorId]), /permission denied/);
  // amendments: only on a signed note, numbered in order, never changed or deleted
  const draft2 = await draft(n, caseId, 'still a draft');
  await assert.rejects(env.pool.query(`INSERT INTO case_note_amendments(note_id, seq, reason, body, amended_by) VALUES ($1,1,'r','b',$2)`, [draft2.id, nurseId]), /only a signed note is amended/);
  await assert.rejects(env.pool.query(`INSERT INTO case_note_amendments(note_id, seq, reason, body, amended_by) VALUES ($1,2,'r','b',$2)`, [note.id, nurseId]), /one after the other/);
  await assert.rejects(env.pool.query(`INSERT INTO case_note_amendments(note_id, seq, reason, body, amended_by) VALUES ($1,1,'  ','b',$2)`, [note.id, nurseId]), /check constraint/);
  assert.equal((await n.post(`/api/notes/${note.id}/amend`, { body: 'Amended', reason: 'Because', amendmentCount: 0 })).status, 201);
  await assert.rejects(env.pool.query(`UPDATE case_note_amendments SET reason = 'edited'`), /not allowed/);
  await assert.rejects(env.pool.query(`DELETE FROM case_note_amendments`), /not allowed/);
  await assert.rejects(asApp(`UPDATE case_note_amendments SET reason = 'edited'`), /permission denied/);
});

test('R5c-1: a note has a type (general by default, or progress), chosen when it is started; anything else is refused; the type survives signing and amending and is audited without the text', async () => {
  const d = await as('doctor1'), caseId = await newCase(d);
  const g = await draft(d, caseId, 'No type given'); assert.equal(g.type, 'general');
  const r = await d.post(`/api/cases/${caseId}/notes`, { body: 'Ward round: afebrile', type: 'progress' });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.note.type, 'progress');
  for (const bad of ['', 'PROGRESS', 'discharge', 5, null, ['progress']]) {
    const x = await d.post(`/api/cases/${caseId}/notes`, { body: 'x', type: bad });
    assert.equal(x.status, 400, JSON.stringify(bad)); assert.equal(x.body.error, 'invalid');
  }
  const id = r.body.note.id;
  const edit = await d.patch(`/api/notes/${id}`, { body: 'Ward round: afebrile, eating', rowVersion: 1 }); assert.equal(edit.status, 200); assert.equal(edit.body.note.type, 'progress');
  assert.equal((await d.patch(`/api/notes/${id}`, { body: 'x', rowVersion: 2, type: 'general' })).body.error, 'unknown_field', 'the type cannot be sent on an edit');
  const sign = await d.post(`/api/notes/${id}/sign`, { rowVersion: 2 }); assert.equal(sign.status, 200); assert.equal(sign.body.note.type, 'progress');
  const am = await d.post(`/api/notes/${id}/amend`, { body: 'Ward round: afebrile, eating well', reason: 'Added detail', amendmentCount: 0 }); assert.equal(am.status, 201); assert.equal(am.body.note.type, 'progress');
  const list = (await d.get(`/api/cases/${caseId}/notes`)).body.notes;
  assert.deepEqual(list.map(n => n.type), ['general', 'progress']);
  const a = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'note.create' AND detail->>'noteId' = $1`, [String(id)])).rows[0];
  assert.equal(a.detail.type, 'progress'); assert.ok(!JSON.stringify(a.detail).includes('Ward round'), 'no note text in the audit log');
});

test('R5c-1: the database refuses a change of note type (owner and app role), for a draft and for a signed note; a bad type is refused by the table', async () => {
  const d = await as('doctor1'), caseId = await newCase(d);
  const n = await draft(d, caseId, 'Typed note');
  await assert.rejects(env.pool.query(`UPDATE case_notes SET note_type = 'progress', row_version = row_version + 1 WHERE id = $1`, [n.id]), /type of a note cannot be changed/);
  await assert.rejects(asApp(`UPDATE case_notes SET note_type = 'progress' WHERE id = $1`, [n.id]), /permission denied/);
  await assert.rejects(env.pool.query(`INSERT INTO case_notes(case_id, author_id, body, note_type) VALUES ($1, $2, 'x', 'discharge')`, [caseId, (await row(n.id)).author_id]), /note_type|check/i);
  assert.equal((await d.post(`/api/notes/${n.id}/sign`, { rowVersion: 1 })).status, 200);
  await assert.rejects(env.pool.query(`UPDATE case_notes SET note_type = 'progress' WHERE id = $1`, [n.id]), /cannot be changed/);
  assert.equal((await row(n.id)).note_type, 'general');
});
