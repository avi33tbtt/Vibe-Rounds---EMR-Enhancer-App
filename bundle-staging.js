'use strict';
// Task R6f-2a: stage a FHIR Bundle as PROPOSALS (stage, list, read one, reject one). Staging, listing, reading and rejecting create no clinical record.
// Task R6f-2b: accept ONE ready Observation proposal into a chart (case) the person chooses.
// Task R6f-2c: accept ONE ready Condition (problem list) or AllergyIntolerance proposal into a patient the person chooses. A MedicationRequest is never accepted, by either route.
// The parser is bundle-import.js (R6f-1, pure, unchanged). The request body IS the bundle; the person is the session user, never a value from the file.
// Stored: the bundle hash, the parser's counts and the proposal fields. Never the raw bundle, names, notes or Patient identifiers (the parser reports a count only).
// The same bundle (same hash) is staged once; a second try gives 409 with the id of the first. A proposal is rejected with a reason and the loaded row_version; rejected is final.
// Audit rows hold counts, ids and a hash only: never labels, values, reasons or identifiers. One permission, import:write, guards all four routes.
const express = require('express');
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');
const { parseBundle, BundleImportError } = require('./bundle-import');
const { shapeValue, parseInstant, FUTURE_SLACK_MS } = require('./observations');   // accept uses the SAME value rules as normal entry
const P = require('./problems'), AL = require('./allergies');                    // R6f-2c: and the same problem and allergy rules
const { can } = require('./permissions');

const BUNDLE_BODY_LIMIT = '2mb';   // up to 500 entries, so this route may exceed the 50 kb default (app.js skips the default for it)
const MAX_LIST = 50, MAX_REASON = 1000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// What the imported value type may be stored into (never converted): a whole number fits a number field and a number fits an integer field only if it is whole (shapeValue checks); text fits a text or select field; unknown fits any field.
const FITS = { number: ['number', 'integer'], integer: ['integer', 'number'], boolean: ['boolean'], text: ['text', 'select'], datetime: ['datetime'] };
const isBundleStagePath = p => p === '/api/import/bundles';
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}

