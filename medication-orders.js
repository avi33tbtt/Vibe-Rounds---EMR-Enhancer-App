'use strict';
// Task R4b: medication ORDERS on the server (list, get, order, change with reason, stop, entered in error). Orders are separate from the recorded medication list (R3e).
// The orderer, stopper and error-marker come from the session; a body that names one is refused. Nothing is suggested or checked: name, dose, route, frequency are free text as typed.
// The name is either free text or a PUBLISHED local drug term (termId; the term's display is copied in). Free text is never treated as verified.
// A change needs a reason and the loaded row_version; it marks the old order "changed" and creates a NEW order that replaces it, in one transaction. Nothing is deleted; entered_in_error is final.
// The medication, dose, route, frequency, indication and reasons never go into the audit log: ids and lengths only. The database enforces the same rules (migration 021).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_TEXT = 200, MAX_IND = 500, MAX_REASON = 1000;
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;   // NUL and lone surrogates
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);

// The order content fields shared by "order" and "change". Returns { error } or { value } (trimmed text; termId or medication, never both).
function content(b) {
  const hasTerm = b.termId !== undefined && b.termId !== null, hasName = b.medication !== undefined && b.medication !== null;
  if (hasTerm === hasName) return { error: 'Give the medication either as a local drug term (termId) or as text (medication), not both and not neither.' };
  if (hasTerm && !posInt(b.termId)) return { error: 'termId must be a whole number.' };
  if (hasName && !text(b.medication, MAX_TEXT)) return { error: `medication must be 1 to ${MAX_TEXT} characters.` };
  for (const [k, label] of [['doseText', 'dose'], ['routeText', 'route'], ['frequencyText', 'frequency']]) if (!text(b[k], MAX_TEXT)) return { error: `The order needs a ${label} (${k}) of 1 to ${MAX_TEXT} characters, as the clinician types it.` };
  if (b.indicationText !== undefined && b.indicationText !== null && !text(b.indicationText, MAX_IND)) return { error: `indicationText must be 1 to ${MAX_IND} characters (leave it out if not recorded).` };
  const t = s => (s == null ? null : s.trim());
  return { value: { termId: hasTerm ? b.termId : null, medication: hasName ? b.medication.trim() : null, dose: t(b.doseText), route: t(b.routeText), frequency: t(b.frequencyText), indication: t(b.indicationText) } };
}
const CONTENT_FIELDS = ['termId', 'medication', 'doseText', 'routeText', 'frequencyText', 'indicationText'];

