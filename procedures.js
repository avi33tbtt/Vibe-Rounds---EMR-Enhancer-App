'use strict';
// Task R4i-1: procedures on the server (list, get, record, cancel, entered in error). Procedures only: no scheduling, consent, billing or codes.
// The recorder, canceller and error-marker come from the session; a body that names one is refused. Nothing is suggested: the procedure name and the optional outcome note are free text as typed;
// the performed date-time must carry an offset and cannot be in the future. A move needs a reason (1..1000) and the loaded row_version (stale gives 409); entered_in_error is final.
// Procedure names, outcome notes and move reasons never go into the audit log: ids and lengths only. Reuses orders:read and orders:write. The database enforces the same rules (migration 027).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_NAME = 200, MAX_INFO = 500, MAX_REASON = 1000;
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
// A date-time with an offset (Z or +hh:mm), a real calendar moment, not in the future.
function performedAt(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number), sec = m[6] ? +m[6] : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d)); if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (m[7] !== 'Z') { const oh = +m[7].slice(1, 3), om = +m[7].slice(4, 6); if (oh > 14 || om > 59) return null; }
  const t = new Date(v); return Number.isNaN(t.getTime()) || t.getTime() > Date.now() ? null : t;
}
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);

function mountProcedures(app, pool) {
  const COLS = `o.id, o.patient_id, o.origin_case_id, o.procedure_text, o.performed_at, o.outcome_text, o.status, o.row_version,
                ru.username AS recorded_by, o.recorded_at, cu.username AS cancelled_by, o.cancelled_at, o.cancel_reason, xu.username AS error_by, o.error_at, o.error_reason`;
  const FROM = `FROM patient_procedures o JOIN users ru ON ru.id = o.recorded_by LEFT JOIN users cu ON cu.id = o.cancelled_by LEFT JOIN users xu ON xu.id = o.error_by`;
  const load = async (c, id) => {
    const procedure = (await c.query(`SELECT ${COLS} ${FROM} WHERE o.id = $1`, [id])).rows[0];
    if (procedure) procedure.events = (await c.query(`SELECT e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at FROM patient_procedure_events e JOIN users u ON u.id = e.by_user WHERE e.procedure_id = $1 ORDER BY e.seq`, [id])).rows;
    return procedure;
  };

  app.get('/api/patients/:id/procedures', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const procedures = (await pool.query(`SELECT ${COLS} ${FROM} WHERE o.patient_id = $1 ${all ? '' : `AND o.status <> 'entered_in_error'`} ORDER BY o.id`, [pid])).rows;
    await audit(pool, req, 'patient.procedures_view', 'patient', pid, { count: procedures.length, includeAll: all });
    res.json({ procedures });
  });

  app.get('/api/procedures/:id', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const procedure = await load(pool, id);
    if (!procedure) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'procedure.view', 'patient', procedure.patient_id, { procedureId: id });
    res.json({ procedure });
  });

  app.post('/api/patients/:id/procedures', A.requirePerm(pool, 'orders:write'), async (req, res) => {
    const s = strict(req.body, ['procedure', 'performedAt', 'outcome', 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id);
    if (!text(b.procedure, MAX_NAME)) return bad(res, `procedure must be 1 to ${MAX_NAME} characters.`);
    const when = performedAt(b.performedAt);
    if (!when) return bad(res, 'performedAt must be a date-time with an offset (for example 2026-11-26T09:30:00+05:45), and cannot be in the future.');
    if (b.outcome !== undefined && b.outcome !== null && !text(b.outcome, MAX_INFO)) return bad(res, `outcome must be 1 to ${MAX_INFO} characters when given.`);
    if (b.originCaseId !== undefined && b.originCaseId !== null && !posInt(b.originCaseId)) return bad(res, 'originCaseId must be a whole number.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before recording a procedure.' } };
      const origin = b.originCaseId == null ? null : b.originCaseId;
      if (origin !== null && !(await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      const id = (await c.query('INSERT INTO patient_procedures(patient_id, origin_case_id, procedure_text, performed_at, outcome_text, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [pid, origin, b.procedure.trim(), when.toISOString(), b.outcome == null ? null : b.outcome.trim(), req.user.id])).rows[0].id;
      await c.query(`INSERT INTO patient_procedure_events(procedure_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
      await audit(c, req, 'procedure.add', 'patient', pid, { procedureId: id, originCaseId: origin, procedureLength: b.procedure.trim().length, outcomeLength: b.outcome == null ? 0 : b.outcome.trim().length });
      return { status: 201, body: { procedure: await load(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  function move(kind) {
    const cancel = kind === 'cancel';
    return async (req, res) => {
      const s = strict(req.body, ['reason', 'rowVersion']);
      if (s.error) return res.status(400).json(s.error);
      const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
      if (!text(s.body.reason, MAX_REASON)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
      if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
      if (!id) return res.status(404).json({ error: 'not_found' });
      const out = await tx(pool, async c => {
        const o = (await c.query('SELECT id, patient_id, status, row_version FROM patient_procedures WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!o) return { status: 404, body: { error: 'not_found' } };
        if (o.status === 'entered_in_error') return { status: 409, body: { error: 'procedure_final', message: 'A procedure entered in error is final.', currentRowVersion: o.row_version } };
        if (o.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This procedure was changed by someone else. Reload it and try again.', currentRowVersion: o.row_version } };
        if (cancel && o.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active procedure can be cancelled.', currentRowVersion: o.row_version } };
        const reason = s.body.reason.trim(), to = cancel ? 'cancelled' : 'entered_in_error';
        if (cancel) await c.query('UPDATE patient_procedures SET status = $2, row_version = row_version + 1, cancelled_by = $3, cancelled_at = clock_timestamp(), cancel_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        else await c.query('UPDATE patient_procedures SET status = $2, row_version = row_version + 1, error_by = $3, error_at = clock_timestamp(), error_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        await c.query(`INSERT INTO patient_procedure_events(procedure_id, seq, from_status, to_status, reason, by_user) SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM patient_procedure_events WHERE procedure_id = $1`, [id, o.status, to, reason, req.user.id]);
        await audit(c, req, cancel ? 'procedure.cancel' : 'procedure.error', 'patient', o.patient_id, { procedureId: id, from: o.status, length: reason.length, rowVersion: rv + 1 });
        return { status: 200, body: { procedure: await load(c, id) } };
      });
      res.status(out.status).json(out.body);
    };
  }
  app.post('/api/procedures/:id/cancel', A.requirePerm(pool, 'orders:write'), move('cancel'));
  app.post('/api/procedures/:id/entered-in-error', A.requirePerm(pool, 'orders:write'), move('error'));
}
module.exports = { mountProcedures };
