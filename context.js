'use strict';
// Task B5a-2: the context route. One read route that turns ONE case into the CCIS context envelope (contracts/context-envelope.schema.json).
// The envelope is built by the pure `envelope.js`; this file only reads one consistent snapshot of the case, calls it, and audits the export.
// Each export is logged (context_exports, append-only) with the SHA-256 of the exact bytes sent and returned as a downloadable file.
// No parameters are accepted: identity and narrative can never be included, and entered-in-error rows are never exported (the schema fixes it).
const crypto = require('crypto');
const { audit } = require('./audit');
const A = require('./auth');
const PKG = require('./package.json');
const { buildEnvelope, EnvelopeError } = require('./envelope');

const MAX_OBSERVATIONS = 50000;

function mountContext(app, pool, opts = {}) {
  const now = opts.contextNow || (() => new Date());
  const secret = () => opts.contextSecret ?? process.env.CONTEXT_REF_SECRET ?? '';

  app.get('/api/cases/:id/context', A.requirePerm(pool, 'context:read'), async (req, res) => {
    const extra = Object.keys(req.query);
    if (extra.length) return res.status(400).json({ error: 'unknown_parameter', message: 'This route takes no parameters: ' + extra.slice(0, 5).join(', ') });
    const caseId = /^\d{1,9}$/.test(String(req.params.id)) && +req.params.id >= 1 ? +req.params.id : null;
    if (!caseId) return res.status(404).json({ error: 'not_found' });

    const c = await pool.connect();
    let rows;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');   // one consistent snapshot of the case
      if (!(await c.query('SELECT 1 FROM clinical_cases WHERE id = $1', [caseId])).rows.length) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
      const q = (sql, p) => c.query(sql, p).then(r => r.rows);
      const sets = await q(`SELECT a.id, s.slug, v.version, v.definition_json, a.state
                              FROM case_applied_sets a JOIN element_set_versions v ON v.id = a.element_set_version_id JOIN element_sets s ON s.id = a.element_set_id
                             WHERE a.case_id = $1 ORDER BY a.id`, [caseId]);
      const pathways = await q(`SELECT ap.id, pw.slug, pv.version FROM case_applied_pathways ap
                                  JOIN pathway_versions pv ON pv.id = ap.pathway_version_id JOIN pathways pw ON pw.id = ap.pathway_id WHERE ap.case_id = $1 ORDER BY ap.id`, [caseId]);
      const observations = await q(`SELECT o.id, o.applied_set_id, o.field_key, o.value_type, o.value_json, o.unit_display, o.effective_at, o.recorded_at, o.source_type, o.status, o.corrects_id, u.role AS recorded_role
                                      FROM observations o JOIN users u ON u.id = o.recorded_by WHERE o.case_id = $1 ORDER BY o.id LIMIT $2`, [caseId, MAX_OBSERVATIONS + 1]);
      const events = await q('SELECT id FROM clinical_events WHERE case_id = $1 ORDER BY id', [caseId]);   // only counted, never exported
      // R3i: the patient's problems and allergies. Only ids, status, onset date, recording time and role are selected: label, substance, reaction and reasons never leave the database.
      const listOf = table => q(`SELECT x.id, x.status, to_char(x.onset_date, 'YYYY-MM-DD') AS onset_date, x.recorded_at, u.role AS recorded_role
                                   FROM ${table} x JOIN users u ON u.id = x.recorded_by
                                  WHERE x.patient_id = (SELECT patient_id FROM clinical_cases WHERE id = $1) ORDER BY x.id`, [caseId]);
      const problems = await listOf('patient_problems'), allergies = await listOf('patient_allergies');
      // R4j: orders (status, ordering time and role only: no drug, dose, test name or reason) and results of the same patient. A result's value and unit are read only so the builder can accept a plain number; any other text is dropped there and counted.
      const orderList = table => q(`SELECT x.id, x.status, NULL::text AS onset_date, x.ordered_at AS recorded_at, u.role AS recorded_role
                                      FROM ${table} x JOIN users u ON u.id = x.ordered_by
                                     WHERE x.patient_id = (SELECT patient_id FROM clinical_cases WHERE id = $1) ORDER BY x.id`, [caseId]);
      const medicationOrders = await orderList('medication_orders'), investigationOrders = await orderList('investigation_orders');
      const results = await q(`SELECT r.id, r.replaces_result_id, r.value_text, r.unit_text, s.collected_at, r.recorded_at, u.role AS recorded_role
                                 FROM investigation_results r JOIN users u ON u.id = r.recorded_by LEFT JOIN investigation_specimens s ON s.id = r.specimen_id
                                WHERE r.patient_id = (SELECT patient_id FROM clinical_cases WHERE id = $1) ORDER BY r.id`, [caseId]);
      await c.query('COMMIT');
      rows = { sets, pathways, observations, events, problems, allergies, medicationOrders, investigationOrders, results };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally { c.release(); }

    if (rows.observations.length > MAX_OBSERVATIONS) return res.status(413).json({ error: 'too_large', message: `A context envelope holds at most ${MAX_OBSERVATIONS} observations.` });
    if (String(secret()).length < 32) return res.status(503).json({ error: 'context_not_configured', message: 'Set CONTEXT_REF_SECRET (at least 32 characters) on the server.' });

    let envelope;
    try {
      envelope = buildEnvelope({ caseRow: { id: caseId }, pins: { sets: rows.sets, pathways: rows.pathways }, observations: rows.observations, events: rows.events, problems: rows.problems, allergies: rows.allergies, medicationOrders: rows.medicationOrders, investigationOrders: rows.investigationOrders, results: rows.results,
                                 exportedAt: now(), producerVersion: PKG.version, refSecret: secret() });
    } catch (e) {
      if (e instanceof EnvelopeError) return res.status(422).json({ error: 'envelope_unmappable', message: e.message });   // set or field ids only, never patient data
      throw e;
    }
    // The bytes sent are hashed; the export row and the audit row are written in one transaction, before anything is sent.
    const body = JSON.stringify(envelope);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const w = await pool.connect();
    try {
      await w.query('BEGIN');
      await w.query('INSERT INTO context_exports(case_id, envelope_sha256, envelope_version, observations, exported_by) VALUES ($1,$2,$3,$4,$5)',
        [caseId, sha256, envelope.envelope.version, envelope.observations.length, req.user.id]);
      await audit(w, req, 'context.export', 'case', caseId, { envelopeVersion: envelope.envelope.version, observations: envelope.observations.length, sha256, withheld: envelope['x-emr'].withheld });   // counts and the hash only, never values
      await w.query('COMMIT');
    } catch (e) {
      try { await w.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally { w.release(); }
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="context-envelope-${envelope.case.ref}.json"` }).send(body);
  });
}

module.exports = { mountContext };
