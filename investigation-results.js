'use strict';
// Task R4f: specimens and results for investigation orders, on the server (list, record specimen, record result, correct a result). Append-only: nothing is changed or deleted.
// A result is typed as reported: value, unit and reference range are free text and are never computed, compared or interpreted. The flag (not_stated, normal, abnormal) is chosen by the person.
// A mistake is corrected by a NEW result that replaces the old one (reason required); the old row stays and is shown as replaced. The recorder comes from the session; a body that names one is refused.
// Values, units, reference text and reasons never go into the audit log: ids and lengths only. The database enforces the same rules (migration 024).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const FLAGS = ['not_stated', 'normal', 'abnormal'];
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);
const opt = (v, max) => v === undefined || v === null || text(v, max);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const t = v => (v == null ? null : v.trim());
// A collection time: an ISO date-time from 1900, not later than tomorrow (UTC); left out = now (the server clock).
function okTime(v) { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return false; const d = new Date(v); return !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 1900 && d.getTime() <= Date.now() + 86400000; }

const RESULT_FIELDS = ['valueText', 'unitText', 'referenceText', 'flag'];
function resultFields(b) {
  if (!text(b.valueText, 500)) return 'valueText is required: 1 to 500 characters, as reported.';
  if (!opt(b.unitText, 100)) return 'unitText must be 1 to 100 characters (leave it out if none).';
  if (!opt(b.referenceText, 200)) return 'referenceText must be 1 to 200 characters (leave it out if none).';
  if (b.flag !== undefined && !FLAGS.includes(b.flag)) return 'flag must be one of: ' + FLAGS.join(', ');
  return null;
}

