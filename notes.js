'use strict';
// Task B3c-1: clinical notes and signing, on the server.
// Routes are registered straight on the app (no nested router) so the safety tests see them.
// Author, signer and amender come from the session; a body that names one is refused.
// A draft is edited with the row_version that was loaded; a stale edit gets 409. Only the author edits, signs or discards a draft.
// A signed note never changes (the database refuses it too, migration 012): a change is an amendment with a reason, and the original text stays.
// A discarded draft is kept. Note text never goes into the audit log: ids and lengths only.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_BODY = 20000;
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;   // NUL and lone surrogates
const bad = (res, message, extra = {}) => res.status(400).json({ error: 'invalid', message, ...extra });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const isStr = v => typeof v === 'string';
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const okText = (v, max) => isStr(v) && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);

function mountNotes(app, pool) {
  const lockCase = async (c, id) => (await c.query('SELECT id, patient_id, status FROM clinical_cases WHERE id = $1 FOR UPDATE', [id])).rows[0];
  const notFound = { status: 404, body: { error: 'not_found' } };
  const archived = { status: 409, body: { error: 'case_archived', message: 'Restore the case before changing it.' } };
  const touch = (c, caseId) => c.query('UPDATE clinical_cases SET updated_at = now() WHERE id = $1', [caseId]);
  const NOTE = `n.id, n.case_id, n.encounter_id, n.status, n.body, n.row_version, n.created_at, n.updated_at, au.username AS author,
                su.username AS signed_by, n.signed_at, du.username AS discarded_by, n.discarded_at`;
  const NOTE_FROM = `FROM case_notes n JOIN users au ON au.id = n.author_id LEFT JOIN users su ON su.id = n.signed_by LEFT JOIN users du ON du.id = n.discarded_by`;
  const AMEND = `m.id, m.note_id, m.seq, m.reason, m.body, m.amended_at, u.username AS amended_by`;
  const AMEND_FROM = `FROM case_note_amendments m JOIN users u ON u.id = m.amended_by`;
  // A note with its amendments (oldest first). `body` stays the original text; `currentBody` is the text after the last amendment.
  const withAmendments = (notes, amends) => notes.map(n => {
    const list = amends.filter(m => m.note_id === n.id).map(({ note_id, ...m }) => m);
    return { ...n, amendments: list, amendmentCount: list.length, currentBody: list.length ? list[list.length - 1].body : n.body };
  });
  const noteOf = async (c, id) => {
    const n = (await c.query(`SELECT ${NOTE} ${NOTE_FROM} WHERE n.id = $1`, [id])).rows;
    const m = (await c.query(`SELECT ${AMEND} ${AMEND_FROM} WHERE m.note_id = $1 ORDER BY m.seq`, [id])).rows;
    return withAmendments(n, m)[0];
  };
  const conflict = (cur) => ({ status: 409, body: { error: 'version_conflict', message: 'This note was changed by someone else. Reload it and try again.', currentRowVersion: cur.row_version } });

  // Shared start of the edit, sign and discard routes: the case is locked first (one lock order everywhere), then the note.
  async function loadDraft(c, req, rv) {
    const probe = (await c.query('SELECT case_id FROM case_notes WHERE id = $1', [req.params.id])).rows[0];
    if (!probe) return { out: notFound };
    const cs = await lockCase(c, probe.case_id);
    if (cs.status === 'archived') return { out: archived };
    const n = (await c.query('SELECT id, case_id, author_id, status, row_version FROM case_notes WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (n.status !== 'draft') return { out: { status: 409, body: { error: 'not_draft', message: `This note is ${n.status}.` + (n.status === 'signed' ? ' A signed note is changed by an amendment, with a reason.' : '') } } };
    if (n.author_id !== req.user.id) {
      await audit(c, req, 'note.refused', 'case', cs.id, { noteId: n.id, reason: 'not_author' });
      return { out: { status: 403, body: { error: 'not_author', message: 'Only the author can change, sign or discard a draft.' } } };
    }
    if (n.row_version !== rv) {
      await audit(c, req, 'note.update_rejected', 'case', cs.id, { noteId: n.id, reason: 'version_conflict', sent: rv, current: n.row_version });
      return { out: conflict(n) };
    }
    return { cs, n };
  }

  /* ---------- list the notes of a case, with their amendments ---------- */
  app.get('/api/cases/:id/notes', A.requirePerm(pool, 'cases:read'), async (req, res) => {
    const cs = (await pool.query('SELECT id, patient_id FROM clinical_cases WHERE id = $1', [req.params.id])).rows[0];
    if (!cs) return res.status(404).json({ error: 'not_found' });
    const notes = (await pool.query(`SELECT ${NOTE} ${NOTE_FROM} WHERE n.case_id = $1 ORDER BY n.id`, [cs.id])).rows;
    const amends = (await pool.query(`SELECT ${AMEND} ${AMEND_FROM} JOIN case_notes n ON n.id = m.note_id WHERE n.case_id = $1 ORDER BY m.note_id, m.seq`, [cs.id])).rows;
    await audit(pool, req, 'case.notes_view', 'case', cs.id, { patientId: cs.patient_id, count: notes.length });
    res.json({ notes: withAmendments(notes, amends) });
  });

  /* ---------- start a draft ---------- */
  app.post('/api/cases/:id/notes', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['body', 'encounterId']);
    if (s.error) return res.status(400).json(s.error);
    if (!okText(s.body.body, MAX_BODY)) return bad(res, `The note must be text of 1 to ${MAX_BODY} characters.`);
    if (s.body.encounterId !== undefined && !posInt(s.body.encounterId)) return bad(res, 'encounterId must be a whole number.');
    const out = await tx(pool, async c => {
      const cs = await lockCase(c, req.params.id);
      if (!cs) return notFound;
      if (cs.status === 'archived') return archived;
      let enc = null;
      if (s.body.encounterId !== undefined) {
        const link = (await c.query('SELECT 1 FROM case_encounters WHERE case_id = $1 AND encounter_id = $2', [cs.id, s.body.encounterId])).rowCount;
        if (!link) return { status: 400, body: { error: 'encounter_not_linked', message: 'That encounter is not linked to this case.' } };
        enc = s.body.encounterId;
      } else {   // like the clinical timeline: the case's open linked encounter at this moment, if there is one
        const open = (await c.query(`SELECT ce.encounter_id FROM case_encounters ce JOIN encounters e ON e.id = ce.encounter_id
                                      WHERE ce.case_id = $1 AND e.status = 'open' ORDER BY ce.id DESC LIMIT 1`, [cs.id])).rows[0];
        enc = open ? open.encounter_id : null;
      }
      const id = (await c.query('INSERT INTO case_notes(case_id, encounter_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING id', [cs.id, enc, req.user.id, s.body.body])).rows[0].id;
      await touch(c, cs.id);
      await audit(c, req, 'note.create', 'case', cs.id, { noteId: id, length: s.body.body.length });
      return { status: 201, body: { note: await noteOf(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- edit a draft (the version that was loaded must still be current) ---------- */
  app.patch('/api/notes/:id', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['body', 'rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
    if (!id) return bad(res, 'The note id must be a whole number.');
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (!okText(s.body.body, MAX_BODY)) return bad(res, `The note must be text of 1 to ${MAX_BODY} characters.`);
    const out = await tx(pool, async c => {
      const d = await loadDraft(c, req, rv);
      if (d.out) return d.out;
      await c.query('UPDATE case_notes SET body = $2, row_version = row_version + 1 WHERE id = $1', [d.n.id, s.body.body]);
      await touch(c, d.cs.id);
      await audit(c, req, 'note.update', 'case', d.cs.id, { noteId: d.n.id, length: s.body.body.length, rowVersion: rv + 1 });
      return { status: 200, body: { note: await noteOf(c, d.n.id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- discard a draft: it is kept, marked, and hidden by the page ---------- */
  app.post('/api/notes/:id/discard', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
    if (!id) return bad(res, 'The note id must be a whole number.');
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    const out = await tx(pool, async c => {
      const d = await loadDraft(c, req, rv);
      if (d.out) return d.out;
      await c.query(`UPDATE case_notes SET status = 'discarded', discarded_by = $2, discarded_at = clock_timestamp(), row_version = row_version + 1 WHERE id = $1`, [d.n.id, req.user.id]);
      await touch(c, d.cs.id);
      await audit(c, req, 'note.discard', 'case', d.cs.id, { noteId: d.n.id });
      return { status: 200, body: { note: await noteOf(c, d.n.id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- sign a draft: the signer is the signed-in author, the text is the version that was loaded ---------- */
  app.post('/api/notes/:id/sign', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
    if (!id) return bad(res, 'The note id must be a whole number.');
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    const out = await tx(pool, async c => {
      const d = await loadDraft(c, req, rv);
      if (d.out) return d.out;
      await c.query(`UPDATE case_notes SET status = 'signed', signed_by = $2, signed_at = clock_timestamp(), row_version = row_version + 1 WHERE id = $1`, [d.n.id, req.user.id]);
      await touch(c, d.cs.id);
      await audit(c, req, 'note.sign', 'case', d.cs.id, { noteId: d.n.id });
      return { status: 200, body: { note: await noteOf(c, d.n.id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- amend a signed note: a new row with a reason; the original stays; amendmentCount is how many the sender has seen ---------- */
  app.post('/api/notes/:id/amend', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['body', 'reason', 'amendmentCount']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), seen = s.body.amendmentCount;
    if (!id) return bad(res, 'The note id must be a whole number.');
    if (!Number.isInteger(seen) || seen < 0 || seen > 100000) return bad(res, 'amendmentCount is required (how many amendments you have seen; 0 for none).');
    const reason = isStr(s.body.reason) ? s.body.reason.trim() : '';
    if (!reason || reason.length > 1000 || BAD_CHARS.test(reason)) return bad(res, 'A reason is required (1 to 1000 characters).');
    if (!okText(s.body.body, MAX_BODY)) return bad(res, `The amended note must be text of 1 to ${MAX_BODY} characters.`);
    const out = await tx(pool, async c => {
      const probe = (await c.query('SELECT case_id FROM case_notes WHERE id = $1', [id])).rows[0];
      if (!probe) return notFound;
      const cs = await lockCase(c, probe.case_id);
      if (cs.status === 'archived') return archived;
      const n = (await c.query('SELECT id, status, body FROM case_notes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (n.status !== 'signed') return { status: 409, body: { error: 'not_signed', message: n.status === 'draft' ? 'Only a signed note is amended; edit and sign the draft instead.' : 'A discarded draft cannot be amended.' } };
      const last = (await c.query('SELECT seq, body FROM case_note_amendments WHERE note_id = $1 ORDER BY seq DESC LIMIT 1', [n.id])).rows[0];
      const count = last ? last.seq : 0;
      if (count !== seen) {
        await audit(c, req, 'note.update_rejected', 'case', cs.id, { noteId: n.id, reason: 'version_conflict', sent: seen, current: count });
        return { status: 409, body: { error: 'version_conflict', message: 'This note was amended by someone else. Reload it and try again.', currentAmendmentCount: count } };
      }
      if (s.body.body === (last ? last.body : n.body)) return { status: 400, body: { error: 'unchanged', message: 'The amended text is the same as the current text.' } };
      await c.query('INSERT INTO case_note_amendments(note_id, seq, reason, body, amended_by) VALUES ($1,$2,$3,$4,$5)', [n.id, count + 1, reason, s.body.body, req.user.id]);
      await touch(c, cs.id);
      await audit(c, req, 'note.amend', 'case', cs.id, { noteId: n.id, seq: count + 1, reasonLength: reason.length, length: s.body.body.length });
      return { status: 201, body: { note: await noteOf(c, n.id) } };
    });
    res.status(out.status).json(out.body);
  });
}

module.exports = { mountNotes };
