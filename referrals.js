'use strict';
// Task R4h-1: referrals on the server (list, get, refer, cancel, entered in error). Referrals only: no replies, appointments or scheduling.
// The referrer, canceller and error-marker come from the session; a body that names one is refused. Nothing is suggested: destination and reason are free text as typed;
// priority is routine or urgent as the clinician chooses. A move needs a reason (1..1000) and the loaded row_version (stale gives 409); entered_in_error is final.
// Destination, reason and move reasons never go into the audit log: ids and lengths only. Reuses orders:read and orders:write. The database enforces the same rules (migration 026).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_DEST = 200, MAX_INFO = 500, MAX_REASON = 1000, PRIORITIES = ['routine', 'urgent'];
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

function mountReferrals(app, pool) {
  const COLS = `o.id, o.patient_id, o.origin_case_id, o.destination_text, o.reason_text, o.priority, o.status, o.row_version,
                ru.username AS referred_by, o.referred_at, cu.username AS cancelled_by, o.cancelled_at, o.cancel_reason, xu.username AS error_by, o.error_at, o.error_reason`;
  const FROM = `FROM patient_referrals o JOIN users ru ON ru.id = o.referred_by LEFT JOIN users cu ON cu.id = o.cancelled_by LEFT JOIN users xu ON xu.id = o.error_by`;
  const load = async (c, id) => {
    const referral = (await c.query(`SELECT ${COLS} ${FROM} WHERE o.id = $1`, [id])).rows[0];
    if (referral) referral.events = (await c.query(`SELECT e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at FROM patient_referral_events e JOIN users u ON u.id = e.by_user WHERE e.referral_id = $1 ORDER BY e.seq`, [id])).rows;
    return referral;
  };

  app.get('/api/patients/:id/referrals', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const referrals = (await pool.query(`SELECT ${COLS} ${FROM} WHERE o.patient_id = $1 ${all ? '' : `AND o.status <> 'entered_in_error'`} ORDER BY o.id`, [pid])).rows;
    await audit(pool, req, 'patient.patient_referrals_view', 'patient', pid, { count: referrals.length, includeAll: all });
    res.json({ referrals });
  });

  app.get('/api/referrals/:id', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const referral = await load(pool, id);
    if (!referral) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'referral.view', 'patient', referral.patient_id, { referralId: id });
    res.json({ referral });
  });

  app.post('/api/patients/:id/referrals', A.requirePerm(pool, 'orders:write'), async (req, res) => {
    const s = strict(req.body, ['destination', 'reason', 'priority', 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id);
    if (!text(b.destination, MAX_DEST)) return bad(res, `destination must be 1 to ${MAX_DEST} characters.`);
    if (!text(b.reason, MAX_INFO)) return bad(res, `reason must be 1 to ${MAX_INFO} characters.`);
    if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) return bad(res, 'priority must be one of: ' + PRIORITIES.join(', '));
    if (b.originCaseId !== undefined && b.originCaseId !== null && !posInt(b.originCaseId)) return bad(res, 'originCaseId must be a whole number.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before making a referral.' } };
      const origin = b.originCaseId == null ? null : b.originCaseId;
      if (origin !== null && !(await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      const id = (await c.query('INSERT INTO patient_referrals(patient_id, origin_case_id, destination_text, reason_text, priority, referred_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [pid, origin, b.destination.trim(), b.reason.trim(), b.priority || 'routine', req.user.id])).rows[0].id;
      await c.query(`INSERT INTO patient_referral_events(referral_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
      await audit(c, req, 'referral.add', 'patient', pid, { referralId: id, originCaseId: origin, destinationLength: b.destination.trim().length, reasonLength: b.reason.trim().length, priority: b.priority || 'routine' });
      return { status: 201, body: { referral: await load(c, id) } };
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
        const o = (await c.query('SELECT id, patient_id, status, row_version FROM patient_referrals WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!o) return { status: 404, body: { error: 'not_found' } };
        if (o.status === 'entered_in_error') return { status: 409, body: { error: 'referral_final', message: 'A referral entered in error is final.', currentRowVersion: o.row_version } };
        if (o.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This referral was changed by someone else. Reload it and try again.', currentRowVersion: o.row_version } };
        if (cancel && o.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active referral can be cancelled.', currentRowVersion: o.row_version } };
        const reason = s.body.reason.trim(), to = cancel ? 'cancelled' : 'entered_in_error';
        if (cancel) await c.query('UPDATE patient_referrals SET status = $2, row_version = row_version + 1, cancelled_by = $3, cancelled_at = clock_timestamp(), cancel_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        else await c.query('UPDATE patient_referrals SET status = $2, row_version = row_version + 1, error_by = $3, error_at = clock_timestamp(), error_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        await c.query(`INSERT INTO patient_referral_events(referral_id, seq, from_status, to_status, reason, by_user) SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM patient_referral_events WHERE referral_id = $1`, [id, o.status, to, reason, req.user.id]);
        await audit(c, req, cancel ? 'referral.cancel' : 'referral.error', 'patient', o.patient_id, { referralId: id, from: o.status, length: reason.length, rowVersion: rv + 1 });
        return { status: 200, body: { referral: await load(c, id) } };
      });
      res.status(out.status).json(out.body);
    };
  }
  app.post('/api/referrals/:id/cancel', A.requirePerm(pool, 'orders:write'), move('cancel'));
  app.post('/api/referrals/:id/entered-in-error', A.requirePerm(pool, 'orders:write'), move('error'));
}
module.exports = { mountReferrals };
