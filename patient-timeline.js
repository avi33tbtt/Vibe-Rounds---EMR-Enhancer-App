'use strict';
// Task R3g: ONE read route that merges a patient's record across all their cases: GET /api/patients/:id/timeline.
// Sources: observations (by when they were true), signed notes, problems, allergies, medication history. Read only; nothing is written except the audit row.
// Each event keeps the source's own id and case, its effective time and its recorded time apart, and its status. Entered-in-error rows are hidden unless ?includeErrors=1.
// Note text, reasons, doses and other free text beyond the clinician's own label are NOT sent: the timeline points to the source, which has its own route.
// R9 (longitudinal explorer) builds on this route; keep it generic and do not add a second timeline.
const { audit } = require('./audit');
const A = require('./auth');

const SOURCE_CAP = 5000;   // rows read per source; truncated:true tells the caller when a source was cut
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
// A bound is a real date (YYYY-MM-DD, taken as UTC) or a full timestamp with a zone. A date-only "to" includes that whole day.
function bound(v, isTo) {
  if (v === undefined) return { value: null };
  if (typeof v !== 'string' || !ISO.test(v)) return { error: true };
  const dateOnly = v.length === 10;
  const d = new Date(dateOnly ? v + 'T00:00:00Z' : v);
  if (Number.isNaN(d.getTime()) || (dateOnly && d.toISOString().slice(0, 10) !== v)) return { error: true };
  return { value: new Date(d.getTime() + (dateOnly && isTo ? 86400000 : 0)).toISOString() };   // "to" is exclusive
}

