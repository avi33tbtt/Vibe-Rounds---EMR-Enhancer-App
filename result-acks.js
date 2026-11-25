'use strict';
// Task R4g-1: acknowledgement of abnormal results, on the server (list a patient's abnormal results, acknowledge one). Append-only; one acknowledgement per result.
// "Abnormal" is only the flag a person typed with the result (R4f): nothing is computed or decided here. A replaced result is not listed or acknowledged (acknowledge the newest).
// The acknowledger comes from the session; a body that names one is refused. The note never goes into the audit log: ids and length only. The database enforces the same rules (migration 025).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);

function mountResultAcks(app, pool) {
  const SEL = `r.id, r.order_id, o.test_name, r.value_text, r.unit_text, r.reference_text, r.flag, r.recorded_by AS recorded_by_id, ru.username AS recorded_by, r.recorded_at,
               a.id AS ack_id, au.username AS acknowledged_by, a.acknowledged_at, a.note AS ack_note`;
  const FROM = `FROM investigation_results r JOIN investigation_orders o ON o.id = r.order_id JOIN users ru ON ru.id = r.recorded_by
                LEFT JOIN investigation_result_acks a ON a.result_id = r.id LEFT JOIN users au ON au.id = a.acknowledged_by`;
  const CUR = `NOT EXISTS (SELECT 1 FROM investigation_results n WHERE n.replaces_result_id = r.id)`;
  const strip = rows => rows.map(({ recorded_by_id, ...x }) => x);

  /* ---------- abnormal results of a patient: waiting for acknowledgement, and acknowledged (newest results only; entered-in-error orders hidden) ---------- */
  app.get('/api/patients/:id/abnormal-results', A.requirePerm(pool, 'results:read'), async (req, res) => {
    const pid = idParam(req.params.id);
    if (!pid) return res.status(404).json({ error: 'not_found' });
    if (!(await pool.query('SELECT id FROM patients WHERE id = $1', [pid])).rows[0]) return res.status(404).json({ error: 'not_found' });
    const rows = strip((await pool.query(`SELECT ${SEL} ${FROM} WHERE r.patient_id = $1 AND r.flag = 'abnormal' AND ${CUR} AND o.status <> 'entered_in_error' ORDER BY r.id`, [pid])).rows);
    const pending = rows.filter(r => r.ack_id === null), acknowledged = rows.filter(r => r.ack_id !== null);
    await audit(pool, req, 'patient.abnormal_results_view', 'patient', pid, { pending: pending.length, acknowledged: acknowledged.length });
    res.json({ pending, acknowledged });
  });

  /* ---------- acknowledge one result ---------- */
  app.post('/api/investigation-results/:id/acknowledge', A.requirePerm(pool, 'results:ack'), async (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(b).filter(k => k !== 'note');
    if (extra.length) return res.status(400).json({ error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) });
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.trim().length < 1 || b.note.length > 1000 || BAD_CHARS.test(b.note)))
      return res.status(400).json({ error: 'invalid', message: 'note must be 1 to 1000 characters (leave it out if none).' });
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const note = b.note == null ? null : b.note.trim();
    const out = await tx(pool, async c => {
      const r = (await c.query('SELECT id, patient_id, order_id, flag FROM investigation_results WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) return { status: 404, body: { error: 'not_found' } };
      if (r.flag !== 'abnormal') return { status: 409, body: { error: 'not_flagged_abnormal', message: 'Only a result flagged abnormal is acknowledged.' } };
      if ((await c.query('SELECT 1 FROM investigation_results WHERE replaces_result_id = $1', [id])).rowCount) return { status: 409, body: { error: 'result_replaced', message: 'This result was corrected. Acknowledge the newest result.' } };
      if ((await c.query('SELECT 1 FROM investigation_result_acks WHERE result_id = $1', [id])).rowCount) return { status: 409, body: { error: 'already_acknowledged', message: 'This result was already acknowledged.' } };
      const aid = (await c.query('INSERT INTO investigation_result_acks(result_id, patient_id, note, acknowledged_by) VALUES ($1,$2,$3,$4) RETURNING id', [id, r.patient_id, note, req.user.id])).rows[0].id;
      await audit(c, req, 'investigation_result.acknowledge', 'patient', r.patient_id, { resultId: id, orderId: r.order_id, ackId: aid, noteLength: note === null ? 0 : note.length });
      const ack = (await c.query(`SELECT a.id, a.result_id, a.note, u.username AS acknowledged_by, a.acknowledged_at FROM investigation_result_acks a JOIN users u ON u.id = a.acknowledged_by WHERE a.id = $1`, [aid])).rows[0];
      return { status: 201, body: { acknowledgement: ack } };
    });
    res.status(out.status).json(out.body);
  });
}
module.exports = { mountResultAcks };
