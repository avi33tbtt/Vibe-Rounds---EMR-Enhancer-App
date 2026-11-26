'use strict';
// Task B3a: applied sets (the version pin), observations and the clinical timeline, on the server.
// Routes are registered straight on the app (no nested router) so the safety tests see them.
// Every actor (applied_by, recorded_by, error_by, actor_id) comes from the session; a body that names one is refused.
// Values are checked against the PINNED version of the set and are never coerced: a wrong type, an unlisted option or a wrong unit is refused.
// Nothing is overwritten or deleted (the database refuses it too, migration 011): a correction is a new row, a wrong entry is marked entered_in_error.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const SOURCES = ['patient', 'clinician', 'imported', 'device', 'derived', 'ai_proposed'];
const NEW_STATUS = ['preliminary', 'final'];            // 'amended' only through the correct route, 'entered_in_error' only through its route
const NUMERIC = ['number', 'integer'];
const MAX_BATCH = 50, MAX_TEXT = 4000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;   // NUL and lone surrogates (the JSON column cannot hold them)
const FUTURE_SLACK_MS = 5 * 60 * 1000;                  // a clock a few minutes fast is fine; a value dated later is not "when it was true"

const bad = (res, message, extra = {}) => res.status(400).json({ error: 'invalid', message, ...extra });
// Only these body keys are accepted per route. Anything else (recordedBy, userId, signedBy ...) is refused, not ignored.
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const isStr = v => typeof v === 'string';
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const cleanReason = v => (isStr(v) ? v.trim() : '');

// An ISO 8601 instant WITH an explicit offset (a bare local time is ambiguous, so it is refused). The calendar is checked too:
// Date.parse alone rolls 30 February over into March.
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-](\d{2}):(\d{2}))$/;
function parseInstant(s) {
  if (!isStr(s) || s.length > 40) return null;
  const m = ISO.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], m[6] === undefined ? 0 : +m[6]];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || se > 59) return null;
  if (m[7] !== 'Z' && (+m[8] > 23 || +m[9] > 59)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) || y < 1900 ? null : t;
}

// Check one value against the field of the pinned version. Returns { error } or { type, json, unit }.
function shapeValue(field, item) {
  if (!field) return { error: ['unknown_field_key', 'That field is not in the version of the set this case applied.'] };
  if (field.derived === true) return { error: ['derived_field', 'A derived field is computed, never stored as a value.'] };
  if (item.unknown !== undefined && item.unknown !== true) return { error: ['invalid', 'unknown must be true or left out.'] };
  if (item.unknown === true) {
    if (Object.prototype.hasOwnProperty.call(item, 'value') || item.unit !== undefined) return { error: ['invalid', 'An explicitly unknown value has no value and no unit.'] };
    return { type: 'unknown', json: null, unit: null };
  }
  if (!Object.prototype.hasOwnProperty.call(item, 'value')) return { error: ['invalid', 'value is required (or send unknown: true).'] };
  const v = item.value, t = field.type;
  let json, err;
  if (t === 'text') { if (!isStr(v) || !v.trim() || v.length > MAX_TEXT || BAD_CHARS.test(v)) err = `must be text of 1 to ${MAX_TEXT} characters.`; else json = v; }
  else if (t === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) err = 'must be a number (numbers sent as text are not accepted).'; else json = v; }
  else if (t === 'integer') { if (!Number.isSafeInteger(v)) err = 'must be a whole number.'; else json = v; }
  else if (t === 'boolean') { if (typeof v !== 'boolean') err = 'must be true or false.'; else json = v; }
  else if (t === 'select') {
    if (!Array.isArray(field.options) || !field.options.length) err = 'cannot be checked: the field lists no options.';
    else if (!isStr(v) || !field.options.includes(v)) err = 'must be one of the listed options.';
    else json = v;
  }
  else if (t === 'datetime') { if (parseInstant(v) === null) err = 'must be a date and time like 2026-11-23T10:30:00+05:45 (with its offset).'; else json = v; }
  else return { error: ['unsupported_field_type', `Fields of type "${t}" cannot hold a value.`] };
  if (err) return { error: ['invalid_value', `Value for "${field.id}" ${err}`] };
  // unit: only numeric fields have one, and it is the field's own unit; a different unit is refused, not converted
  const fieldUnit = isStr(field.unit) && field.unit ? field.unit : null;
  if (item.unit !== undefined) {
    if (!NUMERIC.includes(t) || !fieldUnit) return { error: ['invalid_unit', `"${field.id}" has no unit.`] };
    if (item.unit !== fieldUnit) return { error: ['invalid_unit', `The unit of "${field.id}" is ${fieldUnit}; other units are not converted.`] };
  }
  return { type: t, json, unit: NUMERIC.includes(t) ? fieldUnit : null };
}

