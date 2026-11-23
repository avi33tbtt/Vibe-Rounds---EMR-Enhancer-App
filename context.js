'use strict';
// Task B5: the context service. One read route that turns ONE case into a minimal, versioned "context envelope",
// the only thing that may cross from this app to the CCIS app (CCIS docs/IMPORT-CONTRACT.md, draft 0.1, items IMP-nnn).
// Built to the DRAFT contract: field names will change when CCIS Stage 2 fixes the shape (IMP-122). Nothing here is final.
//
// What is left out, always (IMP-090 says the envelope declares it, so a reader sees "withheld", not "forgotten"):
//   identity   : no name, MRN, date of birth, username, display name, patient id or case number. The case is a keyed pseudonym.
//   narrative  : no case narrative, no notes, no free-text observation values, no source_ref, no change or error reasons.
//   entered-in-error rows: only with purpose=audit AND include=entered_in_error (IMP-092), marked as such (IMP-095).
//   system events: the timeline events are EMR actions, not clinical events classified by meaning, so they are left out with a declared count (IMP-061).
// Nothing is coerced (IMP-108): an unknown value stays "unknown", a number without a unit is not called a quantity, a code is never "verified".
const crypto = require('crypto');
const { audit } = require('./audit');
const A = require('./auth');
const PKG = require('./package.json');

const CONTEXT_VERSION = '0.1.0';
const CONTRACT = 'CCIS IMPORT-CONTRACT draft 0.1';
const MAX_OBSERVATIONS = 50000;
// Purposes the exporter knows. Identity can never be included (IMP-096). Narrative is never included in this version.
const PURPOSES = { analytics: { mayInclude: [] }, audit: { mayInclude: ['entered_in_error'] } };
const SOURCE_CLASS = { patient: 'patient_reported', clinician: 'clinician_entered', imported: 'imported', device: 'device', derived: 'derived', ai_proposed: 'ai_proposed' };

const iso = d => (d instanceof Date ? d : new Date(d)).toISOString();   // always UTC with Z: an explicit offset (IMP-011, IMP-046)
const rank = rows => new Map(rows.slice().sort((a, b) => Number(a.id) - Number(b.id)).map((r, i) => [Number(r.id), i + 1]));

// The keyed pseudonym (IMP-020): same case, same reference; no way back without the server secret; not the case number.
function caseRef(secret, caseId) {
  return 'cx_' + crypto.createHmac('sha256', secret).update('emr-context-case-ref:' + caseId).digest('hex').slice(0, 32);
}

// The value of one observation row, typed (IMP-041, IMP-042). Returns null for an explicitly unknown value.
function shapeValue(o) {
  if (o.value_type === 'unknown') return null;
  if (o.value_type === 'number' || o.value_type === 'integer') {
    if (o.unit_display) return { kind: 'quantity', value: o.value_json, unit: { display: o.unit_display, code: null } };   // the unit code stays null until a terminology verifier exists
    return { kind: o.value_type === 'integer' ? 'integer' : 'decimal', value: o.value_json };
  }
  if (o.value_type === 'boolean') return { kind: 'boolean', value: o.value_json };
  if (o.value_type === 'datetime') return { kind: 'datetime', value: o.value_json };
  return { kind: 'selection', value: o.value_json };   // a choice from the field's listed options, not a code
}