function mountMedicationOrders(app, pool) {
  const COLS = `o.id, o.patient_id, o.origin_case_id, o.term_id, o.medication, o.dose_text, o.route_text, o.frequency_text, o.indication_text, o.status, o.replaces_order_id, o.row_version,
                ou.username AS ordered_by, o.ordered_at, eu.username AS ended_by, o.ended_at, o.end_reason, xu.username AS error_by, o.error_at, o.error_reason`;
  const FROM = `FROM medication_orders o JOIN users ou ON ou.id = o.ordered_by LEFT JOIN users eu ON eu.id = o.ended_by LEFT JOIN users xu ON xu.id = o.error_by`;
  const EVENT = `e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at`;
  const load = async (c, id) => {
    const order = (await c.query(`SELECT ${COLS}, (SELECT n.id FROM medication_orders n WHERE n.replaces_order_id = o.id) AS replaced_by_order_id ${FROM} WHERE o.id = $1`, [id])).rows[0];
    if (order) order.events = (await c.query(`SELECT ${EVENT} FROM medication_order_events e JOIN users u ON u.id = e.by_user WHERE e.order_id = $1 ORDER BY e.seq`, [id])).rows;
    return order;
  };
  // Resolve the medication name: a published drug term (its display is copied) or the typed text. Returns { name, termId } or { refuse }.
  const resolveName = async (c, v) => {
    if (v.termId === null) return { name: v.medication, termId: null };
    const t = (await c.query('SELECT id, display, category, status FROM local_terms WHERE id = $1', [v.termId])).rows[0];
    if (!t || t.status !== 'published' || t.category !== 'drug') return { refuse: { status: 400, body: { error: 'term_not_usable', message: 'That is not a published local drug term.' } } };
    return { name: t.display, termId: t.id };
  };
  const insertOrder = async (c, req, pid, origin, v, name, replaces) => {
    const id = (await c.query(`INSERT INTO medication_orders(patient_id, origin_case_id, term_id, medication, dose_text, route_text, frequency_text, indication_text, replaces_order_id, ordered_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [pid, origin, name.termId, name.name, v.dose, v.route, v.frequency, v.indication, replaces, req.user.id])).rows[0].id;
    await c.query(`INSERT INTO medication_order_events(order_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
    return id;
  };
  const addEvent = (c, id, from, to, reason, user) => c.query(`INSERT INTO medication_order_events(order_id, seq, from_status, to_status, reason, by_user)
    SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM medication_order_events WHERE order_id = $1`, [id, from, to, reason, user]);

  /* ---------- list a patient's orders (entered in error hidden unless ?include=all) ---------- */
  app.get('/api/patients/:id/medication-orders', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const orders = (await pool.query(`SELECT ${COLS} ${FROM} WHERE o.patient_id = $1 ${all ? '' : `AND o.status <> 'entered_in_error'`} ORDER BY o.id`, [pid])).rows;
    await audit(pool, req, 'patient.medication_orders_view', 'patient', pid, { count: orders.length, includeAll: all });
    res.json({ orders });
  });

  /* ---------- one order, with its history ---------- */
  app.get('/api/medication-orders/:id', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const order = await load(pool, id);
    if (!order) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'medication_order.view', 'patient', order.patient_id, { orderId: id });
    res.json({ order });
  });

  /* ---------- order ---------- */
  app.post('/api/patients/:id/medication-orders', A.requirePerm(pool, 'orders:write'), async (req, res) => {
    const s = strict(req.body, [...CONTENT_FIELDS, 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id), ct = content(b);
    if (ct.error) return bad(res, ct.error);
    if (b.originCaseId !== undefined && b.originCaseId !== null && !posInt(b.originCaseId)) return bad(res, 'originCaseId must be a whole number.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before ordering a medication.' } };
      const origin = b.originCaseId == null ? null : b.originCaseId;
      if (origin !== null && !(await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      const nm = await resolveName(c, ct.value);
      if (nm.refuse) return nm.refuse;
      const id = await insertOrder(c, req, pid, origin, ct.value, { name: nm.name, termId: nm.termId }, null);
      await audit(c, req, 'medication_order.add', 'patient', pid, { orderId: id, originCaseId: origin, termId: nm.termId, nameLength: nm.name.length });
      return { status: 201, body: { order: await load(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- change: the old order becomes "changed" and a NEW order replaces it (reason and loaded row_version required) ---------- */
  app.post('/api/medication-orders/:id/change', A.requirePerm(pool, 'orders:write'), async (req, res) => {
    const s = strict(req.body, [...CONTENT_FIELDS, 'reason', 'rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, id = idParam(req.params.id), rv = posInt(b.rowVersion), ct = content(b);
    if (!text(b.reason, MAX_REASON)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (ct.error) return bad(res, ct.error);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const o = (await c.query('SELECT id, patient_id, origin_case_id, status, row_version FROM medication_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) return { status: 404, body: { error: 'not_found' } };
      if (o.status === 'entered_in_error') return { status: 409, body: { error: 'order_final', message: 'An order entered in error is final.', currentRowVersion: o.row_version } };
      if (o.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This order was changed by someone else. Reload it and try again.', currentRowVersion: o.row_version } };
      if (o.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active order can be changed.', currentRowVersion: o.row_version } };
      const p = (await c.query('SELECT archived FROM patients WHERE id = $1 FOR UPDATE', [o.patient_id])).rows[0];
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before changing an order.' } };
      const nm = await resolveName(c, ct.value);
      if (nm.refuse) return nm.refuse;
      const reason = b.reason.trim();
      await c.query('UPDATE medication_orders SET status = $2, row_version = row_version + 1, ended_by = $3, ended_at = clock_timestamp(), end_reason = $4 WHERE id = $1', [id, 'changed', req.user.id, reason]);
      await addEvent(c, id, 'active', 'changed', reason, req.user.id);
      const nid = await insertOrder(c, req, o.patient_id, o.origin_case_id, ct.value, { name: nm.name, termId: nm.termId }, id);
      await audit(c, req, 'medication_order.change', 'patient', o.patient_id, { orderId: id, newOrderId: nid, termId: nm.termId, length: reason.length, rowVersion: rv + 1 });
      return { status: 200, body: { order: await load(c, id), newOrder: await load(c, nid) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- stop, or mark entered in error (reason and loaded row_version required) ---------- */
  function move(kind) {
    const stop = kind === 'stop';
    return async (req, res) => {
      const s = strict(req.body, ['reason', 'rowVersion']);
      if (s.error) return res.status(400).json(s.error);
      const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
      if (!text(s.body.reason, MAX_REASON)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
      if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
      if (!id) return res.status(404).json({ error: 'not_found' });
      const out = await tx(pool, async c => {
        const o = (await c.query('SELECT id, patient_id, status, row_version FROM medication_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!o) return { status: 404, body: { error: 'not_found' } };
        if (o.status === 'entered_in_error') return { status: 409, body: { error: 'order_final', message: 'An order entered in error is final.', currentRowVersion: o.row_version } };
        if (o.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This order was changed by someone else. Reload it and try again.', currentRowVersion: o.row_version } };
        if (stop && o.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active order can be stopped.', currentRowVersion: o.row_version } };
        const reason = s.body.reason.trim(), to = stop ? 'stopped' : 'entered_in_error';
        if (stop) await c.query('UPDATE medication_orders SET status = $2, row_version = row_version + 1, ended_by = $3, ended_at = clock_timestamp(), end_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        else await c.query('UPDATE medication_orders SET status = $2, row_version = row_version + 1, error_by = $3, error_at = clock_timestamp(), error_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        await addEvent(c, id, o.status, to, reason, req.user.id);
        await audit(c, req, stop ? 'medication_order.stop' : 'medication_order.error', 'patient', o.patient_id, { orderId: id, from: o.status, length: reason.length, rowVersion: rv + 1 });
        return { status: 200, body: { order: await load(c, id) } };
      });
      res.status(out.status).json(out.body);
    };
  }
  app.post('/api/medication-orders/:id/stop', A.requirePerm(pool, 'orders:write'), move('stop'));
  app.post('/api/medication-orders/:id/entered-in-error', A.requirePerm(pool, 'orders:write'), move('error'));
}
module.exports = { mountMedicationOrders };
