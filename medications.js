'use strict';
// Task R3e: the patient medication list, on the server (list, get, add, stop, entered in error). Same rules as problems (R3a).
// A medication belongs to the patient; origin_case_id (optional) must be a case of the same patient (composite foreign key, migration 019).
// The recorder, stopper and error-marker come from the session; a body that names one is refused. The medication, dose, frequency and reasons never go into the audit log: ids and lengths only.
// A move needs a reason (1..1000) and the row_version that was loaded (stale gives 409); entered_in_error is final. The database enforces the same rules.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_LABEL = 200, MAX_REACTION = 200, MAX_REASON = 1000;
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
const okLabel = v => typeof v === 'string' && v.trim().length >= 1 && v.length <= MAX_LABEL && !BAD_CHARS.test(v);
// A real calendar date (YYYY-MM-DD), from 1900, not later than tomorrow (UTC) to allow for time zones.
function okDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01' && d.getTime() <= Date.now() + 86400000;
}

function mountMedications(app, pool) {
  const ALG = `p.id, p.patient_id, p.origin_case_id, p.medication, p.dose_text, p.frequency_text, to_char(p.start_date, 'YYYY-MM-DD') AS start_date, p.status, p.row_version,
                ru.username AS recorded_by, p.recorded_at, xu.username AS stopped_by, p.stopped_at, p.stop_reason,
                eu.username AS error_by, p.error_at, p.error_reason`;
  const ALG_FROM = `FROM patient_medications p JOIN users ru ON ru.id = p.recorded_by LEFT JOIN users xu ON xu.id = p.stopped_by LEFT JOIN users eu ON eu.id = p.error_by`;
  const EVENT = `e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at`;

  /* ---------- list a patient's medications (entered in error hidden unless ?include=all) ---------- */
  app.get('/api/patients/:id/medications', A.requirePerm(pool, 'medications:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const pt = (await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0];
    if (!pt) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const medications = (await pool.query(`SELECT ${ALG} ${ALG_FROM} WHERE p.patient_id = $1 ${all ? '' : `AND p.status <> 'entered_in_error'`} ORDER BY p.id`, [pid])).rows;
    await audit(pool, req, 'patient.medications_view', 'patient', pid, { count: medications.length, includeAll: all });
    res.json({ medications });
  });

  /* ---------- one medication, with its history ---------- */
  app.get('/api/medications/:id', A.requirePerm(pool, 'medications:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const medication = (await pool.query(`SELECT ${ALG} ${ALG_FROM} WHERE p.id = $1`, [id])).rows[0];
    if (!medication) return res.status(404).json({ error: 'not_found' });
    const events = (await pool.query(`SELECT ${EVENT} FROM patient_medication_events e JOIN users u ON u.id = e.by_user WHERE e.medication_id = $1 ORDER BY e.seq`, [id])).rows;
    await audit(pool, req, 'medication.view', 'patient', medication.patient_id, { medicationId: id });
    res.json({ medication: { ...medication, events } });
  });

  /* ---------- add a medication ---------- */
  app.post('/api/patients/:id/medications', A.requirePerm(pool, 'medications:write'), async (req, res) => {
    const s = strict(req.body, ['medication', 'doseText', 'frequencyText', 'startDate', 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id);
    if (!okLabel(b.medication)) return bad(res, `The medication needs a medication of 1 to ${MAX_LABEL} characters.`);
    if (b.doseText !== undefined && b.doseText !== null && !okReaction(b.doseText)) return bad(res, `doseText must be 1 to ${MAX_REACTION} characters (leave it out if not recorded).`);
    if (b.frequencyText !== undefined && b.frequencyText !== null && !okReaction(b.frequencyText)) return bad(res, `frequencyText must be 1 to ${MAX_REACTION} characters (leave it out if not recorded).`);
    if (b.startDate !== undefined && b.startDate !== null && !okDate(b.startDate)) return bad(res, 'startDate must be a real date as YYYY-MM-DD (leave it out if unknown).');
    if (b.originCaseId !== undefined && b.originCaseId !== null && !posInt(b.originCaseId)) return bad(res, 'originCaseId must be a whole number.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before adding a medication.' } };
      const origin = b.originCaseId == null ? null : b.originCaseId;
      if (origin !== null) {
        const k = (await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount;
        if (!k) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      }
      const id = (await c.query('INSERT INTO patient_medications(patient_id, origin_case_id, medication, dose_text, frequency_text, start_date, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [pid, origin, b.medication, b.doseText == null ? null : b.doseText, b.frequencyText == null ? null : b.frequencyText, b.startDate == null ? null : b.startDate, req.user.id])).rows[0].id;
      await c.query(`INSERT INTO patient_medication_events(medication_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
      await audit(c, req, 'medication.add', 'patient', pid, { medicationId: id, originCaseId: origin, nameLength: b.medication.length });
      const medication = (await c.query(`SELECT ${ALG} ${ALG_FROM} WHERE p.id = $1`, [id])).rows[0];
      return { status: 201, body: { medication } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- stop, or mark entered in error (reason and loaded row_version required; nothing is deleted) ---------- */
  function move(kind) {
    const stop = kind === 'stop';
    return async (req, res) => {
      const s = strict(req.body, ['reason', 'rowVersion']);
      if (s.error) return res.status(400).json(s.error);
      const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
      if (!okReason(s.body.reason)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
      if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
      if (!id) return res.status(404).json({ error: 'not_found' });
      const out = await tx(pool, async c => {
        const p = (await c.query('SELECT id, patient_id, status, row_version FROM patient_medications WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!p) return { status: 404, body: { error: 'not_found' } };
        if (p.status === 'entered_in_error') return { status: 409, body: { error: 'medication_final', message: 'A medication entered in error is final.', currentRowVersion: p.row_version } };
        if (p.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This medication was changed by someone else. Reload it and try again.', currentRowVersion: p.row_version } };
        if (stop && p.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active medication can be stopped.', currentRowVersion: p.row_version } };
        const reason = s.body.reason.trim(), to = stop ? 'stopped' : 'entered_in_error';
        if (stop) await c.query('UPDATE patient_medications SET status = $2, row_version = row_version + 1, stopped_by = $3, stopped_at = clock_timestamp(), stop_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        else await c.query('UPDATE patient_medications SET status = $2, row_version = row_version + 1, error_by = $3, error_at = clock_timestamp(), error_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        await c.query('INSERT INTO patient_medication_events(medication_id, seq, from_status, to_status, reason, by_user) SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM patient_medication_events WHERE medication_id = $1', [id, p.status, to, reason, req.user.id]);
        await audit(c, req, stop ? 'medication.stop' : 'medication.error', 'patient', p.patient_id, { medicationId: id, from: p.status, length: reason.length, rowVersion: rv + 1 });
        const medication = (await c.query(`SELECT ${ALG} ${ALG_FROM} WHERE p.id = $1`, [id])).rows[0];
        const events = (await c.query(`SELECT ${EVENT} FROM patient_medication_events e JOIN users u ON u.id = e.by_user WHERE e.medication_id = $1 ORDER BY e.seq`, [id])).rows;
        return { status: 200, body: { medication: { ...medication, events } } };
      });
      res.status(out.status).json(out.body);
    };
  }
  app.post('/api/medications/:id/stop', A.requirePerm(pool, 'medications:write'), move('stop'));
  app.post('/api/medications/:id/entered-in-error', A.requirePerm(pool, 'medications:write'), move('error'));
}
module.exports = { mountMedications };
