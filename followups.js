'use strict';
// Task R5f-2: follow-up after discharge on the server (list, get, add, cancel, entered in error). A plan only: no booking, reminders or tasks.
// A follow-up is added to a DISCHARGED admission of the patient. The recorder, canceller and error-marker come from the session; a body that names one is refused.
// Nothing is suggested: the instruction (required), the place (optional) and the planned day (optional, a real calendar date) are as typed.
// A move needs a reason (1..1000) and the loaded row_version (stale gives 409); entered_in_error is final. Instruction, place and move reasons never go into the audit log: ids and lengths only.
// Reuses orders:read and orders:write. The database enforces the same rules (migration 032).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_INSTR = 500, MAX_WHERE = 200, MAX_REASON = 1000;
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
// A real calendar day written YYYY-MM-DD, 2000 to 2100.
function day(v) {
  const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  if (y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? v : null;
}

function mountFollowups(app, pool) {
  const COLS = `o.id, o.patient_id, o.admission_id, o.instruction_text, o.where_text, to_char(o.follow_up_on, 'YYYY-MM-DD') AS follow_up_on, o.status, o.row_version,
                ru.username AS recorded_by, o.recorded_at, cu.username AS cancelled_by, o.cancelled_at, o.cancel_reason, xu.username AS error_by, o.error_at, o.error_reason`;
  const FROM = `FROM patient_followups o JOIN users ru ON ru.id = o.recorded_by LEFT JOIN users cu ON cu.id = o.cancelled_by LEFT JOIN users xu ON xu.id = o.error_by`;
  const load = async (c, id) => {
    const followup = (await c.query(`SELECT ${COLS} ${FROM} WHERE o.id = $1`, [id])).rows[0];
    if (followup) followup.events = (await c.query(`SELECT e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at FROM patient_followup_events e JOIN users u ON u.id = e.by_user WHERE e.followup_id = $1 ORDER BY e.seq`, [id])).rows;
    return followup;
  };

  app.get('/api/patients/:id/followups', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const followups = (await pool.query(`SELECT ${COLS} ${FROM} WHERE o.patient_id = $1 ${all ? '' : `AND o.status <> 'entered_in_error'`} ORDER BY o.id`, [pid])).rows;
    await audit(pool, req, 'patient.followups_view', 'patient', pid, { count: followups.length, includeAll: all });
    res.json({ followups });
  });

  app.get('/api/followups/:id', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const followup = await load(pool, id);
    if (!followup) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'followup.view', 'patient', followup.patient_id, { followupId: id });
    res.json({ followup });
  });

  app.post('/api/admissions/:id/followups', A.requirePerm(pool, 'orders:write'), async (req, res) => {
    const s = strict(req.body, ['instruction', 'where', 'followUpOn']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, aid = idParam(req.params.id);
    if (!text(b.instruction, MAX_INSTR)) return bad(res, `instruction must be 1 to ${MAX_INSTR} characters.`);
    if (b.where !== undefined && b.where !== null && !text(b.where, MAX_WHERE)) return bad(res, `where must be 1 to ${MAX_WHERE} characters when given.`);
    if (b.followUpOn !== undefined && b.followUpOn !== null && !day(b.followUpOn)) return bad(res, 'followUpOn must be a real date written YYYY-MM-DD (2000 to 2100) when given.');
    if (!aid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const a0 = (await c.query('SELECT patient_id FROM patient_admissions WHERE id = $1', [aid])).rows[0];
      if (!a0) return { status: 404, body: { error: 'not_found' } };
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [a0.patient_id])).rows[0];
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before recording a follow-up.' } };
      const a = (await c.query('SELECT id, status FROM patient_admissions WHERE id = $1 FOR UPDATE', [aid])).rows[0];
      if (a.status !== 'discharged') return { status: 409, body: { error: 'not_discharged', message: 'A follow-up is planned for a discharged admission.' } };
      const id = (await c.query('INSERT INTO patient_followups(patient_id, admission_id, instruction_text, where_text, follow_up_on, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [a0.patient_id, aid, b.instruction.trim(), b.where == null ? null : b.where.trim(), b.followUpOn == null ? null : b.followUpOn, req.user.id])).rows[0].id;
      await c.query(`INSERT INTO patient_followup_events(followup_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
      await audit(c, req, 'followup.add', 'patient', a0.patient_id, { followupId: id, admissionId: aid, instructionLength: b.instruction.trim().length, whereLength: b.where == null ? 0 : b.where.trim().length, hasDate: b.followUpOn != null });
      return { status: 201, body: { followup: await load(c, id) } };
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
        const o = (await c.query('SELECT id, patient_id, status, row_version FROM patient_followups WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!o) return { status: 404, body: { error: 'not_found' } };
        if (o.status === 'entered_in_error') return { status: 409, body: { error: 'followup_final', message: 'A follow-up entered in error is final.', currentRowVersion: o.row_version } };
        if (o.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This follow-up was changed by someone else. Reload it and try again.', currentRowVersion: o.row_version } };
        if (cancel && o.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active follow-up can be cancelled.', currentRowVersion: o.row_version } };
        const reason = s.body.reason.trim(), to = cancel ? 'cancelled' : 'entered_in_error';
        if (cancel) await c.query('UPDATE patient_followups SET status = $2, row_version = row_version + 1, cancelled_by = $3, cancelled_at = clock_timestamp(), cancel_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        else await c.query('UPDATE patient_followups SET status = $2, row_version = row_version + 1, error_by = $3, error_at = clock_timestamp(), error_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        await c.query(`INSERT INTO patient_followup_events(followup_id, seq, from_status, to_status, reason, by_user) SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM patient_followup_events WHERE followup_id = $1`, [id, o.status, to, reason, req.user.id]);
        await audit(c, req, cancel ? 'followup.cancel' : 'followup.error', 'patient', o.patient_id, { followupId: id, from: o.status, length: reason.length, rowVersion: rv + 1 });
        return { status: 200, body: { followup: await load(c, id) } };
      });
      res.status(out.status).json(out.body);
    };
  }
  app.post('/api/followups/:id/cancel', A.requirePerm(pool, 'orders:write'), move('cancel'));
  app.post('/api/followups/:id/entered-in-error', A.requirePerm(pool, 'orders:write'), move('error'));
}
module.exports = { mountFollowups };