// One applied-set row as the API shows it. A pin made by a pathway names that application (B4a): from_pathway_* are NULL for a plain pin.
const APPLIED = `a.id, a.element_set_id, s.slug, s.title AS set_title, v.version, v.checksum, a.state, a.supersedes_id, a.applied_at,
                 au.username AS applied_by, a.state_at, su.username AS state_by,
                 a.from_applied_pathway_id, pw.id AS from_pathway_id, pw.slug AS from_pathway_slug, pv.title AS from_pathway_title, pv.version AS from_pathway_version`;
const APPLIED_FROM = `FROM case_applied_sets a JOIN element_set_versions v ON v.id = a.element_set_version_id JOIN element_sets s ON s.id = a.element_set_id
                      JOIN users au ON au.id = a.applied_by LEFT JOIN users su ON su.id = a.state_by
                      LEFT JOIN case_applied_pathways ap ON ap.id = a.from_applied_pathway_id LEFT JOIN pathway_versions pv ON pv.id = ap.pathway_version_id
                      LEFT JOIN pathways pw ON pw.id = ap.pathway_id`;

function mountObservations(app, pool) {
  const lockCase = async (c, id) => (await c.query('SELECT id, patient_id, status FROM clinical_cases WHERE id = $1 FOR UPDATE', [id])).rows[0];
  const notFound = { status: 404, body: { error: 'not_found' } };
  const archived = { status: 409, body: { error: 'case_archived', message: 'Restore the case before changing it.' } };
  const fieldOf = async (c, versionId, key, cache) => {
    if (!cache.has(versionId)) cache.set(versionId, (await c.query('SELECT definition_json FROM element_set_versions WHERE id = $1', [versionId])).rows[0].definition_json);
    return ((cache.get(versionId) || {}).fields || []).find(f => f && f.id === key);
  };
  // The clinical timeline event; the encounter is the case's open linked encounter at that moment (or none).
  const event = async (c, caseId, type, userId, detail) => {
    const enc = (await c.query(`SELECT ce.encounter_id FROM case_encounters ce JOIN encounters e ON e.id = ce.encounter_id
                                 WHERE ce.case_id = $1 AND e.status = 'open' ORDER BY ce.id DESC LIMIT 1`, [caseId])).rows[0];
    await c.query('INSERT INTO clinical_events(case_id, encounter_id, event_type, actor_id, detail) VALUES ($1,$2,$3,$4,$5)',
      [caseId, enc ? enc.encounter_id : null, type, userId, JSON.stringify(detail)]);
  };
  const touch = (c, caseId) => c.query('UPDATE clinical_cases SET updated_at = now() WHERE id = $1', [caseId]);
  const appliedRow = async (c, id) => (await c.query(`SELECT ${APPLIED} ${APPLIED_FROM} WHERE a.id = $1`, [id])).rows[0];
  const OBS = `o.id, o.case_id, o.applied_set_id, a.element_set_id, s.slug AS set_slug, v.version AS set_version, o.field_key, o.value_type, o.value_json AS value,
               o.unit_display, o.effective_at, o.recorded_at, o.source_type, o.source_ref, o.status, ru.username AS recorded_by, o.corrects_id, o.change_reason,
               eu.username AS error_by, o.error_at, o.error_reason, (SELECT k.id FROM observations k WHERE k.corrects_id = o.id) AS corrected_by_id`;
  const OBS_FROM = `FROM observations o JOIN case_applied_sets a ON a.id = o.applied_set_id JOIN element_set_versions v ON v.id = a.element_set_version_id
                    JOIN element_sets s ON s.id = a.element_set_id JOIN users ru ON ru.id = o.recorded_by LEFT JOIN users eu ON eu.id = o.error_by`;
  const obsRow = async (c, id) => (await c.query(`SELECT ${OBS} ${OBS_FROM} WHERE o.id = $1`, [id])).rows[0];
  const numId = o => o && { ...o, id: Number(o.id), corrects_id: o.corrects_id == null ? null : Number(o.corrects_id), corrected_by_id: o.corrected_by_id == null ? null : Number(o.corrected_by_id) };

  /* ---------- apply a published set version (pin it); a newer version over an active pin is the explicit update ---------- */
  app.post('/api/cases/:id/applied-sets', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['setId', 'version']);
    if (s.error) return res.status(400).json(s.error);
    const setId = posInt(s.body.setId), version = posInt(s.body.version);
    if (!setId || !version) return bad(res, 'setId and version must be whole numbers.');
    const out = await tx(pool, async c => {
      const cs = await lockCase(c, req.params.id);
      if (!cs) return notFound;
      if (cs.status === 'archived') return archived;
      const v = (await c.query('SELECT id, status FROM element_set_versions WHERE element_set_id = $1 AND version = $2', [setId, version])).rows[0];
      if (!v) return { status: 404, body: { error: 'version_not_found' } };
      if (v.status !== 'published') return { status: 409, body: { error: 'not_published', message: 'Only a published version of a set can be applied to a case.' } };
      const cur = (await c.query(`SELECT a.id, a.element_set_version_id, v.version FROM case_applied_sets a JOIN element_set_versions v ON v.id = a.element_set_version_id
                                   WHERE a.case_id = $1 AND a.element_set_id = $2 AND a.state = 'active' FOR UPDATE OF a`, [cs.id, setId])).rows[0];
      if (cur && cur.element_set_version_id === v.id) return { status: 409, body: { error: 'already_applied', message: 'This version is already applied to the case.' } };
      if (cur && version < cur.version) return { status: 409, body: { error: 'not_newer', message: `Version ${cur.version} is applied; an update must be a newer version.` } };
      if (cur) await c.query(`UPDATE case_applied_sets SET state = 'superseded', state_by = $2, state_at = clock_timestamp() WHERE id = $1`, [cur.id, req.user.id]);
      const id = (await c.query('INSERT INTO case_applied_sets(case_id, element_set_id, element_set_version_id, applied_by, supersedes_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [cs.id, setId, v.id, req.user.id, cur ? cur.id : null])).rows[0].id;
      await event(c, cs.id, cur ? 'set_upgraded' : 'set_applied', req.user.id, { appliedSetId: id, setId, version, ...(cur ? { fromAppliedSetId: cur.id, fromVersion: cur.version } : {}) });
      await touch(c, cs.id);
      await audit(c, req, cur ? 'case.set_upgrade' : 'case.set_apply', 'case', cs.id, { appliedSetId: id, setId, version, ...(cur ? { fromVersion: cur.version } : {}) });
      return { status: 201, body: { appliedSet: await appliedRow(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- withdraw a set from a case: the pin and its values stay, the set just takes no new values ---------- */
  app.post('/api/cases/:id/applied-sets/:asid/withdraw', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, []);
    if (s.error) return res.status(400).json(s.error);
    const asid = idParam(req.params.asid);
    if (!asid) return bad(res, 'The applied set id must be a whole number.');
    const out = await tx(pool, async c => {
      const cs = await lockCase(c, req.params.id);
      if (!cs) return notFound;
      if (cs.status === 'archived') return archived;
      const a = (await c.query('SELECT id, state, element_set_id FROM case_applied_sets WHERE id = $1 AND case_id = $2 FOR UPDATE', [asid, cs.id])).rows[0];
      if (!a) return { status: 404, body: { error: 'applied_set_not_found' } };
      if (a.state !== 'active') return { status: 409, body: { error: 'not_active', message: `This set is already ${a.state}.` } };
      await c.query(`UPDATE case_applied_sets SET state = 'withdrawn', state_by = $2, state_at = clock_timestamp() WHERE id = $1`, [a.id, req.user.id]);
      await event(c, cs.id, 'set_withdrawn', req.user.id, { appliedSetId: a.id, setId: a.element_set_id });
      await touch(c, cs.id);
      await audit(c, req, 'case.set_withdraw', 'case', cs.id, { appliedSetId: a.id });
      return { status: 200, body: { appliedSet: await appliedRow(c, a.id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- add observations (all or none) ---------- */
  app.post('/api/cases/:id/observations', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['observations']);
    if (s.error) return res.status(400).json(s.error);
    const list = s.body.observations;
    if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) return bad(res, `observations must be a list of 1 to ${MAX_BATCH} entries.`);
    const items = [];
    for (let i = 0; i < list.length; i++) {
      const it = strict(list[i], ['appliedSetId', 'fieldKey', 'value', 'unknown', 'unit', 'effectiveAt', 'sourceType', 'sourceRef', 'status']);
      if (it.error) return res.status(400).json({ ...it.error, index: i });
      const b = it.body, fail = m => bad(res, `Entry ${i + 1}: ${m}`, { index: i });
      if (!posInt(b.appliedSetId)) return fail('appliedSetId must be a whole number.');
      if (!isStr(b.fieldKey) || !KEY_RE.test(b.fieldKey)) return fail('fieldKey must be 1 to 64 letters, digits, . _ - .');
      if (!SOURCES.includes(b.sourceType)) return fail('sourceType must be one of: ' + SOURCES.join(', ') + '.');
      if (b.sourceRef !== undefined && (!isStr(b.sourceRef) || !b.sourceRef.trim() || b.sourceRef.length > 200 || BAD_CHARS.test(b.sourceRef))) return fail('sourceRef must be text of 1 to 200 characters.');
      const t = parseInstant(b.effectiveAt);
      if (t === null) return fail('effectiveAt must be a date and time with its offset, like 2026-11-23T10:30:00+05:45.');
      if (t > Date.now() + FUTURE_SLACK_MS) return fail('effectiveAt is in the future.');
      if (b.status !== undefined && !NEW_STATUS.includes(b.status)) return fail('status must be preliminary or final here (corrections and entered-in-error have their own routes).');
      const status = b.status === undefined ? (b.sourceType === 'ai_proposed' ? 'preliminary' : 'final') : b.status;
      if (b.sourceType === 'ai_proposed' && status !== 'preliminary') return fail('an AI proposal can only be preliminary; a person records a clinician entry to confirm it.');
      items.push({ ...b, status, i });
    }
    const out = await tx(pool, async c => {
      const cs = await lockCase(c, req.params.id);
      if (!cs) return notFound;
      if (cs.status === 'archived') return archived;
      const sets = new Map(), defs = new Map(), shaped = [];
      for (const it of items) {
        if (!sets.has(it.appliedSetId)) sets.set(it.appliedSetId, (await c.query('SELECT id, state, element_set_version_id FROM case_applied_sets WHERE id = $1 AND case_id = $2', [it.appliedSetId, cs.id])).rows[0]);
        const a = sets.get(it.appliedSetId);
        if (!a) return { status: 404, body: { error: 'applied_set_not_found', message: `Entry ${it.i + 1}: that set is not applied to this case.`, index: it.i } };
        if (a.state !== 'active') return { status: 409, body: { error: 'set_not_active', message: `Entry ${it.i + 1}: that set is ${a.state}; it takes no new values.`, index: it.i } };
        const r = shapeValue(await fieldOf(c, a.element_set_version_id, it.fieldKey, defs), it);
        if (r.error) return { status: 400, body: { error: r.error[0], message: `Entry ${it.i + 1}: ${r.error[1]}`, index: it.i } };
        shaped.push(r);
      }
      const ids = [];
      for (let k = 0; k < items.length; k++) {
        const it = items[k], r = shaped[k];
        const ins = await c.query(
          `INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, unit_display, effective_at, source_type, source_ref, status, recorded_by)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8,$9,$10,$11) RETURNING id`,
          [cs.id, it.appliedSetId, it.fieldKey, r.type, r.json === null ? null : JSON.stringify(r.json), r.unit, it.effectiveAt, it.sourceType, it.sourceRef === undefined ? null : it.sourceRef, it.status, req.user.id]);
        ids.push(Number(ins.rows[0].id));
      }
      await event(c, cs.id, 'observation_recorded', req.user.id, { count: ids.length, observationIds: ids, appliedSetIds: [...sets.keys()] });
      await touch(c, cs.id);
      await audit(c, req, 'observation.record', 'case', cs.id, { count: ids.length, observationIds: ids });   // ids only: values never go into the audit log
      const rows = [];
      for (const id of ids) rows.push(numId(await obsRow(c, id)));
      return { status: 201, body: { observations: rows } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- correct an observation: a NEW row; the original keeps its value and both of its times ---------- */
  app.post('/api/observations/:id/correct', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['value', 'unknown', 'unit', 'effectiveAt', 'sourceType', 'sourceRef', 'reason']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, reason = cleanReason(b.reason);
    if (!reason || reason.length > 1000) return bad(res, 'A reason is required (1 to 1000 characters).');
    if (!SOURCES.includes(b.sourceType) || b.sourceType === 'ai_proposed') return bad(res, 'sourceType must be one of: ' + SOURCES.filter(x => x !== 'ai_proposed').join(', ') + ' (an AI proposal cannot correct a value).');
    if (b.sourceRef !== undefined && (!isStr(b.sourceRef) || !b.sourceRef.trim() || b.sourceRef.length > 200 || BAD_CHARS.test(b.sourceRef))) return bad(res, 'sourceRef must be text of 1 to 200 characters.');
    if (b.effectiveAt !== undefined) {
      const t = parseInstant(b.effectiveAt);
      if (t === null) return bad(res, 'effectiveAt must be a date and time with its offset.');
      if (t > Date.now() + FUTURE_SLACK_MS) return bad(res, 'effectiveAt is in the future.');
    }
    const out = await tx(pool, async c => {
      const probe = (await c.query('SELECT case_id FROM observations WHERE id = $1', [req.params.id])).rows[0];
      if (!probe) return notFound;
      const cs = await lockCase(c, probe.case_id);                       // one lock order everywhere: the case first
      if (cs.status === 'archived') return archived;
      const o = (await c.query(`SELECT o.id, o.status, o.applied_set_id, o.field_key, a.element_set_version_id FROM observations o JOIN case_applied_sets a ON a.id = o.applied_set_id WHERE o.id = $1`, [req.params.id])).rows[0];
      if (o.status === 'entered_in_error') return { status: 409, body: { error: 'entered_in_error', message: 'This row was entered in error and cannot be corrected.' } };
      if ((await c.query('SELECT 1 FROM observations WHERE corrects_id = $1', [o.id])).rowCount) return { status: 409, body: { error: 'already_corrected', message: 'This row was already corrected. Reload the timeline and correct the newest row.' } };
      const r = shapeValue(await fieldOf(c, o.element_set_version_id, o.field_key, new Map()), b);
      if (r.error) return { status: 400, body: { error: r.error[0], message: r.error[1] } };
      // effective_at is copied inside SQL when not sent, so its microseconds survive exactly
      const id = (await c.query(
        `INSERT INTO observations(case_id, applied_set_id, field_key, value_type, value_json, unit_display, effective_at, source_type, source_ref, status, recorded_by, corrects_id, change_reason)
         SELECT o.case_id, o.applied_set_id, o.field_key, $2, $3::jsonb, $4, COALESCE($5::timestamptz, o.effective_at), $6, $7, 'amended', $8, o.id, $9 FROM observations o WHERE o.id = $1 RETURNING id`,
        [o.id, r.type, r.json === null ? null : JSON.stringify(r.json), r.unit, b.effectiveAt === undefined ? null : b.effectiveAt, b.sourceType, b.sourceRef === undefined ? null : b.sourceRef, req.user.id, reason])).rows[0].id;
      await event(c, cs.id, 'observation_corrected', req.user.id, { observationId: Number(id), corrects: o.id });
      await touch(c, cs.id);
      await audit(c, req, 'observation.correct', 'case', cs.id, { observationId: Number(id), corrects: o.id, reasonLength: reason.length });
      return { status: 201, body: { observation: numId(await obsRow(c, id)) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- mark an observation entered in error: hidden by default, the row and its value are kept ---------- */
  app.post('/api/observations/:id/entered-in-error', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['reason']);
    if (s.error) return res.status(400).json(s.error);
    const reason = cleanReason(s.body.reason);
    if (!reason || reason.length > 1000) return bad(res, 'A reason is required (1 to 1000 characters).');
    const out = await tx(pool, async c => {
      const probe = (await c.query('SELECT case_id FROM observations WHERE id = $1', [req.params.id])).rows[0];
      if (!probe) return notFound;
      const cs = await lockCase(c, probe.case_id);
      if (cs.status === 'archived') return archived;
      const o = (await c.query('SELECT id, status FROM observations WHERE id = $1', [req.params.id])).rows[0];
      if (o.status === 'entered_in_error') return { status: 409, body: { error: 'already_entered_in_error', message: 'This row is already marked as entered in error.' } };
      await c.query(`UPDATE observations SET status = 'entered_in_error', error_by = $2, error_at = clock_timestamp(), error_reason = $3 WHERE id = $1`, [o.id, req.user.id, reason]);
      await event(c, cs.id, 'observation_entered_in_error', req.user.id, { observationId: Number(o.id) });
      await touch(c, cs.id);
      await audit(c, req, 'observation.entered_in_error', 'case', cs.id, { observationId: Number(o.id), reasonLength: reason.length });
      return { status: 200, body: { observation: numId(await obsRow(c, o.id)) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- the timeline: pins, observations ordered by when they were true (recorded_at is there too), and clinical events ---------- */
  app.get('/api/cases/:id/timeline', A.requirePerm(pool, 'cases:read'), async (req, res) => {
    const includeErrors = req.query.includeErrors === '1' || req.query.includeErrors === 'true';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const fieldKey = req.query.fieldKey === undefined ? null : String(req.query.fieldKey);
    if (fieldKey !== null && !KEY_RE.test(fieldKey)) return bad(res, 'fieldKey must be 1 to 64 letters, digits, . _ - .');
    const cs = (await pool.query('SELECT id, patient_id FROM clinical_cases WHERE id = $1', [req.params.id])).rows[0];
    if (!cs) return res.status(404).json({ error: 'not_found' });
    const appliedSets = (await pool.query(`SELECT ${APPLIED} ${APPLIED_FROM} WHERE a.case_id = $1 ORDER BY a.id`, [cs.id])).rows;
    const observations = (await pool.query(
      `SELECT ${OBS} ${OBS_FROM} WHERE o.case_id = $1 ${includeErrors ? '' : `AND o.status <> 'entered_in_error'`} ${fieldKey ? 'AND o.field_key = $3' : ''}
        ORDER BY o.effective_at, o.id LIMIT $2`, fieldKey ? [cs.id, limit, fieldKey] : [cs.id, limit])).rows.map(numId);
    const hidden = includeErrors ? 0 : (await pool.query(`SELECT count(*)::int AS n FROM observations WHERE case_id = $1 AND status = 'entered_in_error' ${fieldKey ? 'AND field_key = $2' : ''}`, fieldKey ? [cs.id, fieldKey] : [cs.id])).rows[0].n;
    const events = (await pool.query(
      `SELECT e.id, e.event_type, e.occurred_at, e.encounter_id, u.username AS actor, e.detail FROM clinical_events e JOIN users u ON u.id = e.actor_id
        WHERE e.case_id = $1 ORDER BY e.id DESC LIMIT 200`, [cs.id])).rows.map(e => ({ ...e, id: Number(e.id) }));
    await audit(pool, req, 'case.timeline_view', 'case', cs.id, { patientId: cs.patient_id, includeErrors, count: observations.length });
    res.json({ appliedSets, observations, hiddenInError: hidden, events });
  });
}

module.exports = { mountObservations, APPLIED, APPLIED_FROM, shapeValue, parseInstant, FUTURE_SLACK_MS };   // R6f-2b: bundle accept reuses the same value rules
