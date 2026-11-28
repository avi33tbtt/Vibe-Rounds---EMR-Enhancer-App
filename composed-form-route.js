'use strict';
// Task D12: read route for the composed form of a case with two or more package pathways (composed-form.js, D12a). Reads only; layout and ids, no field values.
// Pins are read at their own pinned set version. All or nothing: fewer than two pathways, or a pathway without a layout, gives composed:false and a reason.
// Prototype. Synthetic data only. Not for clinical use.
const { audit } = require('./audit');
const A = require('./auth');
const { composeForm } = require('./composed-form');

const PINS = `SELECT a.id AS applied_id, a.element_set_id, s.slug AS set_slug, s.title AS set_title, v.version AS set_version, v.definition_json AS definition,
                     ap.id AS ap_id, pw.slug AS pw_slug, pv.version AS pw_version, pv.title AS pw_title, pv.entry_form, pv.contexts
                FROM case_applied_sets a
                JOIN element_set_versions v ON v.id = a.element_set_version_id JOIN element_sets s ON s.id = a.element_set_id
                LEFT JOIN case_applied_pathways ap ON ap.id = a.from_applied_pathway_id
                LEFT JOIN pathway_versions pv ON pv.id = ap.pathway_version_id LEFT JOIN pathways pw ON pw.id = ap.pathway_id
               WHERE a.case_id = $1 AND a.state = 'active' ORDER BY a.id`;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function mountComposedForm(app, pool) {
  app.get('/api/cases/:id/composed-form', A.requirePerm(pool, 'cases:read'), async (req, res) => {
    if (!/^[1-9]\d{0,9}$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const cs = (await pool.query('SELECT id FROM clinical_cases WHERE id = $1', [req.params.id])).rows[0];
    if (!cs) return res.status(404).json({ error: 'not_found' });
    const rows = (await pool.query(PINS, [cs.id])).rows, byPw = new Map();
    rows.filter(r => r.pw_slug).forEach(r => { const k = r.pw_slug + '@' + r.pw_version; if (!byPw.has(k)) byPw.set(k, { slug: r.pw_slug, version: r.pw_version, title: r.pw_title, entryForm: r.entry_form, contexts: r.contexts }); });
    const pathways = [...byPw.values()];
    await audit(pool, req, 'case.composed_form', 'case', cs.id, { pathways: pathways.length });
    if (pathways.length < 2) return res.json({ composed: false, reason: 'fewer-than-two-pathways' });
    if (pathways.some(p => !isObj(p.entryForm))) return res.json({ composed: false, reason: 'no-layout' });
    const sets = {};
    rows.forEach(r => { const d = isObj(r.definition) ? r.definition : {}; sets[r.set_slug] = { title: typeof d.title === 'string' ? d.title : r.set_title, fields: Array.isArray(d.fields) ? d.fields : [] }; });
    res.json({ composed: true, pathways: pathways.map(p => ({ slug: p.slug, version: p.version, title: p.title })), form: composeForm({ pathways, sets }),
      pins: rows.map(r => ({ setId: r.set_slug, srvAs: String(r.applied_id), version: r.set_version })) });
  });
}
module.exports = { mountComposedForm };
