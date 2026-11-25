'use strict';
// Task R3a-1: the patient problem list, on the server (list, get, add). Resolve and entered-in-error come in R3a-2.
// A problem belongs to the patient; origin_case_id (optional) must be a case of the same patient (composite foreign key, migration 018).
// The recorder comes from the session; a body that names one is refused. The label never goes into the audit log: ids and its length only.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_LABEL = 200;
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;   // NUL and lone surrogates
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const okLabel = v => typeof v === 'string' && v.trim().length >= 1 && v.length <= MAX_LABEL && !BAD_CHARS.test(v);
// A real calendar date (YYYY-MM-DD), from 1900, not later than tomorrow (UTC) to allow for time zones.
function okDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01' && d.getTime() <= Date.now() + 86400000;
}

function mountProblems(app, pool) {
  const PROB = `p.id, p.patient_id, p.origin_case_id, p.label, to_char(p.onset_date, 'YYYY-MM-DD') AS onset_date, p.status, p.row_version,
                ru.username AS recorded_by, p.recorded_at, xu.username AS resolved_by, p.resolved_at, p.resolution_reason,
                eu.username AS error_by, p.error_at, p.error_reason`;
  const PROB_FROM = `FROM patient_problems p JOIN users ru ON ru.id = p.recorded_by LEFT JOIN users xu ON xu.id = p.resolved_by LEFT JOIN users eu ON eu.id = p.error_by`;
  const EVENT = `e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at`;

  /* ---------- list a patient's problems (entered in error hidden unless ?include=all) ---------- */
  app.get('/api/patients/:id/problems', A.requirePerm(pool, 'problems:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const pt = (await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0];
    if (!pt) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const problems = (await pool.query(`SELECT ${PROB} ${PROB_FROM} WHERE p.patient_id = $1 ${all ? '' : `AND p.status <> 'entered_in_error'`} ORDER BY p.id`, [pid])).rows;
    await audit(pool, req, 'patient.problems_view', 'patient', pid, { count: problems.length, includeAll: all });
    res.json({ problems });
  });

  /* ---------- one problem, with its history ---------- */
  app.get('/api/problems/:id', A.requirePerm(pool, 'problems:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const problem = (await pool.query(`SELECT ${PROB} ${PROB_FROM} WHERE p.id = $1`, [id])).rows[0];
    if (!problem) return res.status(404).json({ error: 'not_found' });
    const events = (await pool.query(`SELECT ${EVENT} FROM patient_problem_events e JOIN users u ON u.id = e.by_user WHERE e.problem_id = $1 ORDER BY e.seq`, [id])).rows;
    await audit(pool, req, 'problem.view', 'patient', problem.patient_id, { problemId: id });
    res.json({ problem: { ...problem, events } });
  });

  /* ---------- add a problem ---------- */
  app.post('/api/patients/:id/problems', A.requirePerm(pool, 'problems:write'), async (req, res) => {
    const s = strict(req.body, ['label', 'onsetDate', 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id);
    if (!okLabel(b.label)) return bad(res, `The problem needs a label of 1 to ${MAX_LABEL} characters.`);
    if (b.onsetDate !== undefined && b.onsetDate !== null && !okDate(b.onsetDate)) return bad(res, 'onsetDate must be a real date as YYYY-MM-DD (leave it out if unknown).');
    if (b.originCaseId !== undefined && b.originCaseId !== null && !posInt(b.originCaseId)) return bad(res, 'originCaseId must be a whole number.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before adding a problem.' } };
      const origin = b.originCaseId == null ? null : b.originCaseId;
      if (origin !== null) {
        const k = (await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount;
        if (!k) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      }
      const id = (await c.query('INSERT INTO patient_problems(patient_id, origin_case_id, label, onset_date, recorded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [pid, origin, b.label, b.onsetDate == null ? null : b.onsetDate, req.user.id])).rows[0].id;
      await c.query(`INSERT INTO patient_problem_events(problem_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
      await audit(c, req, 'problem.add', 'patient', pid, { problemId: id, originCaseId: origin, length: b.label.length });
      const problem = (await c.query(`SELECT ${PROB} ${PROB_FROM} WHERE p.id = $1`, [id])).rows[0];
      return { status: 201, body: { problem } };
    });
    res.status(out.status).json(out.body);
  });
}
module.exports = { mountProblems };
