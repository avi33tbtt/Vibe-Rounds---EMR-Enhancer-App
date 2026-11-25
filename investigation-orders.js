'use strict';
// Task R4e: investigation orders on the server (list, get, order, cancel, entered in error). Orders only; specimens and results are R4f.
// The orderer, canceller and error-marker come from the session; a body that names one is refused. Nothing is suggested: the test name is free text or a PUBLISHED local "test" term
// (termId; the term's display is copied in); priority is routine or urgent as the clinician chooses. Free text is never treated as verified.
// A move needs a reason (1..1000) and the loaded row_version (stale gives 409); entered_in_error is final. Test name, clinical info and reasons never go into the audit log: ids and lengths only.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const MAX_NAME = 200, MAX_INFO = 500, MAX_REASON = 1000, PRIORITIES = ['routine', 'urgent'];
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);

function mountInvestigationOrders(app, pool) {
  const COLS = `o.id, o.patient_id, o.origin_case_id, o.term_id, o.test_name, o.priority, o.clinical_info, o.status, o.row_version,
                ou.username AS ordered_by, o.ordered_at, cu.username AS cancelled_by, o.cancelled_at, o.cancel_reason, xu.username AS error_by, o.error_at, o.error_reason`;
  const FROM = `FROM investigation_orders o JOIN users ou ON ou.id = o.ordered_by LEFT JOIN users cu ON cu.id = o.cancelled_by LEFT JOIN users xu ON xu.id = o.error_by`;
  const load = async (c, id) => {
    const order = (await c.query(`SELECT ${COLS} ${FROM} WHERE o.id = $1`, [id])).rows[0];
    if (order) order.events = (await c.query(`SELECT e.seq, e.from_status, e.to_status, e.reason, u.username AS by_user, e.at FROM investigation_order_events e JOIN users u ON u.id = e.by_user WHERE e.order_id = $1 ORDER BY e.seq`, [id])).rows;
    return order;
  };

  app.get('/api/patients/:id/investigation-orders', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const all = req.query.include === 'all';
    const orders = (await pool.query(`SELECT ${COLS} ${FROM} WHERE o.patient_id = $1 ${all ? '' : `AND o.status <> 'entered_in_error'`} ORDER BY o.id`, [pid])).rows;
    await audit(pool, req, 'patient.investigation_orders_view', 'patient', pid, { count: orders.length, includeAll: all });
    res.json({ orders });
  });

  app.get('/api/investigation-orders/:id', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const order = await load(pool, id);
    if (!order) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'investigation_order.view', 'patient', order.patient_id, { orderId: id });
    res.json({ order });
  });

  app.post('/api/patients/:id/investigation-orders', A.requirePerm(pool, 'orders:write'), async (req, res) => {
    const s = strict(req.body, ['termId', 'testName', 'priority', 'clinicalInfo', 'originCaseId']);
    if (s.error) return res.status(400).json(s.error);
    const b = s.body, pid = idParam(req.params.id);
    const hasTerm = b.termId !== undefined && b.termId !== null, hasName = b.testName !== undefined && b.testName !== null;
    if (hasTerm === hasName) return bad(res, 'Give the test either as a local test term (termId) or as text (testName), not both and not neither.');
    if (hasTerm && !posInt(b.termId)) return bad(res, 'termId must be a whole number.');
    if (hasName && !text(b.testName, MAX_NAME)) return bad(res, `testName must be 1 to ${MAX_NAME} characters.`);
    if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) return bad(res, 'priority must be one of: ' + PRIORITIES.join(', '));
    if (b.clinicalInfo !== undefined && b.clinicalInfo !== null && !text(b.clinicalInfo, MAX_INFO)) return bad(res, `clinicalInfo must be 1 to ${MAX_INFO} characters (leave it out if not recorded).`);
    if (b.originCaseId !== undefined && b.originCaseId !== null && !posInt(b.originCaseId)) return bad(res, 'originCaseId must be a whole number.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before ordering an investigation.' } };
      const origin = b.originCaseId == null ? null : b.originCaseId;
      if (origin !== null && !(await c.query('SELECT 1 FROM clinical_cases WHERE id = $1 AND patient_id = $2', [origin, pid])).rowCount) return { status: 400, body: { error: 'case_not_of_patient', message: 'That case is not a case of this patient.' } };
      let name = hasName ? b.testName.trim() : null, termId = null;
      if (hasTerm) {
        const t = (await c.query('SELECT id, display, category, status FROM local_terms WHERE id = $1', [b.termId])).rows[0];
        if (!t || t.status !== 'published' || t.category !== 'test') return { status: 400, body: { error: 'term_not_usable', message: 'That is not a published local test term.' } };
        name = t.display; termId = t.id;
      }
      const id = (await c.query('INSERT INTO investigation_orders(patient_id, origin_case_id, term_id, test_name, priority, clinical_info, ordered_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [pid, origin, termId, name, b.priority || 'routine', b.clinicalInfo == null ? null : b.clinicalInfo.trim(), req.user.id])).rows[0].id;
      await c.query(`INSERT INTO investigation_order_events(order_id, seq, from_status, to_status, by_user) VALUES ($1, 1, NULL, 'active', $2)`, [id, req.user.id]);
      await audit(c, req, 'investigation_order.add', 'patient', pid, { orderId: id, originCaseId: origin, termId, nameLength: name.length, priority: b.priority || 'routine' });
      return { status: 201, body: { order: await load(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  function move(kind) {
    const cancel = kind === 'cancel';
    return async (req, res) => {
      const s = strict(req.body, ['reason', 'rowVersion']);
      if (s.error) return res.status(400).json(s.error);
      const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
      if (!text(s.body.reason, MAX_REASON)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
      if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
      if (!id) return res.status(404).json({ error: 'not_found' });
      const out = await tx(pool, async c => {
        const o = (await c.query('SELECT id, patient_id, status, row_version FROM investigation_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!o) return { status: 404, body: { error: 'not_found' } };
        if (o.status === 'entered_in_error') return { status: 409, body: { error: 'order_final', message: 'An order entered in error is final.', currentRowVersion: o.row_version } };
        if (o.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This order was changed by someone else. Reload it and try again.', currentRowVersion: o.row_version } };
        if (cancel && o.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active order can be cancelled.', currentRowVersion: o.row_version } };
        const reason = s.body.reason.trim(), to = cancel ? 'cancelled' : 'entered_in_error';
        if (cancel) await c.query('UPDATE investigation_orders SET status = $2, row_version = row_version + 1, cancelled_by = $3, cancelled_at = clock_timestamp(), cancel_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        else await c.query('UPDATE investigation_orders SET status = $2, row_version = row_version + 1, error_by = $3, error_at = clock_timestamp(), error_reason = $4 WHERE id = $1', [id, to, req.user.id, reason]);
        await c.query(`INSERT INTO investigation_order_events(order_id, seq, from_status, to_status, reason, by_user) SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM investigation_order_events WHERE order_id = $1`, [id, o.status, to, reason, req.user.id]);
        await audit(c, req, cancel ? 'investigation_order.cancel' : 'investigation_order.error', 'patient', o.patient_id, { orderId: id, from: o.status, length: reason.length, rowVersion: rv + 1 });
        return { status: 200, body: { order: await load(c, id) } };
      });
      res.status(out.status).json(out.body);
    };
  }
  app.post('/api/investigation-orders/:id/cancel', A.requirePerm(pool, 'orders:write'), move('cancel'));
  app.post('/api/investigation-orders/:id/entered-in-error', A.requirePerm(pool, 'orders:write'), move('error'));
}
module.exports = { mountInvestigationOrders };
