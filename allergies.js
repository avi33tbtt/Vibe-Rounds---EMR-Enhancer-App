'use strict';
// Task R3c: the patient allergy list, on the server (list, get, add, resolve, entered in error). Same rules as problems (R3a).
// An allergy belongs to the patient; origin_case_id (optional) must be a case of the same patient (composite foreign key, migration 019).
// The recorder, resolver and error-marker come from the session; a body that names one is refused. The substance, reaction and reasons never go into the audit log: ids and lengths only.
// A move needs a reason (1..1000) and the row_version that was loaded (stale gives 409); entered_in_error is final. The database enforces the same rules.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_LABEL = 200, MAX_REACTION = 500, MAX_REASON = 1000;
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;   // NUL and lone surrogates
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const okReason = v => typeof v === 'string' && v.trim().length >= 1 && v.length <= MAX_REASON && !BAD_CHARS.test(v);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const okReaction = v => typeof v === 'string' && v.trim().length >= 1 && v.length <= MAX_REACTION && !BAD_CHARS.test(v);
const SEVERITIES = ['mild', 'moderate', 'severe'];
const okLabel = v => typeof v === 'string' && v.trim().length >= 1 && v.length <= MAX_LABEL && !BAD_CHARS.test(v);
// A real calendar date (YYYY-MM-DD), from 1900, not later than tomorrow (UTC) to allow for time zones.
function okDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01' && d.getTime() <= Date.now() + 86400000;
}

