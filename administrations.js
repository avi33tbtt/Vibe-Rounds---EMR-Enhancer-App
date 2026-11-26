'use strict';
// Task R5d: medication administration record (MAR) on the server (list, get, record, entered in error). Recording only: no schedule, due list, alert or dose check.
// An administration belongs to an existing medication order of the same patient. The recorder and the error-marker come from the session; a body that names one is refused.
// Nothing is suggested or copied from the order: the dose actually given, the reason (required when held or refused) and the note are free text as typed.
// The moment needs an offset, cannot be in the future or before the order was made, and an order that ended takes only doses before it ended. Never edited or deleted: a wrong entry is
// marked entered in error with a reason (final), needing the loaded row_version (stale gives 409). Text never goes into the audit log: ids, outcome and lengths only.
// Permissions mar:read and mar:write (a nurse records; a viewer reads). The database enforces the same rules (migration 030).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_DOSE = 200, MAX_INFO = 500, MAX_REASON = 1000, OUTCOMES = ['given', 'held', 'refused'];
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);
const optional = (v, max) => v === undefined || v === null || text(v, max);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
// A date-time with an offset (Z or +hh:mm), a real calendar moment, not in the future.
function givenAt(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number), sec = m[6] ? +m[6] : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d)); if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (m[7] !== 'Z') { const oh = +m[7].slice(1, 3), om = +m[7].slice(4, 6); if (oh > 14 || om > 59) return null; }
  const t = new Date(v); return Number.isNaN(t.getTime()) || t.getTime() > Date.now() ? null : t;
}
const trimOrNull = v => (v == null ? null : v.trim());
const len = v => (v == null ? 0 : v.trim().length);

