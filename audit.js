'use strict';
/**
 * Audit trail (chunk 33a). Every API write inserts its audit_log row on the SAME transaction client as the data change (api.js), so the two commit or
 * roll back together: if the audit insert fails, the change fails. Who and from where (user id, role, IP) is taken from the request context set by
 * auditContext below, never from a request body or an argument, so a route cannot record someone else as the actor.
 *
 *   await db.withTx(async (c) => {
 *     ...change data using c...
 *     await audit(c, { action: 'row.add', entity: 'case_row', entity_id: id, case_id: caseId, after: {...} });
 *   });
 *
 * `case_id` is optional: when given and `patient_id` is not, the patient is looked up from the case in the same INSERT. audit_log is append-only
 * (trigger in 001_core.sql, and the app database role in 003_audit_grants.sql has INSERT and SELECT only).
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

/** Express middleware: needs req.actor ({id, role}); everything run from next() sees that identity through audit(). */
function auditContext(req, res, next) {
  als.run({ userId: (req.actor && req.actor.id) || null, role: (req.actor && req.actor.role) || null, ip: req.ip || null }, next);
}

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/** Insert one audit row on `client` (the transaction client of the change it describes). Throws, and so fails the change, if it cannot. */
async function audit(client, e) {
  const ctx = als.getStore();
  if (!ctx || !ctx.userId) throw new Error('audit(): no authenticated request context');
  if (!e || !e.action || !e.entity) throw new Error('audit(): action and entity are required');
  await client.query(
    `INSERT INTO audit_log (user_id, role, action, entity, entity_id, patient_id, before, after, reason, ip)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::uuid, (SELECT patient_id FROM cases WHERE id = $7::uuid)), $8, $9, $10, $11)`,
    [ctx.userId, ctx.role, e.action, e.entity, e.entity_id == null ? null : String(e.entity_id), e.patient_id || null, e.case_id || null,
      json(e.before), json(e.after), e.reason || null, ctx.ip]);
}

module.exports = { audit, auditContext };