function mountPatientTimeline(app, pool) {
  app.get('/api/patients/:id/timeline', A.requirePerm(pool, 'cases:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    const q = req.query;
    const from = bound(q.from, false), to = bound(q.to, true);
    if (from.error || to.error) return res.status(400).json({ error: 'invalid', message: 'from and to must be a date (YYYY-MM-DD) or a timestamp with a time zone.' });
    if (from.value && to.value && from.value >= to.value) return res.status(400).json({ error: 'invalid', message: 'from must be before to.' });
    const lim = q.limit === undefined ? 200 : Number(q.limit), off = q.offset === undefined ? 0 : Number(q.offset);
    if (!Number.isInteger(lim) || lim < 1 || lim > 500 || !Number.isInteger(off) || off < 0 || off > 100000) return res.status(400).json({ error: 'invalid', message: 'limit is 1 to 500 and offset is 0 or more.' });
    const includeErrors = q.includeErrors === '1' || q.includeErrors === 'true';
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const pt = (await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0];
    if (!pt) return res.status(404).json({ error: 'not_found' });

    const P = [pid, from.value, to.value];
    const win = col => `AND ($2::timestamptz IS NULL OR ${col} >= $2) AND ($3::timestamptz IS NULL OR ${col} < $3)`;
    const err = col => (includeErrors ? '' : `AND ${col} <> 'entered_in_error'`);
    const run = (sql) => pool.query(sql + ` LIMIT ${SOURCE_CAP + 1}`, P);
    const [obs, notes, probs, algs, meds] = await Promise.all([
      run(`SELECT o.id, o.case_id, o.applied_set_id, o.field_key, o.value_type, o.value_json, o.unit_display, o.effective_at, o.recorded_at, o.status, o.source_type, o.corrects_id, u.username AS by_user
             FROM observations o JOIN clinical_cases c ON c.id = o.case_id JOIN users u ON u.id = o.recorded_by
            WHERE c.patient_id = $1 ${err('o.status')} ${win('o.effective_at')} ORDER BY o.effective_at, o.id`),
      run(`SELECT n.id, n.case_id, n.encounter_id, n.signed_at, n.created_at, u.username AS by_user
             FROM case_notes n JOIN clinical_cases c ON c.id = n.case_id JOIN users u ON u.id = n.signed_by
            WHERE c.patient_id = $1 AND n.status = 'signed' ${win('n.signed_at')} ORDER BY n.signed_at, n.id`),
      run(`SELECT p.id, p.origin_case_id AS case_id, p.label, to_char(p.onset_date, 'YYYY-MM-DD') AS onset_date, p.status, p.recorded_at, u.username AS by_user
             FROM patient_problems p JOIN users u ON u.id = p.recorded_by
            WHERE p.patient_id = $1 ${err('p.status')} ${win('p.recorded_at')} ORDER BY p.recorded_at, p.id`),
      run(`SELECT p.id, p.origin_case_id AS case_id, p.substance AS label, to_char(p.onset_date, 'YYYY-MM-DD') AS onset_date, p.status, p.recorded_at, u.username AS by_user
             FROM patient_allergies p JOIN users u ON u.id = p.recorded_by
            WHERE p.patient_id = $1 ${err('p.status')} ${win('p.recorded_at')} ORDER BY p.recorded_at, p.id`),
      run(`SELECT p.id, p.origin_case_id AS case_id, p.medication AS label, to_char(p.start_date, 'YYYY-MM-DD') AS start_date, p.status, p.recorded_at, u.username AS by_user
             FROM patient_medications p JOIN users u ON u.id = p.recorded_by
            WHERE p.patient_id = $1 ${err('p.status')} ${win('p.recorded_at')} ORDER BY p.recorded_at, p.id`),
    ]);
    const truncated = [obs, notes, probs, algs, meds].some(r => r.rows.length > SOURCE_CAP);
    const cut = r => r.rows.slice(0, SOURCE_CAP);
    const ev = [];
    for (const o of cut(obs)) ev.push({ kind: 'observation', sourceId: Number(o.id), caseId: o.case_id, at: o.effective_at, effectiveAt: o.effective_at, recordedAt: o.recorded_at, status: o.status,
      by: o.by_user, fieldKey: o.field_key, valueType: o.value_type, value: o.value_json, unit: o.unit_display, appliedSetId: o.applied_set_id, sourceType: o.source_type, correctsId: o.corrects_id === null ? null : Number(o.corrects_id) });
    for (const n of cut(notes)) ev.push({ kind: 'note', sourceId: n.id, caseId: n.case_id, at: n.signed_at, effectiveAt: n.signed_at, recordedAt: n.created_at, status: 'signed', by: n.by_user, encounterId: n.encounter_id });
    for (const [kind, r] of [['problem', probs], ['allergy', algs]]) for (const p of cut(r))
      ev.push({ kind, sourceId: p.id, caseId: p.case_id, at: p.recorded_at, effectiveAt: p.onset_date || null, recordedAt: p.recorded_at, status: p.status, by: p.by_user, label: p.label });
    for (const p of cut(meds)) ev.push({ kind: 'medication', sourceId: p.id, caseId: p.case_id, at: p.recorded_at, effectiveAt: p.start_date || null, recordedAt: p.recorded_at, status: p.status, by: p.by_user, label: p.label });
    // `at` is when the thing was true for observations and notes, and when it was recorded for the lists; effectiveAt (a date) is shown where the source has one. Same-time order: kind, then id.
    const t = e => new Date(e.at).getTime();
    ev.sort((a, b) => t(a) - t(b) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.sourceId - b.sourceId);
    const events = ev.slice(off, off + lim);
    let hiddenInError = 0;
    if (!includeErrors) {
      const h = await pool.query(`SELECT
        (SELECT count(*) FROM observations o JOIN clinical_cases c ON c.id = o.case_id WHERE c.patient_id = $1 AND o.status = 'entered_in_error' ${win('o.effective_at')})
        + (SELECT count(*) FROM patient_problems WHERE patient_id = $1 AND status = 'entered_in_error' ${win('recorded_at')})
        + (SELECT count(*) FROM patient_allergies WHERE patient_id = $1 AND status = 'entered_in_error' ${win('recorded_at')})
        + (SELECT count(*) FROM patient_medications WHERE patient_id = $1 AND status = 'entered_in_error' ${win('recorded_at')}) AS n`, P);
      hiddenInError = Number(h.rows[0].n);
    }
    await audit(pool, req, 'patient.timeline_view', 'patient', pid, { count: events.length, total: ev.length, includeErrors, windowed: !!(from.value || to.value) });
    res.json({ events, total: ev.length, limit: lim, offset: off, hiddenInError, truncated });
  });
}
module.exports = { mountPatientTimeline };