function mountInvestigationResults(app, pool) {
  const SPEC = `s.id, s.order_id, s.specimen_type, s.collected_at, u.username AS recorded_by, s.recorded_at`;
  const RES = `r.id, r.order_id, r.specimen_id, r.value_text, r.unit_text, r.reference_text, r.flag, r.replaces_result_id, r.correction_reason, u.username AS recorded_by, r.recorded_at,
               EXISTS (SELECT 1 FROM investigation_results n WHERE n.replaces_result_id = r.id) AS replaced,
               (SELECT au.username FROM investigation_result_acks a JOIN users au ON au.id = a.acknowledged_by WHERE a.result_id = r.id) AS acknowledged_by,
               (SELECT a.acknowledged_at FROM investigation_result_acks a WHERE a.result_id = r.id) AS acknowledged_at,
               (SELECT a.note FROM investigation_result_acks a WHERE a.result_id = r.id) AS ack_note`;
  const specimens = (c, oid) => c.query(`SELECT ${SPEC} FROM investigation_specimens s JOIN users u ON u.id = s.recorded_by WHERE s.order_id = $1 ORDER BY s.id`, [oid]).then(r => r.rows);
  const results = (c, oid) => c.query(`SELECT ${RES} FROM investigation_results r JOIN users u ON u.id = r.recorded_by WHERE r.order_id = $1 ORDER BY r.id`, [oid]).then(r => r.rows);
  const oneResult = (c, id) => c.query(`SELECT ${RES} FROM investigation_results r JOIN users u ON u.id = r.recorded_by WHERE r.id = $1`, [id]).then(r => r.rows[0]);
  // Lock the order and check it can take new rows. Returns { order } or { refuse }.
  const activeOrder = async (c, id) => {
    const o = (await c.query('SELECT id, patient_id, status FROM investigation_orders WHERE id = $1 FOR SHARE', [id])).rows[0];
    if (!o) return { refuse: { status: 404, body: { error: 'not_found' } } };
    if (o.status !== 'active') return { refuse: { status: 409, body: { error: 'order_not_active', message: 'Specimens and results can only be recorded for an active order.' } } };
    return { order: o };
  };

  app.get('/api/investigation-orders/:id/results', A.requirePerm(pool, 'results:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const o = (await pool.query('SELECT id, patient_id FROM investigation_orders WHERE id = $1', [id])).rows[0];
    if (!o) return res.status(404).json({ error: 'not_found' });
    const body = { specimens: await specimens(pool, id), results: await results(pool, id) };
    await audit(pool, req, 'investigation_results.view', 'patient', o.patient_id, { orderId: id, specimens: body.specimens.length, results: body.results.length });
    res.json(body);
  });

  app.post('/api/investigation-orders/:id/specimens', A.requirePerm(pool, 'results:write'), async (req, res) => {
    const s = strict(req.body, ['specimenType', 'collectedAt']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, id = idParam(req.params.id);
    if (!text(b.specimenType, 200)) return bad(res, 'specimenType is required: 1 to 200 characters.');
    if (b.collectedAt !== undefined && b.collectedAt !== null && !okTime(b.collectedAt)) return bad(res, 'collectedAt must be a date-time with a time zone, e.g. 2026-11-26T09:30:00Z (leave it out for now).');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const a = await activeOrder(c, id);
      if (a.refuse) return a.refuse;
      const sid = (await c.query('INSERT INTO investigation_specimens(order_id, patient_id, specimen_type, collected_at, recorded_by) VALUES ($1,$2,$3,coalesce($4::timestamptz, clock_timestamp()),$5) RETURNING id',
        [id, a.order.patient_id, b.specimenType.trim(), b.collectedAt == null ? null : b.collectedAt, req.user.id])).rows[0].id;
      await audit(c, req, 'investigation_specimen.add', 'patient', a.order.patient_id, { orderId: id, specimenId: sid, typeLength: b.specimenType.trim().length });
      return { status: 201, body: { specimen: (await specimens(c, id)).find(x => x.id === sid) } };
    });
    res.status(out.status).json(out.body);
  });

  app.post('/api/investigation-orders/:id/results', A.requirePerm(pool, 'results:write'), async (req, res) => {
    const s = strict(req.body, [...RESULT_FIELDS, 'specimenId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, id = idParam(req.params.id), msg = resultFields(b);
    if (msg) return bad(res, msg);
    if (b.specimenId !== undefined && b.specimenId !== null && !posInt(b.specimenId)) return bad(res, 'specimenId must be a whole number.');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const a = await activeOrder(c, id);
      if (a.refuse) return a.refuse;
      if (b.specimenId != null && !(await c.query('SELECT 1 FROM investigation_specimens WHERE id = $1 AND order_id = $2', [b.specimenId, id])).rowCount) return { status: 400, body: { error: 'specimen_not_of_order', message: 'That specimen is not a specimen of this order.' } };
      const rid = (await c.query('INSERT INTO investigation_results(order_id, patient_id, specimen_id, value_text, unit_text, reference_text, flag, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [id, a.order.patient_id, b.specimenId == null ? null : b.specimenId, b.valueText.trim(), t(b.unitText), t(b.referenceText), b.flag || 'not_stated', req.user.id])).rows[0].id;
      await audit(c, req, 'investigation_result.add', 'patient', a.order.patient_id, { orderId: id, resultId: rid, specimenId: b.specimenId == null ? null : b.specimenId, flag: b.flag || 'not_stated', valueLength: b.valueText.trim().length });
      return { status: 201, body: { result: await oneResult(c, rid) } };
    });
    res.status(out.status).json(out.body);
  });

  app.post('/api/investigation-results/:id/correct', A.requirePerm(pool, 'results:write'), async (req, res) => {
    const s = strict(req.body, [...RESULT_FIELDS, 'reason']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, id = idParam(req.params.id), msg = resultFields(b);
    if (msg) return bad(res, msg);
    if (!text(b.reason, 1000)) return bad(res, 'A reason of 1 to 1000 characters is required.');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const old = (await c.query('SELECT id, order_id, specimen_id FROM investigation_results WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!old) return { status: 404, body: { error: 'not_found' } };
      const a = await activeOrder(c, old.order_id);
      if (a.refuse) return a.refuse;
      if ((await c.query('SELECT 1 FROM investigation_results WHERE replaces_result_id = $1', [id])).rowCount) return { status: 409, body: { error: 'already_corrected', message: 'This result was already corrected. Reload and correct the newest one.' } };
      const reason = b.reason.trim();
      const rid = (await c.query('INSERT INTO investigation_results(order_id, patient_id, specimen_id, value_text, unit_text, reference_text, flag, replaces_result_id, correction_reason, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
        [old.order_id, a.order.patient_id, old.specimen_id, b.valueText.trim(), t(b.unitText), t(b.referenceText), b.flag || 'not_stated', id, reason, req.user.id])).rows[0].id;
      await audit(c, req, 'investigation_result.correct', 'patient', a.order.patient_id, { orderId: old.order_id, resultId: rid, replacesResultId: id, flag: b.flag || 'not_stated', length: reason.length });
      return { status: 201, body: { result: await oneResult(c, rid), replaced: await oneResult(c, id) } };
    });
    res.status(out.status).json(out.body);
  });
}
module.exports = { mountInvestigationResults };
