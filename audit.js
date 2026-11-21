'use strict';
// Writes one audit row. Actor comes from req.user (the session), never from the request body.
// Pass a pg client to commit the audit row in the same transaction as the action.
async function audit(db, req, action, entityType, entityId, detail = {}) {
  const u = req.user || {};
  await db.query(
    `INSERT INTO audit_log(user_id, username, role, action, entity_type, entity_id, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [u.id || null, u.username || detail.username || null, u.role || null, action,
     entityType || null, entityId == null ? null : String(entityId), JSON.stringify(detail), req.ip || null]);
}
module.exports = { audit };