function mountAllergies(app, pool) {
  const ALG = `p.id, p.patient_id, p.origin_case_id, p.substance, p.reaction, p.severity, to_char(p.onset_date, 'YYYY-MM-DD') AS onset_date, p.status, p.row_version,
                ru.username AS recorded_by, p.recorded_at, xu.username AS resolved_by, p.resolved_at, p.resolution_reason,
                eu.username AS error_by, p.error_at, p.error_reason`;
  const ALG_FROM = `FROM patient_allergies p JOIN users ru ON ru.id = p.recorded_by LEFT JOIN users xu ON xu.id = p.resolved_by LEFT JOIN users eu ON eu.id = p.error_by`;
  const EVENT = `e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at`;

  /* ---------- list a patient's allergies (entered in error hidden unless ?include=all) ---------- */
  app.get('/api/patients/:id/allergies', A.requirePerm(pool, 'allergies:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const pt = (await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0];
    if (!pt) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const allergies = (await pool.query(`SELECT ${ALG} ${ALG_FROM} WHERE p.patient_id = $1 ${all ? '' : `AND p.status <> 'entered_in_error'`} ORDER BY p.id`, [pid])).rows;
    await audit(pool, req, 'patient.allergies_view', 'patient', pid, { count: allergies.length, includeAll: all });
    res.json({ allergies });
  });

  /* ---------- one allergy, with its history ---------- */
  app.get('/api/allergies/:id', A.requirePerm(pool, 'allergies:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const allergy = (await pool.query(`SELECT ${ALG} ${ALG_FROM} WHERE p.id = $1`, [id])).rows[0];
    if (!allergy) return res.status(404).json({ error: 'not_found' });
    const events = (await pool.query(`SELECT ${EVENT} FROM patient_allergy_events e JOIN users u ON u.id = e.by_user WHERE e.allergy_id = $1 ORDER BY e.seq`, [id])).rows;
    await audit(pool, req, 'allergy.view', 'patient', allergy.patient_id, { allergyId: id });
    res.json({ allergy: { ...allergy, events } });
  });

  /* ---------- add an allergy ---------- */
  app.post('/api/patients/:id/allergies', A.requirePerm(pool, 'allergies:write'), async (req, res) => {
    const s = strict(req.body, ['substance', 'reaction', 'severity', 'onsetDate', 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id);
    if (!okLabel(b.substance)) return bad(res, `The allergy needs a substance of 1 to ${MAX_LABEL} characters.`);
    if (b.reaction !== undefined && b.reaction !== null && !okReaction(b.reaction)) return bad(res, `reaction must be 1 to ${MAX_REACTION} characters (leave it out if not recorded).`);
    if (b.severity !== undefined && b.severity !== null && !SEVERITIES.includes(b.severity)) return bad(res, 'severity must be mild, moderate or severe (leave it out if not recorded).');
    if (b.onsetDate !== undefined && b.onsetDate !== null && !okDate(b.onsetDate)) return bad(res, 'onsetDate must be a real date as YYYY-MM-DD (leave it out if unknown).');
    if (b.originCaseId !== undefined && b.originCaseId !== null && !posInt(b.originCaseId)) return bad(res, 'originCaseId must be a whole number.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before adding an allergy.' } };
      const origin = b.originCaseId == null ? null : b.originCaseId;
      if (origin !== null) {
        const k = (await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount;
        if (!k) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      }
      const id = (await c.query('INSERT INTO patient_allergies(patient_id, origin_case_id, substance, reaction, severity, onset_date, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [pid, origin, b.substance, b.reaction == null ? null : b.reaction, b.severity == null ? null : b.severity, b.onsetDate == null ? null : b.onsetDate, req.user.id])).rows[0].id;
      await c.query(`INSERT INTO patient_allergy_events(allergy_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
      await audit(c, req, 'allergy.add', 'patient', pid, { allergyId: id, originCaseId: origin, substanceLength: b.substance.length });
      const allergy = (await c.query(`SELECT ${ALG} ${ALG_FROM} WHERE p.id = $1`, [id])).rows[0];
      return { status: 201, body: { allergy } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- resolve, or mark entered in error (reason and loaded row_version required; nothing is deleted) ---------- */
  function move(kind) {
    const resolve = kind === 'resolve';
    return async (req, res) => {
      const s = strict(req.body, ['reason', 'rowVersion']);
      if (s.error) return res.status(400).json(s.error);
      const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
      if (!okReason(s.body.reason)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
      if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
      if (!id) return res.status(404).json({ error: 'not_found' });
      const out = await tx(pool, async c => {
        const p = (await c.query('SELECT id, patient_id, status, row_version FROM patient_allergies WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!p) return { status: 404, body: { error: 'not_found' } };
        if (p.status === 'entered_in_error') return { status: 409, body: { error: 'allergy_final', message: 'An allergy entered in error is final.', currentRowVersion: p.row_version } };
        if (p.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This allergy was changed by someone else. Reload it and try again.', currentRowVersion: p.row_version } };
        if (resolve && p.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active allergy can be resolved.', currentRowVersion: p.row_version } };
        const reason = s.body.reason.trim(), to = resolve ? 'resolved' : 'entered_in_error';
        if (resolve) await c.query('UPDATE patient_allergies SET status = $2, row_version = row_version + 1, resolved_by = $3, resolved_at = clock_timestamp(), resolution_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        else await c.query('UPDATE patient_allergies SET status = $2, row_version = row_version + 1, error_by = $3, error_at = clock_timestamp(), error_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        await c.query('INSERT INTO patient_allergy_events(allergy_id, seq, from_status, to_status, reason, by_user) SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM patient_allergy_events WHERE allergy_id = $1', [id, p.status, to, reason, req.user.id]);
        await audit(c, req, resolve ? 'allergy.resolve' : 'allergy.error', 'patient', p.patient_id, { allergyId: id, from: p.status, length: reason.length, rowVersion: rv + 1 });
        const allergy = (await c.query(`SELECT ${ALG} ${ALG_FROM} WHERE p.id = $1`, [id])).rows[0];
        const events = (await c.query(`SELECT ${EVENT} FROM patient_allergy_events e JOIN users u ON u.id = e.by_user WHERE e.allergy_id = $1 ORDER BY e.seq`, [id])).rows;
        return { status: 200, body: { allergy: { ...allergy, events } } };
      });
      res.status(out.status).json(out.body);
    };
  }
  app.post('/api/allergies/:id/resolve', A.requirePerm(pool, 'allergies:write'), move('resolve'));
  app.post('/api/allergies/:id/entered-in-error', A.requirePerm(pool, 'allergies:write'), move('error'));
}
module.exports = { mountAllergies };
