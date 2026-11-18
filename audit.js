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

/**
 * Chunk 33c1: like audit(), but writes nothing if the same user already has the same action on the same entity within `minutes` (database clock).
 * Used for record views. A per-(user, action, entity) advisory lock, held to the end of the transaction, makes two simultaneous requests write ONE row.
 * Returns true when a row was written. Throws (so the caller's read fails) if the insert cannot be done.
 */
async function auditOnce(client, e, minutes) {
  const ctx = als.getStore();
  if (!ctx || !ctx.userId) throw new Error('auditOnce(): no authenticated request context');
  if (!e || !e.action || !e.entity || e.entity_id == null || !(minutes > 0)) throw new Error('auditOnce(): action, entity, entity_id and minutes are required');
  const eid = String(e.entity_id);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [[ctx.userId, e.action, e.entity, eid].join('|')]);
  const r = await client.query(
    `INSERT INTO audit_log (user_id, role, action, entity, entity_id, patient_id, ip)
     SELECT $1, $2, $3, $4, $5, COALESCE($6::uuid, (SELECT patient_id FROM cases WHERE id = $7::uuid)), $8
      WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE user_id = $1 AND action = $3 AND entity = $4 AND entity_id = $5 AND at > now() - make_interval(mins => $9))`,
    [ctx.userId, ctx.role, e.action, e.entity, eid, e.patient_id || null, e.case_id || null, ctx.ip, minutes]);
  return r.rowCount === 1;
}

// ---------- reading the log (chunk 33d, admin only) ----------
const AUDIT_MAX_PAGE = 200, AUDIT_CSV_MAX = 50000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn validated query values into a WHERE clause on `audit_log a LEFT JOIN users u`. Always parameterised. Filters: user (a user id, or a username),
 * patient (id), from (inclusive), to (exclusive; a bare date means the whole of that UTC day), action (exact, or a prefix ending in *), before (id cursor).
 */
function auditWhere(f) {
  const w = [], v = [], add = (sql, val) => { v.push(val); w.push(sql.replace('?', '$' + v.length)); };
  if (f.user) { if (UUID_RE.test(f.user)) add('a.user_id = ?::uuid', f.user); else add('lower(u.username) = lower(?)', f.user); }
  if (f.patient) add('a.patient_id = ?::uuid', f.patient);
  if (f.from) add('a.at >= ?::timestamptz', f.from);
  if (f.to) {
    if (DATE_ONLY.test(f.to)) add("a.at < (?::date + 1)::timestamp AT TIME ZONE 'UTC'", f.to);
    else add('a.at < ?::timestamptz', f.to);
  }
  if (f.action) {
    if (f.action.endsWith('*')) add("a.action LIKE ? ESCAPE '\\'", f.action.slice(0, -1).replace(/[\\%_]/g, '\\$&') + '%');
    else add('a.action = ?', f.action);
  }
  if (f.before) add('a.id < ?::bigint', String(f.before));
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', values: v };
}

/** One page, newest first, by id (keyset paging: stable while new rows arrive). `q` is a pool or a transaction client. */
async function auditPage(q, f, limit, max = AUDIT_MAX_PAGE) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), max), { sql, values } = auditWhere(f);
  const r = await q.query(
    `SELECT a.id, a.at, a.user_id, u.username, a.role, a.action, a.entity, a.entity_id, a.patient_id, a.before, a.after, a.reason, a.ip
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${sql} ORDER BY a.id DESC LIMIT ${n + 1}`, values);
  const more = r.rows.length > n, rows = more ? r.rows.slice(0, n) : r.rows;
  return { rows, nextBefore: more ? String(rows[rows.length - 1].id) : null };
}

/** CSV cell: text starting with = + - @ (or a tab/CR) gets a leading ' so a spreadsheet shows it as text, never runs it as a formula; then standard quoting. */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const CSV_COLUMNS = ['id', 'at', 'user_id', 'username', 'role', 'action', 'entity', 'entity_id', 'patient_id', 'reason', 'ip'];   // metadata only: before/after (clinical content) are not exported
const csvLine = (row) => CSV_COLUMNS.map((c) => csvCell(row[c])).join(',');

const auditOut = (r) => ({ id: String(r.id), at: r.at.toISOString(), userId: r.user_id, username: r.username || null, role: r.role, action: r.action, entity: r.entity,
  entityId: r.entity_id, patientId: r.patient_id, before: r.before, after: r.after, reason: r.reason, ip: r.ip });

module.exports = { audit, auditOnce, auditContext, auditWhere, auditPage, auditOut, csvCell, csvLine, CSV_COLUMNS, AUDIT_MAX_PAGE, AUDIT_CSV_MAX };
