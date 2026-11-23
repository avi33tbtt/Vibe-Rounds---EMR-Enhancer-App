'use strict';
// Task B5a-2: the context route. One read route that turns ONE case into the CCIS context envelope (contracts/context-envelope.schema.json).
// The envelope is built by the pure `envelope.js`; this file only reads one consistent snapshot of the case, calls it, and audits the export.
// No parameters are accepted: identity and narrative can never be included, and entered-in-error rows are never exported (the schema fixes it).
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
      await c.query('COMMIT');
      rows = { sets, pathways, observations, events };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally { c.release(); }

    if (rows.observations.length > MAX_OBSERVATIONS) return res.status(413).json({ error: 'too_large', message: `A context envelope holds at most ${MAX_OBSERVATIONS} observations.` });
    if (String(secret()).length < 32) return res.status(503).json({ error: 'context_not_configured', message: 'Set CONTEXT_REF_SECRET (at least 32 characters) on the server.' });

    let envelope;
    try {
      envelope = buildEnvelope({ caseRow: { id: caseId }, pins: { sets: rows.sets, pathways: rows.pathways }, observations: rows.observations, events: rows.events,
                                 exportedAt: now(), producerVersion: PKG.version, refSecret: secret() });
    } catch (e) {
      if (e instanceof EnvelopeError) return res.status(422).json({ error: 'envelope_unmappable', message: e.message });   // set or field ids only, never patient data
      throw e;
    }
    await audit(pool, req, 'context.export', 'case', caseId, { envelopeVersion: envelope.envelope.version, observations: envelope.observations.length, withheld: envelope['x-emr'].withheld });   // counts only, never values
    res.set('Cache-Control', 'no-store').json(envelope);
  });
}

module.exports = { mountContext };