function mountBundleStaging(app, pool) {
  const PCOLS = `p.id, p.bundle_id, p.key, p.kind, p.entry_index, p.fields, p.blockers, p.warnings, p.ready, p.source_status, p.starts_as, p.status, p.row_version,
                 ru.username AS rejected_by, p.rejected_at, p.reject_reason`;
  const PFROM = `FROM import_proposals p LEFT JOIN users ru ON ru.id = p.rejected_by`;
  const BCOLS = `b.id, b.bundle_hash, b.bundle_type, b.summary, b.warnings, b.rejected, su.username AS staged_by, b.staged_at`;
  const BFROM = `FROM import_bundles b JOIN users su ON su.id = b.staged_by`;
  const loadBundle = async (c, id) => {
    const bundle = (await c.query(`SELECT ${BCOLS} ${BFROM} WHERE b.id = $1`, [id])).rows[0];
    if (!bundle) return null;
    bundle.proposals = (await c.query(`SELECT ${PCOLS} ${PFROM} WHERE p.bundle_id = $1 ORDER BY p.entry_index, p.id`, [id])).rows;
    return bundle;
  };

  // The route-level parser comes AFTER the permission guard, so a signed-out or forbidden caller never makes the server read a large body.
  app.post('/api/import/bundles', A.requirePerm(pool, 'import:write'), express.json({ limit: BUNDLE_BODY_LIMIT }), async (req, res) => {
    let parsed;
    try { parsed = parseBundle(req.body); }
    catch (e) {
      if (!(e instanceof BundleImportError)) throw e;
      await audit(pool, req, 'import.refused', 'import_bundle', null, { reason: 'not_a_readable_bundle' });
      return res.status(400).json({ error: 'invalid_bundle', message: e.message });
    }
    const out = await tx(pool, async c => {
      const dup = (await c.query('SELECT id FROM import_bundles WHERE bundle_hash = $1', [parsed.audit.hash])).rows[0];
      if (dup) return { status: 409, body: { error: 'already_staged', message: 'This bundle was staged before.', bundleId: dup.id } };
      const id = (await c.query('INSERT INTO import_bundles(bundle_hash, bundle_type, summary, warnings, rejected, staged_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [parsed.audit.hash, parsed.audit.bundleType, JSON.stringify({ ...parsed.summary, byType: parsed.audit.byType }), JSON.stringify(parsed.warnings), JSON.stringify(parsed.rejected), req.user.id])).rows[0].id;
      for (const p of parsed.proposals) {
        await c.query(`INSERT INTO import_proposals(bundle_id, key, kind, entry_index, fields, blockers, warnings, ready, source_status, starts_as) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, p.key, p.kind, p.index, JSON.stringify(p.fields || {}), JSON.stringify(p.blockers), JSON.stringify(p.warnings), p.ready, p.sourceStatus || null, p.startsAs || null]);
      }
      await audit(c, req, 'import.stage', 'import_bundle', id, parsed.audit);
      return { status: 201, body: { bundle: await loadBundle(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  app.get('/api/import/bundles', A.requirePerm(pool, 'import:write'), async (req, res) => {
    const bundles = (await pool.query(`SELECT ${BCOLS},
        count(p.id) FILTER (WHERE p.status = 'staged')::int AS staged_count, count(p.id) FILTER (WHERE p.status = 'rejected')::int AS rejected_count, count(p.id) FILTER (WHERE p.status = 'accepted')::int AS accepted_count
      ${BFROM} LEFT JOIN import_proposals p ON p.bundle_id = b.id GROUP BY b.id, su.username ORDER BY b.id DESC LIMIT ${MAX_LIST}`)).rows;
    await audit(pool, req, 'import.bundles_view', 'import_bundle', null, { count: bundles.length });
    res.json({ bundles });
  });

  app.get('/api/import/bundles/:id', A.requirePerm(pool, 'import:write'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const bundle = await loadBundle(pool, id);
    if (!bundle) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'import.bundle_view', 'import_bundle', id, { proposals: bundle.proposals.length });
    res.json({ bundle });
  });

  app.post('/api/import/proposals/:id/reject', A.requirePerm(pool, 'import:write'), async (req, res) => {
    const s = strict(req.body, ['reason', 'rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
    if (!text(s.body.reason, MAX_REASON)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, bundle_id, kind, status, row_version FROM import_proposals WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.status !== 'staged') return { status: 409, body: { error: 'proposal_final', message: 'This proposal was already ' + p.status + '.', currentRowVersion: p.row_version } };
      if (p.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This proposal was changed by someone else. Reload it and try again.', currentRowVersion: p.row_version } };
      const reason = s.body.reason.trim();
      await c.query(`UPDATE import_proposals SET status = 'rejected', row_version = row_version + 1, rejected_by = $2, rejected_at = clock_timestamp(), reject_reason = $3 WHERE id = $1`, [id, req.user.id, reason]);
      await audit(c, req, 'import.proposal_reject', 'import_bundle', p.bundle_id, { proposalId: id, kind: p.kind, length: reason.length, rowVersion: rv + 1 });
      return { status: 200, body: { proposal: (await c.query(`SELECT ${PCOLS} ${PFROM} WHERE p.id = $1`, [id])).rows[0] } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- R6f-2b: accept ONE ready Observation proposal into a chart the person chooses ----------
     The person names the case (the chart), the applied set and the field: nothing is matched from the file, and the value is checked against the PINNED
     version of that field exactly like a normal entry (no conversion, a different or missing unit is refused). The recorder is the session user, the
     status is preliminary and the source is imported. One proposal makes one record; accepting twice is refused. Needs import:write AND cases:write. */
  app.post('/api/import/proposals/:id/accept', A.requirePerm(pool, 'import:write'), A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['rowVersion', 'caseId', 'appliedSetId', 'fieldKey']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion), caseId = posInt(s.body.caseId), asid = posInt(s.body.appliedSetId), key = s.body.fieldKey;
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (caseId === null) return bad(res, 'caseId is required: the chart is chosen by a person, never matched from the file.');
    if (asid === null) return bad(res, 'appliedSetId is required (the set applied to that chart that holds the field).');
    if (typeof key !== 'string' || !KEY_RE.test(key)) return bad(res, 'fieldKey must be 1 to 64 letters, digits, . _ - .');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const probe = (await c.query('SELECT id FROM import_proposals WHERE id = $1', [id])).rows[0];
      if (!probe) return { status: 404, body: { error: 'not_found' } };
      const cs = (await c.query('SELECT id, patient_id, status FROM clinical_cases WHERE id = $1 FOR UPDATE', [caseId])).rows[0];   // the case first, like every other record route
      if (!cs) return { status: 404, body: { error: 'case_not_found' } };
      if (cs.status === 'archived') return { status: 409, body: { error: 'case_archived', message: 'Restore the case before changing it.' } };
      const p = (await c.query('SELECT id, bundle_id, key, kind, fields, blockers, ready, starts_as, status, row_version FROM import_proposals WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (p.status !== 'staged') return { status: 409, body: { error: 'proposal_final', message: 'This proposal was already ' + p.status + '.', currentRowVersion: p.row_version } };
      if (p.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This proposal was changed by someone else. Reload it and try again.', currentRowVersion: p.row_version } };
      if (p.kind === 'MedicationRequest') return { status: 409, body: { error: 'never_acceptable', message: 'An imported bundle never creates a medication order.' } };
      if (p.kind !== 'Observation') return { status: 409, body: { error: 'not_accepted_here', message: 'Only an Observation proposal can be accepted by this route; use accept-to-patient for a problem or an allergy.' } };
      if (!p.ready) return { status: 409, body: { error: 'blocked', message: 'A proposal with blockers cannot be accepted.', blockers: p.blockers } };
      const a = (await c.query('SELECT id, state, element_set_version_id FROM case_applied_sets WHERE id = $1 AND case_id = $2', [asid, cs.id])).rows[0];
      if (!a) return { status: 404, body: { error: 'applied_set_not_found', message: 'That set is not applied to this chart.' } };
      if (a.state !== 'active') return { status: 409, body: { error: 'set_not_active', message: `That set is ${a.state}; it takes no new values.` } };
      const def = (await c.query('SELECT definition_json FROM element_set_versions WHERE id = $1', [a.element_set_version_id])).rows[0].definition_json;
      const field = ((def || {}).fields || []).find(f => f && f.id === key);
      const f = p.fields, refuse = (error, message) => ({ status: 400, body: { error, message } });
      if (field && f.valueType !== 'unknown' && !(FITS[f.valueType] || []).includes(field.type)) return refuse('value_does_not_fit', `A ${f.valueType} value does not fit a field of type "${field.type}".`);
      const fieldUnit = field && typeof field.unit === 'string' && field.unit ? field.unit : null;
      if (field && fieldUnit && f.valueType !== 'unknown' && !f.unit) return refuse('invalid_unit', `The field "${key}" has the unit ${fieldUnit} but the imported value has no unit; a unit is never assumed.`);
      const item = f.valueType === 'unknown' ? { unknown: true } : { value: f.value, ...(f.unit ? { unit: f.unit } : {}) };
      const r = shapeValue(field, item);
      if (r.error) return refuse(r.error[0], r.error[1]);
      const t = parseInstant(f.effectiveAt);
      if (t === null) return refuse('invalid', 'The imported effective time is not a usable date and time.');
      if (t > Date.now() + FUTURE_SLACK_MS) return { status: 409, body: { error: 'effective_in_future', message: 'The effective time is in the future; this proposal cannot be accepted.' } };
      const oid = Number((await c.query(
        `INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, unit_display, effective_at, source_type, source_ref, status, recorded_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,'imported',$8,'preliminary',$9) RETURNING id`,
        [cs.id, a.id, key, r.type, r.json === null ? null : JSON.stringify(r.json), r.unit, f.effectiveAt, 'import:' + p.bundle_id + '/' + p.key, req.user.id])).rows[0].id);
      const enc = (await c.query(`SELECT ce.encounter_id FROM case_encounters ce JOIN encounters e ON e.id = ce.encounter_id WHERE ce.case_id = $1 AND e.status = 'open' ORDER BY ce.id DESC LIMIT 1`, [cs.id])).rows[0];
      await c.query('INSERT INTO clinical_events(case_id, encounter_id, event_type, actor_id, detail) VALUES ($1,$2,$3,$4,$5)',
        [cs.id, enc ? enc.encounter_id : null, 'observation_recorded', req.user.id, JSON.stringify({ count: 1, observationIds: [oid], appliedSetIds: [a.id], importProposalId: id })]);
      await c.query('UPDATE clinical_cases SET updated_at = now() WHERE id = $1', [cs.id]);
      await c.query(`UPDATE import_proposals SET status = 'accepted', row_version = row_version + 1, accepted_by = $2, accepted_at = clock_timestamp(), accepted_patient_id = $3, accepted_record_type = 'observation', accepted_record_id = $4 WHERE id = $1`,
        [id, req.user.id, cs.patient_id, oid]);
      await audit(c, req, 'observation.record', 'case', cs.id, { count: 1, observationIds: [oid], importProposalId: id });   // ids only, like normal entry: values never go into the audit log
      await audit(c, req, 'import.proposal_accept', 'import_bundle', p.bundle_id, { proposalId: id, kind: p.kind, caseId: cs.id, observationId: oid, rowVersion: rv + 1 });
      const observation = (await c.query(`SELECT o.id, o.case_id, o.applied_set_id, o.field_key, o.value_type, o.value_json AS value, o.unit_display, o.effective_at, o.recorded_at, o.source_type, o.source_ref, o.status, ru.username AS recorded_by
                                          FROM observations o JOIN users ru ON ru.id = o.recorded_by WHERE o.id = $1`, [oid])).rows[0];
      return { status: 200, body: { proposal: (await c.query(`SELECT ${PCOLS}, p.accepted_at, p.accepted_patient_id, p.accepted_record_type, p.accepted_record_id ${PFROM} WHERE p.id = $1`, [id])).rows[0], observation: { ...observation, id: Number(observation.id) } } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- R6f-2c: accept ONE ready Condition (problem list) or AllergyIntolerance proposal into a patient the person chooses ----------
     Problems and allergies belong to the patient, so the person names patientId (and, if they wish, one of that patient's cases as originCaseId): nothing is matched from the file.
     The record is made by the same rules as normal entry (same label, date, reaction and severity checks; an archived patient is refused). The recorder is the session user and it starts active,
     as the parser warned when the source said otherwise. Needs import:write AND the permission of the kind (problems:write or allergies:write). MedicationRequest is never accepted. */
  const KIND_PERM = { Condition: 'problems:write', AllergyIntolerance: 'allergies:write' };
  app.post('/api/import/proposals/:id/accept-to-patient', A.requirePerm(pool, 'import:write'), async (req, res) => {
    const s = strict(req.body, ['rowVersion', 'patientId', 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion), pid = posInt(s.body.patientId), origin = s.body.originCaseId === undefined || s.body.originCaseId === null ? null : posInt(s.body.originCaseId);
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (pid === null) return bad(res, 'patientId is required: the chart is chosen by a person, never matched from the file.');
    if (s.body.originCaseId !== undefined && s.body.originCaseId !== null && origin === null) return bad(res, 'originCaseId must be a whole number.');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const probe = (await c.query('SELECT kind FROM import_proposals WHERE id = $1', [id])).rows[0];
      if (!probe) return { status: 404, body: { error: 'not_found' } };
      const need = KIND_PERM[probe.kind];
      if (need && !can(req.user.role, need)) {
        await audit(c, req, 'permission.denied', null, null, { perm: need, method: req.method, path: req.path });
        return { status: 403, body: { error: 'forbidden', perm: need } };
      }
      const pt = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];   // the patient first, like the problem and allergy routes
      if (!pt) return { status: 404, body: { error: 'patient_not_found' } };
      if (pt.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before adding a record.' } };
      const p = (await c.query('SELECT id, bundle_id, key, kind, fields, blockers, ready, status, row_version FROM import_proposals WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (p.status !== 'staged') return { status: 409, body: { error: 'proposal_final', message: 'This proposal was already ' + p.status + '.', currentRowVersion: p.row_version } };
      if (p.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This proposal was changed by someone else. Reload it and try again.', currentRowVersion: p.row_version } };
      if (p.kind === 'MedicationRequest') return { status: 409, body: { error: 'never_acceptable', message: 'An imported bundle never creates a medication order.' } };
      if (!need) return { status: 409, body: { error: 'not_accepted_here', message: 'Only a Condition or AllergyIntolerance proposal can be accepted by this route; use accept for an Observation.' } };
      if (!p.ready) return { status: 409, body: { error: 'blocked', message: 'A proposal with blockers cannot be accepted.', blockers: p.blockers } };
      if (origin !== null && !(await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      const f = p.fields, refuse = message => ({ status: 400, body: { error: 'invalid', message } });
      let recId, type, auditRow;
      if (p.kind === 'Condition') {
        if (!P.okLabel(f.label)) return refuse('The imported problem name is not acceptable (1 to 200 characters).');
        if (f.onsetDate != null && !P.okDate(f.onsetDate)) return refuse('The imported onset date is not usable (it must be a real date, not in the future).');
        recId = (await c.query('INSERT INTO patient_problems(patient_id, origin_case_id, label, onset_date, recorded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [pid, origin, f.label, f.onsetDate == null ? null : f.onsetDate, req.user.id])).rows[0].id;
        await c.query(`INSERT INTO patient_problem_events(problem_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [recId, req.user.id]);
        type = 'problem'; auditRow = ['problem.add', { problemId: recId, originCaseId: origin, length: f.label.length }];
      } else {
        if (!AL.okLabel(f.substance)) return refuse('The imported substance is not acceptable (1 to 200 characters).');
        if (f.reaction != null && !AL.okReaction(f.reaction)) return refuse('The imported reaction is not acceptable (1 to 500 characters).');
        if (f.severity != null && !AL.SEVERITIES.includes(f.severity)) return refuse('The imported severity is not mild, moderate or severe.');
        if (f.onsetDate != null && !AL.okDate(f.onsetDate)) return refuse('The imported onset date is not usable (it must be a real date, not in the future).');
        recId = (await c.query('INSERT INTO patient_allergies(patient_id, origin_case_id, substance, reaction, severity, onset_date, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [pid, origin, f.substance, f.reaction == null ? null : f.reaction, f.severity == null ? null : f.severity, f.onsetDate == null ? null : f.onsetDate, req.user.id])).rows[0].id;
        await c.query(`INSERT INTO patient_allergy_events(allergy_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [recId, req.user.id]);
        type = 'allergy'; auditRow = ['allergy.add', { allergyId: recId, originCaseId: origin, substanceLength: f.substance.length }];
      }
      recId = Number(recId);
      await c.query(`UPDATE import_proposals SET status = 'accepted', row_version = row_version + 1, accepted_by = $2, accepted_at = clock_timestamp(), accepted_patient_id = $3, accepted_record_type = $4, accepted_record_id = $5 WHERE id = $1`,
        [id, req.user.id, pid, type, recId]);
      await audit(c, req, auditRow[0], 'patient', pid, auditRow[1]);   // ids and lengths only, like normal entry
      await audit(c, req, 'import.proposal_accept', 'import_bundle', p.bundle_id, { proposalId: id, kind: p.kind, patientId: pid, recordType: type, recordId: recId, rowVersion: rv + 1 });
      const rec = type === 'problem'
        ? (await c.query(`SELECT r.id, r.patient_id, r.origin_case_id, r.label, to_char(r.onset_date, 'YYYY-MM-DD') AS onset_date, r.status, u.username AS recorded_by FROM patient_problems r JOIN users u ON u.id = r.recorded_by WHERE r.id = $1`, [recId])).rows[0]
        : (await c.query(`SELECT r.id, r.patient_id, r.origin_case_id, r.substance, r.reaction, r.severity, to_char(r.onset_date, 'YYYY-MM-DD') AS onset_date, r.status, u.username AS recorded_by FROM patient_allergies r JOIN users u ON u.id = r.recorded_by WHERE r.id = $1`, [recId])).rows[0];
      return { status: 200, body: { proposal: (await c.query(`SELECT ${PCOLS}, p.accepted_at, p.accepted_patient_id, p.accepted_record_type, p.accepted_record_id ${PFROM} WHERE p.id = $1`, [id])).rows[0], [type]: rec } };
    });
    res.status(out.status).json(out.body);
  });
}
module.exports = { mountBundleStaging, isBundleStagePath };
