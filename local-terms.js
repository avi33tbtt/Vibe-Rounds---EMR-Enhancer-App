'use strict';
// Task R2f-1: local terms. A free in-house vocabulary (system key "local"); no licensed code system is used.
// R2f-1 adds drafts and reads; R2f-2 adds submit, approve or reject (informatician, never the author or submitter), publish and retire (admin).
// Who and when always come from the session and the database clock; the status rules are also enforced by triggers (migration 017).
// The author comes from the session; a body that names anything else (createdBy, status, version ...) is refused.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');

const CODE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CATEGORIES = ['finding', 'condition', 'test', 'procedure', 'observation', 'other'];
const STATUSES = ['draft', 'in_review', 'rejected', 'reviewed', 'published', 'retired'];
const BAD_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Plain one-line or short text: no control characters (tab and newline allowed only in the definition), no lone surrogates.
const plain = (v, max, multiline) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max && !BAD_SURROGATE.test(v)
  && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v);

const COLS = `t.id, t.code, t.version, t.display, t.category, t.definition, t.status, t.created_at, u.username AS created_by`;
const JOIN = `JOIN users u ON u.id = t.created_by`;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });

function mountLocalTerms(app, pool) {
  app.post('/api/local-terms', A.requirePerm(pool, 'terms:write'), async (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(b).filter(k => !['code', 'display', 'category', 'definition'].includes(k));
    if (extra.length) return res.status(400).json({ error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) });
    if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) return bad(res, 'code must be 1 to 64 characters: lowercase letters, digits, . _ and -, starting with a letter or digit.');
    if (!plain(b.display, 200, false)) return bad(res, 'display is required: 1 to 200 characters of plain one-line text.');
    const category = b.category === undefined ? 'other' : b.category;
    if (!CATEGORIES.includes(category)) return bad(res, 'category must be one of: ' + CATEGORIES.join(', '));
    if (b.definition !== undefined && b.definition !== null && !plain(b.definition, 500, true)) return bad(res, 'definition must be 1 to 500 characters of plain text (or left out).');
    const definition = b.definition == null ? null : b.definition.trim();
    const display = b.display.trim();
    try {
      const out = await tx(pool, async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['local-term:' + b.code]);   // two adds for the same code take turns
        const last = (await c.query('SELECT version, status FROM local_terms WHERE code = $1 ORDER BY version DESC LIMIT 1', [b.code])).rows[0];
        if (last && ['draft', 'in_review', 'reviewed'].includes(last.status)) {
          await audit(c, req, 'term.create_rejected', 'local_term', null, { code: b.code, reason: 'open_version', openVersion: last.version, openStatus: last.status });
          return { status: 409, body: { error: 'open_version', message: `Version ${last.version} of this code is ${last.status}. Finish or reject it before adding another version.` } };
        }
        const version = last ? last.version + 1 : 1;
        const row = (await c.query(`INSERT INTO local_terms(code, version, display, category, definition, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [b.code, version, display, category, definition, req.user.id])).rows[0];
        await audit(c, req, 'term.create', 'local_term', row.id, { code: b.code, version, category });
        const term = (await c.query(`SELECT ${COLS} FROM local_terms t ${JOIN} WHERE t.id = $1`, [row.id])).rows[0];
        return { status: 201, body: { term } };
      });
      res.status(out.status).json(out.body);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'conflict', message: 'That code and version already exist. Reload and try again.' });
      throw e;
    }
  });

  app.get('/api/local-terms', A.requirePerm(pool, 'terms:read'), async (req, res) => {
    const { status, q } = req.query;
    if (status !== undefined && !STATUSES.includes(status)) return bad(res, 'status must be one of: ' + STATUSES.join(', '));
    if (q !== undefined && (typeof q !== 'string' || q.length > 100)) return bad(res, 'q must be text of at most 100 characters.');
    const args = []; const where = [`t.version = (SELECT max(x.version) FROM local_terms x WHERE x.code = t.code)`];   // one row per code: its latest version
    if (status) { args.push(status); where.push(`t.status = $${args.length}`); }
    if (q) { args.push('%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'); where.push(`(t.code ILIKE $${args.length} OR t.display ILIKE $${args.length})`); }
    const { rows } = await pool.query(`SELECT ${COLS} FROM local_terms t ${JOIN} WHERE ${where.join(' AND ')} ORDER BY t.code LIMIT 500`, args);
    res.json({ terms: rows });
  });

  app.get('/api/local-terms/:id', A.requirePerm(pool, 'terms:read'), async (req, res) => {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const term = (await pool.query(`SELECT ${COLS} FROM local_terms t ${JOIN} WHERE t.id = $1`, [req.params.id])).rows[0];
    if (!term) return res.status(404).json({ error: 'not_found' });
    const versions = (await pool.query(`SELECT t.id, t.version, t.display, t.status, t.created_at FROM local_terms t WHERE t.code = $1 ORDER BY t.version DESC`, [term.code])).rows;
    const reviews = (await pool.query(`SELECT u.username AS reviewer, r.decision, r.reason, r.created_at FROM local_term_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.term_id = $1 ORDER BY r.id`, [term.id])).rows;
    res.json({ term, versions, reviews });
  });

  /* ---------- status steps (R2f-2) ---------- */
  // One helper for the five steps: lock the code, load the row, check the state, run the change, audit in the same transaction.
  const step = (action, perm, { from, allowReason, change }) => app.post(`/api/local-terms/:id/${action}`, A.requirePerm(pool, perm), async (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(b).filter(k => !(allowReason && k === 'reason'));
    if (extra.length) return res.status(400).json({ error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) });
    let reason = null;
    if (allowReason) {
      reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (!plain(reason, 1000, true)) return bad(res, 'A reason is required: 1 to 1000 characters of plain text.');
    }
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const t0 = (await c.query('SELECT code FROM local_terms WHERE id = $1', [req.params.id])).rows[0];
      if (!t0) return { status: 404, body: { error: 'not_found' } };
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['local-term:' + t0.code]);
      const t = (await c.query('SELECT id, code, version, status, created_by, submitted_by FROM local_terms WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!from.includes(t.status)) return { status: 409, body: { error: 'wrong_status', message: `This version is ${t.status}; it cannot be ${action}d from there.` } };
      const refuse = async (status, error, message) => {
        await audit(c, req, 'term.refused', 'local_term', t.id, { code: t.code, version: t.version, attempted: action, reason: error });
        return { status, body: { error, message } };
      };
      const r = await change(c, req, t, reason, refuse);
      if (r) return r;   // a refusal
      const term = (await c.query(`SELECT ${COLS} FROM local_terms t ${JOIN} WHERE t.id = $1`, [t.id])).rows[0];
      return { status: 200, body: { term } };
    });
    res.status(out.status).json(out.body);
  });
  const setStatus = (c, id, status, extra = '') => c.query(`UPDATE local_terms SET status = $2${extra} WHERE id = $1`, [id, status]);

  step('submit', 'terms:submit', { from: ['draft'], change: async (c, req, t) => {
    await c.query(`UPDATE local_terms SET status = 'in_review', submitted_by = $2, submitted_at = clock_timestamp() WHERE id = $1`, [t.id, req.user.id]);
    await audit(c, req, 'term.submit', 'local_term', t.id, { code: t.code, version: t.version });
  } });
  for (const decision of ['approve', 'reject']) step(decision, 'terms:review', { from: ['in_review'], allowReason: true, change: async (c, req, t, reason, refuse) => {
    if (req.user.id === t.created_by || req.user.id === t.submitted_by) return refuse(403, 'own_term', 'You wrote or submitted this term, so you cannot review it.');
    if ((await c.query('SELECT 1 FROM local_term_reviews WHERE term_id = $1 AND reviewer_id = $2', [t.id, req.user.id])).rowCount) return refuse(409, 'already_reviewed', 'You have already reviewed this term.');
    await c.query('INSERT INTO local_term_reviews(term_id, reviewer_id, decision, reason) VALUES ($1,$2,$3,$4)', [t.id, req.user.id, decision, reason]);
    await setStatus(c, t.id, decision === 'approve' ? 'reviewed' : 'rejected');
    await audit(c, req, 'term.' + decision, 'local_term', t.id, { code: t.code, version: t.version, reasonLength: reason.length });
  } });
  step('publish', 'terms:publish', { from: ['reviewed'], change: async (c, req, t) => {
    // one published version per code: the earlier one is retired in the same transaction
    const old = (await c.query(`UPDATE local_terms SET status = 'retired', retired_by = $2, retired_at = clock_timestamp() WHERE code = $1 AND status = 'published' RETURNING id, version`, [t.code, req.user.id])).rows;
    for (const o of old) await audit(c, req, 'term.retire', 'local_term', o.id, { code: t.code, version: o.version, because: 'newer_version_published' });
    await c.query(`UPDATE local_terms SET status = 'published', published_by = $2, published_at = clock_timestamp() WHERE id = $1`, [t.id, req.user.id]);
    await audit(c, req, 'term.publish', 'local_term', t.id, { code: t.code, version: t.version });
  } });
  step('retire', 'terms:publish', { from: ['published'], change: async (c, req, t) => {
    await c.query(`UPDATE local_terms SET status = 'retired', retired_by = $2, retired_at = clock_timestamp() WHERE id = $1`, [t.id, req.user.id]);
    await audit(c, req, 'term.retire', 'local_term', t.id, { code: t.code, version: t.version });
  } });
}

module.exports = { mountLocalTerms, CODE_RE, CATEGORIES };