// Pure and deterministic: the same input and the same `now` give the same bytes. `input` is plain rows, no database here.
function buildEnvelope(input, { secret, now, purpose = 'analytics', include = [] }) {
  const { caseId, appliedSets, appliedPathways, observations, eventCount } = input;
  const withEE = include.includes('entered_in_error');
  const setRef = rank(appliedSets), pwRef = rank(appliedPathways), obRef = rank(observations);
  const fieldsOf = new Map(appliedSets.map(a => [Number(a.id), new Map(((a.definition_json || {}).fields || []).filter(f => f && f.id).map(f => [f.id, f]))]));
  const corrected = new Set(observations.filter(o => o.corrects_id != null).map(o => Number(o.corrects_id)));

  const items = [];
  for (const a of appliedSets.slice().sort((x, y) => x.id - y.id)) {
    items.push({
      kind: 'applied_set', ref: 'as-' + setRef.get(Number(a.id)), set_key: a.slug, version: a.version, checksum: a.checksum, state: a.state,
      applied_at: iso(a.applied_at), state_at: a.state_at ? iso(a.state_at) : null,
      supersedes_ref: a.supersedes_id == null ? null : 'as-' + setRef.get(Number(a.supersedes_id)),
      from_pathway_ref: a.from_applied_pathway_id == null ? null : 'ap-' + pwRef.get(Number(a.from_applied_pathway_id)),
    });
  }
  for (const p of appliedPathways.slice().sort((x, y) => x.id - y.id)) {
    items.push({ kind: 'applied_pathway', ref: 'ap-' + pwRef.get(Number(p.id)), pathway_key: p.slug, version: p.version, checksum: p.checksum, applied_at: iso(p.applied_at) });
  }

  const withheld = { narrative_observations: 0, entered_in_error_observations: 0, unclassified_events: eventCount };
  const kept = new Set();
  const obs = [];
  for (const o of observations.slice().sort((x, y) => new Date(x.effective_at) - new Date(y.effective_at) || Number(x.id) - Number(y.id))) {
    if (o.status === 'entered_in_error' && !withEE) { withheld.entered_in_error_observations++; continue; }
    if (o.value_type === 'text') { withheld.narrative_observations++; continue; }   // free text is narrative (identity could hide in it)
    kept.add(Number(o.id));
    obs.push(o);
  }

  const provenance = [], provIndex = new Map();
  const provRef = p => {
    const k = JSON.stringify(p);
    if (!provIndex.has(k)) { provenance.push({ ref: 'pv-' + (provenance.length + 1), ...p }); provIndex.set(k, 'pv-' + provenance.length); }
    return provIndex.get(k);
  };

  for (const o of obs) {
    const a = appliedSets.find(s => Number(s.id) === Number(o.applied_set_id));
    const field = (fieldsOf.get(Number(o.applied_set_id)) || new Map()).get(o.field_key);
    const sourceClass = SOURCE_CLASS[o.source_type];
    const codes = ((field && Array.isArray(field.bindings)) ? field.bindings : []).filter(b => b && b.system && b.code)
      .map(b => ({ system: String(b.system), system_version: null, code: String(b.code), display: b.display == null ? null : String(b.display), verification: 'unverified' }));   // the server cannot verify codes (IMP-072); none = none (IMP-073)
    const value = shapeValue(o);
    const item = {
      kind: 'observation', ref: 'ob-' + obRef.get(Number(o.id)), applied_set_ref: 'as-' + setRef.get(Number(o.applied_set_id)),
      concept: { set_key: a.slug, field_key: o.field_key, codes },
      value, value_state: o.status === 'entered_in_error' ? 'entered_in_error' : (value === null ? 'unknown' : 'recorded'),
      effective_at: iso(o.effective_at), recorded_at: iso(o.recorded_at), status: o.status, source_class: sourceClass,
      provenance_ref: provRef({ source_class: sourceClass, supplied_by_role: o.recorded_role, origin: { set_key: a.slug, set_version: a.version }, verified: false, corrected: corrected.has(Number(o.id)) }),
      corrects_ref: o.corrects_id == null ? null : (kept.has(Number(o.corrects_id)) ? 'ob-' + obRef.get(Number(o.corrects_id)) : null),
      flags: { ai_proposed: o.source_type === 'ai_proposed', derived: o.source_type === 'derived' },
    };
    if (o.corrects_id != null && item.corrects_ref === null) item.correction_target_withheld = true;   // the original is withheld: say so, do not leave a dangling reference
    if (o.source_type === 'derived') item.derivation = { recorded: false };                          // the EMR stores no formula or sources for a derived row (IMP-050): say so
    items.push(item);
  }

  return {
    context_version: CONTEXT_VERSION, contract: CONTRACT, exported_at: iso(now), producer: { system: 'emr-enhancer', version: PKG.version }, purpose,
    declared: {
      included_categories: withEE ? ['entered_in_error'] : [],
      excluded_categories: withEE ? ['identity', 'narrative'] : ['identity', 'narrative', 'entered_in_error'],
      withheld,
    },
    case_ref: caseRef(secret, caseId), items, provenance,
  };
}