function mountAdministrations(app, pool) {
  const COLS = `a.id, a.patient_id, a.order_id, mo.medication AS medication, a.outcome, a.administered_at, a.dose_text, a.reason_text, a.note_text, a.status, a.row_version,
                ru.username AS recorded_by, a.recorded_at, xu.username AS error_by, a.error_at, a.error_reason`;
  const FROM = `FROM medication_administrations a JOIN medication_orders mo ON mo.id = a.order_id JOIN users ru ON ru.id = a.recorded_by LEFT JOIN users xu ON xu.id = a.error_by`;
  const load = async (c, id) => {
    const administration = (await c.query(`SELECT ${COLS} ${FROM} WHERE a.id = $1`, [id])).rows[0];
    if (administration) administration.events = (await c.query(`SELECT e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at FROM medication_administration_events e JOIN users u ON u.id = e.by_user WHERE e.administration_id = $1 ORDER BY e.seq`, [id])).rows;
    return administration;
  };

  app.get('/api/patients/:id/administrations', A.requirePerm(pool, 'mar:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    let orderId = null;
    if (req.query.orderId !== undefined) { orderId = idParam(req.query.orderId); if (!orderId) return bad(res, 'orderId must be a whole number.'); }
    const administrations = (await pool.query(`SELECT ${COLS} ${FROM} WHERE a.patient_id = $1 ${all ? '' : `AND a.status <> 'entered_in_error'`} ${orderId ? 'AND a.order_id = $2' : ''} ORDER BY a.administered_at, a.id`, orderId ? [pid, orderId] : [pid])).rows;
    await audit(pool, req, 'patient.administrations_view', 'patient', pid, { count: administrations.length, includeAll: all, orderId });
    res.json({ administrations });
  });

  app.get('/api/administrations/:id', A.requirePerm(pool, 'mar:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const administration = await load(pool, id);
    if (!administration) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'administration.view', 'patient', administration.patient_id, { administrationId: id });
    res.json({ administration });
  });

  app.post('/api/patients/:id/administrations', A.requirePerm(pool, 'mar:write'), async (req, res) => {
    const s = strict(req.body, ['orderId', 'outcome', 'administeredAt', 'dose', 'reason', 'note']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id);
    if (!posInt(b.orderId)) return bad(res, 'orderId must be a whole number (the medication order).');
    if (!OUTCOMES.includes(b.outcome)) return bad(res, `outcome must be one of: ${OUTCOMES.join(', ')}.`);
    const when = givenAt(b.administeredAt);
    if (!when) return bad(res, 'administeredAt must be a date-time with an offset (for example 2026-11-26T09:30:00+05:45), and cannot be in the future.');
    if (!optional(b.dose, MAX_DOSE)) return bad(res, `dose must be 1 to ${MAX_DOSE} characters when given.`);
    if (!optional(b.reason, MAX_INFO)) return bad(res, `reason must be 1 to ${MAX_INFO} characters when given.`);
    if (!optional(b.note, MAX_INFO)) return bad(res, `note must be 1 to ${MAX_INFO} characters when given.`);
    if (b.outcome !== 'given' && b.reason == null) return bad(res, 'A reason is required when a dose is held or refused.');
    if (b.outcome !== 'given' && b.dose != null) return bad(res, 'A dose is recorded only for a dose that was given.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before recording an administration.' } };
      const o = (await c.query('SELECT id, patient_id, status, ordered_at, ended_at FROM medication_orders WHERE id = $1 FOR UPDATE', [b.orderId])).rows[0];
      if (!o || o.patient_id !== pid) return { status: 400, body: { error: 'order_not_of_patient', message: 'That is not a medication order of this patient.' } };
      if (o.status === 'entered_in_error') return { status: 409, body: { error: 'order_in_error', message: 'That order was entered in error and takes no administrations.' } };
      if (when < o.ordered_at) return { status: 409, body: { error: 'before_order', message: 'An administration cannot be recorded before the order was made.' } };
      if ((o.status === 'stopped' || o.status === 'changed') && when >= o.ended_at) return { status: 409, body: { error: 'order_ended', message: 'That order had already ended at that time.' } };
      if ((await c.query(`SELECT 1 FROM medication_administrations WHERE order_id = $1 AND administered_at = $2 AND status = 'recorded'`, [o.id, when.toISOString()])).rowCount) return { status: 409, body: { error: 'duplicate', message: 'An administration is already recorded for this order at that moment.' } };
      const id = (await c.query('INSERT INTO medication_administrations(patient_id, order_id, outcome, administered_at, dose_text, reason_text, note_text, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [pid, o.id, b.outcome, when.toISOString(), trimOrNull(b.dose), trimOrNull(b.reason), trimOrNull(b.note), req.user.id])).rows[0].id;
      await c.query(`INSERT INTO medication_administration_events(administration_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'recorded', $2)`, [id, req.user.id]);
      await audit(c, req, 'administration.add', 'patient', pid, { administrationId: id, orderId: o.id, outcome: b.outcome, doseLength: len(b.dose), reasonLength: len(b.reason), noteLength: len(b.note) });
      return { status: 201, body: { administration: await load(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  app.post('/api/administrations/:id/entered-in-error', A.requirePerm(pool, 'mar:write'), async (req, res) => {
    const s = strict(req.body, ['reason', 'rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
    if (!text(s.body.reason, MAX_REASON)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const o = (await c.query('SELECT id, patient_id, status, row_version FROM medication_administrations WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) return { status: 404, body: { error: 'not_found' } };
      if (o.status === 'entered_in_error') return { status: 409, body: { error: 'administration_final', message: 'An administration entered in error is final.', currentRowVersion: o.row_version } };
      if (o.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This administration was changed by someone else. Reload it and try again.', currentRowVersion: o.row_version } };
      const reason = s.body.reason.trim();
      await c.query(`UPDATE medication_administrations SET status = 'entered_in_error', row_version = row_version + 1, error_by = $2, error_at = clock_timestamp(), error_reason = $3 WHERE id = $1`, [id, req.user.id, reason]);
      await c.query(`INSERT INTO medication_administration_events(administration_id, seq, from_status, to_status, reason, by_user) SELECT $1, coalesce(max(seq), 0) + 1, $2, 'entered_in_error', $3, $4 FROM medication_administration_events WHERE administration_id = $1`, [id, o.status, reason, req.user.id]);
      await audit(c, req, 'administration.error', 'patient', o.patient_id, { administrationId: id, length: reason.length, rowVersion: rv + 1 });
      return { status: 200, body: { administration: await load(c, id) } };
    });
    res.status(out.status).json(out.body);
  });
}
module.exports = { mountAdministrations };
