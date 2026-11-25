'use strict';
// Task R5a-1: admissions on the server (list, get, admit, cancel, entered in error). Admissions only: no beds, transfers, discharge or progress notes (later rows).
// The admitter, canceller and error-marker come from the session; a body that names one is refused. Nothing is suggested: ward (or unit) and reason are free text as typed;
// the admission date-time must carry an offset and cannot be in the future. A patient has at most one active admission. A move needs a reason (1..1000) and the loaded row_version
// (stale gives 409); entered_in_error is final. Ward, reason and move reasons never go into the audit log: ids and lengths only. Reuses orders:read and orders:write. The database enforces the same rules (migration 028).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_WARD = 200, MAX_INFO = 500, MAX_REASON = 1000;
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
function admittedAt(v) {
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

function mountAdmissions(app, pool) {
  const COLS = `o.id, o.patient_id, o.origin_case_id, o.ward_text, o.reason_text, o.admitted_at, o.status, o.row_version,
                ru.username AS recorded_by, o.recorded_at, cu.username AS cancelled_by, o.cancelled_at, o.cancel_reason, xu.username AS error_by, o.error_at, o.error_reason`;
  const FROM = `FROM patient_admissions o JOIN users ru ON ru.id = o.recorded_by LEFT JOIN users cu ON cu.id = o.cancelled_by LEFT JOIN users xu ON xu.id = o.error_by`;
  const load = async (c, id) => {
    const admission = (await c.query(`SELECT ${COLS} ${FROM} WHERE o.id = $1`, [id])).rows[0];
    if (admission) admission.events = (await c.query(`SELECT e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at FROM patient_admission_events e JOIN users u ON u.id = e.by_user WHERE e.admission_id = $1 ORDER BY e.seq`, [id])).rows;
    return admission;
  };

  app.get('/api/patients/:id/admissions', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const admissions = (await pool.query(`SELECT ${COLS} ${FROM} WHERE o.patient_id = $1 ${all ? '' : `AND o.status <> 'entered_in_error'`} ORDER BY o.id`, [pid])).rows;
    await audit(pool, req, 'patient.admissions_view', 'patient', pid, { count: admissions.length, includeAll: all });
    res.json({ admissions });
  });

  app.get('/api/admissions/:id', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const admission = await load(pool, id);
    if (!admission) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'admission.view', 'patient', admission.patient_id, { admissionId: id });
    res.json({ admission });
  });

  app.post('/api/patients/:id/admissions', A.requirePerm(pool, 'orders:write'), async (req, res) => {
    const s = strict(req.body, ['ward', 'admittedAt', 'reason', 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id);
    if (!text(b.ward, MAX_WARD)) return bad(res, `ward must be 1 to ${MAX_WARD} characters.`);
    if (!text(b.reason, MAX_INFO)) return bad(res, `reason must be 1 to ${MAX_INFO} characters.`);
    const when = admittedAt(b.admittedAt);
    if (!when) return bad(res, 'admittedAt must be a date-time with an offset (for example 2026-11-26T09:30:00+05:45), and cannot be in the future.');
    if (b.originCaseId !== undefined && b.originCaseId !== null && !posInt(b.originCaseId)) return bad(res, 'originCaseId must be a whole number.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before admitting.' } };
      if ((await c.query(`SELECT 1 FROM patient_admissions WHERE patient_id = $1 AND status = 'active'`, [pid])).rowCount) return { status: 409, body: { error: 'already_admitted', message: 'This patient already has an active admission. Cancel it (with a reason) before recording another.' } };
      const origin = b.originCaseId == null ? null : b.originCaseId;
      if (origin !== null && !(await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      const id = (await c.query('INSERT INTO patient_admissions(patient_id, origin_case_id, ward_text, reason_text, admitted_at, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [pid, origin, b.ward.trim(), b.reason.trim(), when.toISOString(), req.user.id])).rows[0].id;
      await c.query(`INSERT INTO patient_admission_events(admission_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
      await audit(c, req, 'admission.add', 'patient', pid, { admissionId: id, originCaseId: origin, wardLength: b.ward.trim().length, reasonLength: b.reason.trim().length });
      return { status: 201, body: { admission: await load(c, id) } };
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
        const o = (await c.query('SELECT id, patient_id, status, row_version FROM patient_admissions WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!o) return { status: 404, body: { error: 'not_found' } };
        if (o.status === 'entered_in_error') return { status: 409, body: { error: 'admission_final', message: 'An admission entered in error is final.', currentRowVersion: o.row_version } };
        if (o.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This admission was changed by someone else. Reload it and try again.', currentRowVersion: o.row_version } };
        if (cancel && o.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active admission can be cancelled.', currentRowVersion: o.row_version } };
        const reason = s.body.reason.trim(), to = cancel ? 'cancelled' : 'entered_in_error';
        if (cancel) await c.query('UPDATE patient_admissions SET status = $2, row_version = row_version + 1, cancelled_by = $3, cancelled_at = clock_timestamp(), cancel_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        else await c.query('UPDATE patient_admissions SET status = $2, row_version = row_version + 1, error_by = $3, error_at = clock_timestamp(), error_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        await c.query(`INSERT INTO patient_admission_events(admission_id, seq, from_status, to_status, reason, by_user) SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM patient_admission_events WHERE admission_id = $1`, [id, o.status, to, reason, req.user.id]);
        await audit(c, req, cancel ? 'admission.cancel' : 'admission.error', 'patient', o.patient_id, { admissionId: id, from: o.status, length: reason.length, rowVersion: rv + 1 });
        return { status: 200, body: { admission: await load(c, id) } };
      });
      res.status(out.status).json(out.body);
    };
  }
  app.post('/api/admissions/:id/cancel', A.requirePerm(pool, 'orders:write'), move('cancel'));
  app.post('/api/admissions/:id/entered-in-error', A.requirePerm(pool, 'orders:write'), move('error'));
}
module.exports = { mountAdmissions };
