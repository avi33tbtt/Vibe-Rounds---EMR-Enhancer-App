'use strict';
// Task B1a: persistent cases. Routes are registered straight on the app (no nested router) so the safety tests see them.
// Every actor (created_by, linked_by, author_id, archived_by) comes from the session; a body that names one is refused.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const CASE_COLS = `c.id, c.case_key, c.patient_id, c.title, c.status, c.opened_at, c.closed_at, c.archived_at, c.created_at, c.updated_at, c.row_version`;
const RELATIONS = ['opened', 'reviewed', 'follow_up', 'related'];
const EDIT_STATUS = ['active', 'resolved', 'closed'];   // 'archived' is reached only through the archive route

const bad = (res, message, extra = {}) => res.status(400).json({ error: 'invalid', message, ...extra });
// Only these body keys are accepted per route. Anything else (createdBy, userId, signedBy ...) is refused, not ignored.
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const cleanTitle = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
const rowVersionOf = v => (Number.isInteger(v) && v >= 1 && v < 2147483647 ? v : null);

function mountCases(app, pool) {
  const caseById = async (c, id, lock) =>
    (await c.query(`SELECT ${CASE_COLS} FROM clinical_cases c WHERE c.id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  const conflict = (cur) => ({ status: 409, body: { error: 'version_conflict', message: 'This case was changed by someone else. Reload it and try again.', currentRowVersion: cur.row_version } });

  /* ---------- create + list by patient ---------- */
  app.post('/api/patients/:id/cases', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['title']);
    if (s.error) return res.status(400).json(s.error);
    const title = cleanTitle(s.body.title);
    if (!title || title.length > 200) return bad(res, 'Title is required (max 200 characters).');
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before opening a case.' } };
      const ins = await c.query('INSERT INTO clinical_cases(patient_id, title, created_by) VALUES ($1,$2,$3) RETURNING id', [p.id, title, req.user.id]);
      const id = ins.rows[0].id;
      // The patient's open encounter (if any) is linked at once as the encounter this case was opened in.
      const enc = (await c.query(`SELECT id FROM encounters WHERE patient_id = $1 AND status = 'open'`, [p.id])).rows[0];
      if (enc) await c.query(`INSERT INTO case_encounters(case_id, encounter_id, patient_id, relation_type, linked_by) VALUES ($1,$2,$3,'opened',$4)`, [id, enc.id, p.id, req.user.id]);
      await audit(c, req, 'case.create', 'case', id, { patientId: p.id, linkedEncounterId: enc ? enc.id : null });
      return { status: 201, body: { case: await caseById(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  app.get('/api/patients/:id/cases', A.requirePerm(pool, 'cases:read'), async (req, res) => {
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    const { rows } = await pool.query(
      `SELECT ${CASE_COLS} FROM clinical_cases c WHERE c.patient_id = $1 ${includeArchived ? '' : `AND c.status <> 'archived'`} ORDER BY c.id DESC LIMIT 200`, [req.params.id]);
    await audit(pool, req, 'case.list', 'patient', req.params.id, { includeArchived, count: rows.length });
    res.json({ cases: rows });
  });

  /* ---------- read ---------- */
  app.get('/api/cases/:id', A.requirePerm(pool, 'cases:read'), async (req, res) => {
    const cs = await caseById(pool, req.params.id);
    if (!cs) return res.status(404).json({ error: 'not_found' });
    const encounters = (await pool.query(
      `SELECT ce.encounter_id, ce.relation_type, ce.linked_at, e.bed, e.status AS encounter_status, e.opened_at, e.closed_at
         FROM case_encounters ce JOIN encounters e ON e.id = ce.encounter_id WHERE ce.case_id = $1 ORDER BY ce.id`, [cs.id])).rows;
    const narrative = (await pool.query(
      `SELECT n.id, n.body, n.created_at, u.username AS author FROM case_narrative_entries n JOIN users u ON u.id = n.author_id
        WHERE n.case_id = $1 ORDER BY n.id DESC LIMIT 1`, [cs.id])).rows[0] || null;
    await audit(pool, req, 'case.view', 'case', cs.id, { patientId: cs.patient_id });
    res.json({ case: cs, encounters, narrative });
  });

  /* ---------- update title / status (optimistic: rowVersion must match) ---------- */
  app.patch('/api/cases/:id', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['title', 'status', 'rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, rv = rowVersionOf(b.rowVersion);
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (b.title === undefined && b.status === undefined) return bad(res, 'Send a title or a status to change.');
    let title;
    if (b.title !== undefined) { title = cleanTitle(b.title); if (!title || title.length > 200) return bad(res, 'Title is required (max 200 characters).'); }
    if (b.status !== undefined && !EDIT_STATUS.includes(b.status)) return bad(res, 'Status must be active, resolved or closed. Use the archive route to archive.');
    const out = await tx(pool, async c => {
      const cur = await caseById(c, req.params.id, true);
      if (!cur) return { status: 404, body: { error: 'not_found' } };
      if (cur.status === 'archived') return { status: 409, body: { error: 'case_archived', message: 'Restore the case before changing it.' } };
      if (cur.row_version !== rv) {
        await audit(c, req, 'case.update_rejected', 'case', cur.id, { reason: 'version_conflict', sent: rv, current: cur.row_version });
        return conflict(cur);
      }
      const status = b.status === undefined ? cur.status : b.status;
      const closedAt = status === 'closed' ? (cur.status === 'closed' ? cur.closed_at : new Date()) : null;
      await c.query(`UPDATE clinical_cases SET title = $2, status = $3, closed_at = $4, updated_at = now(), row_version = row_version + 1 WHERE id = $1`,
        [cur.id, title === undefined ? cur.title : title, status, closedAt]);
      await audit(c, req, 'case.update', 'case', cur.id, { fields: [title !== undefined && 'title', b.status !== undefined && 'status'].filter(Boolean), from: cur.status, to: status });
      return { status: 200, body: { case: await caseById(c, cur.id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- archive / restore (never delete) ---------- */
  app.patch('/api/cases/:id/archive', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['archived', 'rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const rv = rowVersionOf(s.body.rowVersion);
    if (typeof s.body.archived !== 'boolean') return bad(res, 'archived must be true or false.');
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    const archived = s.body.archived;
    const out = await tx(pool, async c => {
      const cur = await caseById(c, req.params.id, true);
      if (!cur) return { status: 404, body: { error: 'not_found' } };
      if (cur.row_version !== rv) {
        await audit(c, req, 'case.update_rejected', 'case', cur.id, { reason: 'version_conflict', sent: rv, current: cur.row_version });
        return conflict(cur);
      }
      if (archived === (cur.status === 'archived')) return { status: 409, body: { error: archived ? 'already_archived' : 'not_archived', message: archived ? 'This case is already archived.' : 'This case is not archived.' } };
      await c.query(
        `UPDATE clinical_cases SET status = $2, closed_at = NULL, archived_at = CASE WHEN $3 THEN now() END, archived_by = CASE WHEN $3 THEN $4::int END,
                updated_at = now(), row_version = row_version + 1 WHERE id = $1`,
        [cur.id, archived ? 'archived' : 'active', archived, req.user.id]);
      await audit(c, req, archived ? 'case.archive' : 'case.restore', 'case', cur.id, { patientId: cur.patient_id, from: cur.status });
      return { status: 200, body: { case: await caseById(c, cur.id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- link an encounter ---------- */
  app.post('/api/cases/:id/encounters', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['encounterId', 'relationType']);
    if (s.error) return res.status(400).json(s.error);
    const eid = s.body.encounterId, rel = s.body.relationType === undefined ? 'related' : s.body.relationType;
    if (!Number.isInteger(eid) || eid < 1 || eid > 2147483646) return bad(res, 'encounterId must be a whole number.');
    if (!RELATIONS.includes(rel)) return bad(res, 'relationType must be one of: ' + RELATIONS.join(', '));
    const out = await tx(pool, async c => {
      const cs = await caseById(c, req.params.id, true);
      if (!cs) return { status: 404, body: { error: 'not_found' } };
      if (cs.status === 'archived') return { status: 409, body: { error: 'case_archived', message: 'Restore the case before linking an encounter.' } };
      const enc = (await c.query('SELECT id, patient_id FROM encounters WHERE id = $1', [eid])).rows[0];
      if (!enc) return { status: 404, body: { error: 'encounter_not_found' } };
      if (enc.patient_id !== cs.patient_id) {
        await audit(c, req, 'case.link_rejected', 'case', cs.id, { reason: 'encounter_other_patient', encounterId: eid });
        return { status: 409, body: { error: 'encounter_other_patient', message: 'That encounter belongs to a different patient.' } };
      }
      const dup = (await c.query('SELECT 1 FROM case_encounters WHERE case_id = $1 AND encounter_id = $2', [cs.id, eid])).rowCount;
      if (dup) return { status: 409, body: { error: 'already_linked', message: 'That encounter is already linked to this case.' } };
      await c.query('INSERT INTO case_encounters(case_id, encounter_id, patient_id, relation_type, linked_by) VALUES ($1,$2,$3,$4,$5)', [cs.id, eid, cs.patient_id, rel, req.user.id]);
      await c.query('UPDATE clinical_cases SET updated_at = now() WHERE id = $1', [cs.id]);
      await audit(c, req, 'case.link_encounter', 'case', cs.id, { encounterId: eid, relationType: rel });
      return { status: 201, body: { link: { caseId: cs.id, encounterId: eid, relationType: rel } } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- narrative (append-only; the latest entry is the current text) ---------- */
  app.post('/api/cases/:id/narrative', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['body']);
    if (s.error) return res.status(400).json(s.error);
    const text = typeof s.body.body === 'string' ? s.body.body.trim() : '';
    if (!text || text.length > 20000) return bad(res, 'Narrative text is required (max 20000 characters).');
    const out = await tx(pool, async c => {
      const cs = await caseById(c, req.params.id, true);
      if (!cs) return { status: 404, body: { error: 'not_found' } };
      if (cs.status === 'archived') return { status: 409, body: { error: 'case_archived', message: 'Restore the case before adding to it.' } };
      const ins = await c.query('INSERT INTO case_narrative_entries(case_id, body, author_id) VALUES ($1,$2,$3) RETURNING id, created_at', [cs.id, text, req.user.id]);
      await c.query('UPDATE clinical_cases SET updated_at = now() WHERE id = $1', [cs.id]);
      await audit(c, req, 'case.narrative_add', 'case', cs.id, { entryId: ins.rows[0].id, length: text.length });   // length only: the text never goes into the audit log
      return { status: 201, body: { narrative: { id: ins.rows[0].id, body: text, created_at: ins.rows[0].created_at, author: req.user.username } } };
    });
    res.status(out.status).json(out.body);
  });
}

module.exports = { mountCases };
