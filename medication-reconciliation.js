'use strict';
// Task R4d-1: medication reconciliation on the server (compare, record a decision). Side by side only: the recorded medication list (R3e) and the active orders (R4b).
// Nothing is matched, suggested or checked (no names compared, no doses, no interactions). Each decision is explicit and appended; the latest per item counts; nothing is changed or deleted.
// The decider comes from the session; a body that names one is refused. The reason never goes into the audit log: ids and lengths only. The database enforces the same rules (migration 022).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const DECISIONS = ['continue', 'stop', 'not_taken'];
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);

function mountMedicationReconciliation(app, pool) {
  const DEC = `d.id, d.medication_id, d.order_id, d.decision, d.reason, u.username AS decided_by, d.decided_at`;
  const MED = `p.id, p.medication, p.dose_text, p.frequency_text, to_char(p.start_date, 'YYYY-MM-DD') AS start_date, p.status, p.row_version`;
  const ORD = `o.id, o.medication, o.dose_text, o.route_text, o.frequency_text, o.indication_text, o.status, o.row_version`;

  /* ---------- compare: active history items (each with its latest decision) next to active orders ---------- */
  app.get('/api/patients/:id/medication-reconciliation', A.requirePerm(pool, 'orders:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const history = (await pool.query(`SELECT ${MED} FROM patient_medications p WHERE p.patient_id = $1 AND p.status = 'active' ORDER BY p.id`, [pid])).rows;
    const orders = (await pool.query(`SELECT ${ORD} FROM medication_orders o WHERE o.patient_id = $1 AND o.status = 'active' ORDER BY o.id`, [pid])).rows;
    const latest = (await pool.query(`SELECT DISTINCT ON (d.medication_id) ${DEC} FROM medication_reconciliations d JOIN users u ON u.id = d.decided_by
      WHERE d.patient_id = $1 ORDER BY d.medication_id, d.id DESC`, [pid])).rows;
    const byMed = new Map(latest.map(d => [d.medication_id, d]));
    for (const h of history) h.decision = byMed.get(h.id) || null;
    await audit(pool, req, 'patient.medication_reconciliation_view', 'patient', pid, { history: history.length, orders: orders.length });
    res.json({ history, orders });
  });

  /* ---------- record one explicit decision ---------- */
  app.post('/api/patients/:id/medication-reconciliation', A.requirePerm(pool, 'orders:write'), async (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(b).filter(k => !['medicationId', 'decision', 'orderId', 'reason'].includes(k));
    if (extra.length) return res.status(400).json({ error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) });
    const pid = idParam(req.params.id);
    if (!posInt(b.medicationId)) return bad(res, 'medicationId must be a whole number.');
    if (!DECISIONS.includes(b.decision)) return bad(res, 'decision must be one of: ' + DECISIONS.join(', '));
    const hasOrder = b.orderId !== undefined && b.orderId !== null;
    if (hasOrder && !posInt(b.orderId)) return bad(res, 'orderId must be a whole number.');
    if ((b.decision === 'continue') !== hasOrder) return bad(res, 'Continue needs the active order that covers it (orderId); stop and not_taken take no orderId.');
    if (typeof b.reason !== 'string' || b.reason.trim().length < 1 || b.reason.length > 1000 || BAD_CHARS.test(b.reason)) return bad(res, 'A reason of 1 to 1000 characters is required.');
    if (!pid) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before reconciling medications.' } };
      const m = (await c.query('SELECT id, status FROM patient_medications WHERE id = $1 AND patient_id = $2 FOR SHARE', [b.medicationId, pid])).rows[0];
      if (!m) return { status: 400, body: { error: 'medication_not_of_patient', message: 'That medication is not on this patient\'s list.' } };
      if (m.status !== 'active') return { status: 409, body: { error: 'not_active', message: 'Only an active medication can be reconciled.' } };
      if (hasOrder) {
        const o = (await c.query('SELECT id, status FROM medication_orders WHERE id = $1 AND patient_id = $2 FOR SHARE', [b.orderId, pid])).rows[0];
        if (!o) return { status: 400, body: { error: 'order_not_of_patient', message: 'That order is not an order of this patient.' } };
        if (o.status !== 'active') return { status: 409, body: { error: 'order_not_active', message: 'Only an active order can cover a medication.' } };
      }
      const reason = b.reason.trim();
      const id = (await c.query('INSERT INTO medication_reconciliations(patient_id, medication_id, order_id, decision, reason, decided_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [pid, b.medicationId, hasOrder ? b.orderId : null, b.decision, reason, req.user.id])).rows[0].id;
      await audit(c, req, 'medication_reconciliation.record', 'patient', pid, { reconciliationId: id, medicationId: b.medicationId, orderId: hasOrder ? b.orderId : null, decision: b.decision, length: reason.length });
      const decision = (await c.query(`SELECT ${DEC} FROM medication_reconciliations d JOIN users u ON u.id = d.decided_by WHERE d.id = $1`, [id])).rows[0];
      return { status: 201, body: { decision } };
    });
    res.status(out.status).json(out.body);
  });
}
module.exports = { mountMedicationReconciliation };