function mountContext(app, pool, opts = {}) {
  const now = opts.contextNow || (() => new Date());
  const secret = () => opts.contextSecret ?? process.env.CONTEXT_REF_SECRET ?? '';
  const bad = (res, error, message) => res.status(400).json({ error, message });

  app.get('/api/cases/:id/context', A.requirePerm(pool, 'context:read'), async (req, res) => {
    const caseId = /^\d{1,9}$/.test(String(req.params.id)) && +req.params.id >= 1 ? +req.params.id : null;
    const extra = Object.keys(req.query).filter(k => !['purpose', 'include'].includes(k));
    if (extra.length) return bad(res, 'unknown_parameter', 'These parameters are not accepted: ' + extra.slice(0, 5).join(', '));
    if ((req.query.purpose !== undefined && typeof req.query.purpose !== 'string') || (req.query.include !== undefined && typeof req.query.include !== 'string')) return bad(res, 'invalid', 'purpose and include are single values.');
    const purpose = req.query.purpose === undefined ? 'analytics' : req.query.purpose;
    if (!Object.prototype.hasOwnProperty.call(PURPOSES, purpose)) return bad(res, 'unknown_purpose', 'Known purposes: ' + Object.keys(PURPOSES).join(', ') + '.');
    const include = req.query.include === undefined || req.query.include === '' ? [] : req.query.include.split(',');
    if (include.some(c => !PURPOSES[purpose].mayInclude.includes(c)) || new Set(include).size !== include.length) {
      return bad(res, 'include_not_allowed', `purpose "${purpose}" may include: ${PURPOSES[purpose].mayInclude.join(', ') || 'nothing beyond the default'}.`);
    }
    if (!caseId) return res.status(404).json({ error: 'not_found' });

    const c = await pool.connect();
    let input;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');   // one consistent snapshot of the case
      if (!(await c.query('SELECT 1 FROM clinical_cases WHERE id = $1', [caseId])).rows.length) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
      const q = (sql, p) => c.query(sql, p).then(r => r.rows);
      const appliedSets = await q(`SELECT a.id, s.slug, v.version, v.checksum, v.definition_json, a.state, a.applied_at, a.state_at, a.supersedes_id, a.from_applied_pathway_id
                                     FROM case_applied_sets a JOIN element_set_versions v ON v.id = a.element_set_version_id JOIN element_sets s ON s.id = a.element_set_id
                                    WHERE a.case_id = $1 ORDER BY a.id`, [caseId]);
      const appliedPathways = await q(`SELECT ap.id, pw.slug, pv.version, pv.checksum, ap.applied_at FROM case_applied_pathways ap
                                         JOIN pathway_versions pv ON pv.id = ap.pathway_version_id JOIN pathways pw ON pw.id = ap.pathway_id WHERE ap.case_id = $1 ORDER BY ap.id`, [caseId]);
      const observations = await q(`SELECT o.id, o.applied_set_id, o.field_key, o.value_type, o.value_json, o.unit_display, o.effective_at, o.recorded_at, o.source_type, o.status, o.corrects_id, u.role AS recorded_role
                                      FROM observations o JOIN users u ON u.id = o.recorded_by WHERE o.case_id = $1 ORDER BY o.id LIMIT $2`, [caseId, MAX_OBSERVATIONS + 1]);
      const eventCount = (await q('SELECT count(*)::int AS n FROM clinical_events WHERE case_id = $1', [caseId]))[0].n;
      await c.query('COMMIT');
      input = { caseId, appliedSets, appliedPathways, observations, eventCount };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally { c.release(); }

    if (input.observations.length > MAX_OBSERVATIONS) return res.status(413).json({ error: 'too_large', message: `A context envelope holds at most ${MAX_OBSERVATIONS} observations.` });
    if (String(secret()).length < 32) return res.status(503).json({ error: 'context_not_configured', message: 'Set CONTEXT_REF_SECRET (at least 32 characters) on the server.' });

    const envelope = buildEnvelope(input, { secret: secret(), now: now(), purpose, include });
    await audit(pool, req, 'context.export', 'case', caseId, { purpose, include, contextVersion: CONTEXT_VERSION, items: envelope.items.length, withheld: envelope.declared.withheld });   // counts only, never values
    res.set('Cache-Control', 'no-store').json(envelope);
  });
}

module.exports = { mountContext, buildEnvelope, caseRef, CONTEXT_VERSION, PURPOSES };
