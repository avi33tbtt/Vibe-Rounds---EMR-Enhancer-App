'use strict';
// Task R9e: GET /api/patients/:id/longitudinal, the server side of the longitudinal explorer. Read only; the only write is the audit row.
// It does NOT add a second timeline: it reads the same rows as GET /api/patients/:id/timeline (readPatientEvents), then
// projects them (timeline-projection.js, R9b), labels each with its context memberships (context-map.js, R9c) and filters.
// One source row stays ONE event with ONE key (kind:sourceId); a row in two contexts appears once in a combined view.
// Effective and recorded time stay apart. Entered-in-error is hidden unless ?includeErrors=1. No note text, doses or free text beyond the label.
// Query: from, to (as in the timeline), context=diabetes,ckd (comma list; absent = overall view), limit 1-500, offset, includeErrors.
// Counts (`counts`) cover the whole window before the context filter, so the filter chips can show every view at once.
// SYNTHETIC DEMO DATA - NOT FOR CLINICAL USE. Nothing here is a rule, threshold, score or advice.
const { audit } = require('./audit');
const A = require('./auth');
const { readPatientEvents, bound, idParam } = require('./patient-timeline');
const { projectTimeline, ProjectionError } = require('./timeline-projection');
const { annotate, filterByContexts, contextCounts, CONTEXTS, CONTEXT_KEYS, ContextError } = require('./context-map');

// The case pins that say which set (and which pathway, if any) each case applied. Slugs and states only.
async function readCasePins(pool, pid) {
  const r = await pool.query(
    `SELECT a.case_id, es.slug AS set_slug, a.state, pw.slug AS pathway_slug
       FROM case_applied_sets a JOIN clinical_cases c ON c.id = a.case_id JOIN element_sets es ON es.id = a.element_set_id
       LEFT JOIN case_applied_pathways ap ON ap.id = a.from_applied_pathway_id LEFT JOIN pathways pw ON pw.id = ap.pathway_id
      WHERE c.patient_id = $1 ORDER BY a.id`, [pid]);
  const pins = {};
  for (const x of r.rows) (pins[x.case_id] = pins[x.case_id] || []).push({ setSlug: x.set_slug, pathwaySlug: x.pathway_slug || null, active: x.state === 'active' });
  return pins;
}

// "diabetes,ckd" -> ['diabetes','ckd']; absent -> []; an unknown or repeated key is an error, never guessed.
function parseContexts(v) {
  if (v === undefined || v === '') return { keys: [] };
  if (typeof v !== 'string') return { error: true };
  const keys = v.split(',').map(s => s.trim());
  if (keys.some(k => !CONTEXTS[k]) || new Set(keys).size !== keys.length) return { error: true };
  return { keys };
}

function mountPatientLongitudinal(app, pool) {
  app.get('/api/patients/:id/longitudinal', A.requirePerm(pool, 'cases:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    const q = req.query;
    const from = bound(q.from, false), to = bound(q.to, true);
    if (from.error || to.error) return res.status(400).json({ error: 'invalid', message: 'from and to must be a date (YYYY-MM-DD) or a timestamp with a time zone.' });
    if (from.value && to.value && from.value >= to.value) return res.status(400).json({ error: 'invalid', message: 'from must be before to.' });
    const lim = q.limit === undefined ? 200 : Number(q.limit), off = q.offset === undefined ? 0 : Number(q.offset);
    if (!Number.isInteger(lim) || lim < 1 || lim > 500 || !Number.isInteger(off) || off < 0 || off > 100000) return res.status(400).json({ error: 'invalid', message: 'limit is 1 to 500 and offset is 0 or more.' });
    const ctx = parseContexts(q.context);
    if (ctx.error) return res.status(400).json({ error: 'invalid', message: 'context must be a comma-separated list of: ' + CONTEXT_KEYS.join(', ') + ' (each once).' });
    const includeErrors = q.includeErrors === '1' || q.includeErrors === 'true';
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const pt = (await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0];
    if (!pt) return res.status(404).json({ error: 'not_found' });

    const { ev, truncated, hiddenInError } = await readPatientEvents(pool, pid, { from: from.value, to: to.value, includeErrors });
    const pins = await readCasePins(pool, pid);
    let projected, annotated, filtered;
    try {
      projected = projectTimeline(ev);
      annotated = annotate(projected.events, pins);
      filtered = filterByContexts(annotated.events, ctx.keys);
    } catch (e) {
      if (e instanceof ProjectionError || e instanceof ContextError) return res.status(422).json({ error: 'unprocessable', message: 'A stored record could not be shown: ' + e.message });
      throw e;
    }
    const events = filtered.slice(off, off + lim);
    await audit(pool, req, 'patient.longitudinal_view', 'patient', pid, { count: events.length, total: filtered.length, contexts: ctx.keys, includeErrors, windowed: !!(from.value || to.value) });
    res.json({
      events, total: filtered.length, limit: lim, offset: off,
      contexts: ctx.keys, counts: contextCounts(annotated.events),
      available: CONTEXT_KEYS.map(k => ({ key: k, label: CONTEXTS[k].label })),
      hiddenInError, truncated, duplicates: projected.duplicates + annotated.duplicates,
    });
  });
}
module.exports = { mountPatientLongitudinal };
