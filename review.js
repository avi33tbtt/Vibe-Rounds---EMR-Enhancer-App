'use strict';
// Tasks 8b and 8c: submit a draft element-set version for review. Built on the B2a server versions (no separate snapshot table).
// Lint runs here, on the server, on the stored content. Errors block the submit; warnings are stored with the version.
// Submitter and time come from the session and the database clock; a body that names anything is refused.
// 8c: informaticians approve or reject with a reason. The author and the submitter never review; one reject ends the version;
// a set flagged needsTwoReviewers needs two different approving reviewers. The database enforces the same rules (migration 009).
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');
const { lint } = require('./lint');
const { checksumOf, validateDefinition } = require('./sets');

const BAD_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const parseVersion = v => (/^\d{1,9}$/.test(v) && +v >= 1 ? +v : null);
// The server has no terminology lookup for stored sets yet, so a bound code is never "verified" here (unknown never passes).
const serverBindingState = () => 'not verified on the server';

function lintStored(slug, kind, def) {
  const r = lint({ id: slug, kind: kind === 'custom' ? 'template' : kind, ...def }, { bindingState: serverBindingState });
  return { ok: r.ok, findings: r.findings, needsTwoReviewers: r.needsTwoReviewers };
}

const REVIEW_COLS = `s.id AS set_id, s.slug, s.title, v.version, v.status, v.checksum, v.created_at, v.submitted_at,
  cu.username AS created_by, su.username AS submitted_by, v.lint_json AS lint`;
const REVIEW_JOINS = `JOIN element_sets s ON s.id = v.element_set_id JOIN users cu ON cu.id = v.created_by LEFT JOIN users su ON su.id = v.submitted_by`;

function mountReview(app, pool) {
  app.post('/api/element-sets/:id/versions/:version/submit', A.requirePerm(pool, 'sets:submit'), async (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(b);
    if (extra.length) return res.status(400).json({ error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) });
    const n = parseVersion(req.params.version);
    if (!n) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const set = (await c.query('SELECT id, slug, kind FROM element_sets WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!set) return { status: 404, body: { error: 'not_found' } };
      const v = (await c.query('SELECT status, checksum, definition_json FROM element_set_versions WHERE element_set_id = $1 AND version = $2 FOR UPDATE', [set.id, n])).rows[0];
      if (!v) return { status: 404, body: { error: 'not_found' } };
      if (v.status !== 'draft') return { status: 409, body: { error: 'not_submittable', message: `This version is ${v.status}; only a draft can be submitted for review.` } };
      const reject = async (error, message, detail = {}, extraBody = {}) => {
        await audit(c, req, 'set.submit_rejected', 'element_set', set.id, { slug: set.slug, version: n, reason: error, ...detail });
        return { status: 422, body: { error, message, ...extraBody } };
      };
      if (checksumOf(v.definition_json) !== v.checksum) return reject('checksum_mismatch', 'The stored content no longer matches its checksum. It was not submitted.');
      const defErrors = validateDefinition(v.definition_json, set.slug, set.kind);
      if (defErrors.length) return reject('invalid_definition', 'The stored content is not valid declarative data. It was not submitted.');
      const result = lintStored(set.slug, set.kind, v.definition_json);
      const errors = result.findings.filter(f => f.severity === 'error');
      if (errors.length) return reject('lint_errors', `The set has ${errors.length} problem(s) that must be fixed first. Add a new draft version and submit that.`,
        { errors: errors.length, warnings: result.findings.length - errors.length }, { lint: result });
      await c.query(`UPDATE element_set_versions SET status = 'in_review', submitted_by = $3, submitted_at = now(), lint_json = $4 WHERE element_set_id = $1 AND version = $2`,
        [set.id, n, req.user.id, JSON.stringify(result)]);
      await audit(c, req, 'set.submit', 'element_set', set.id, { slug: set.slug, version: n, checksum: v.checksum, warnings: result.findings.length, needsTwoReviewers: result.needsTwoReviewers });
      const row = (await c.query(`SELECT ${REVIEW_COLS} FROM element_set_versions v ${REVIEW_JOINS} WHERE v.element_set_id = $1 AND v.version = $2`, [set.id, n])).rows[0];
      return { status: 200, body: { review: row } };
    });
    res.status(out.status).json(out.body);
  });

  app.get('/api/element-sets/:id/versions/:version/review', A.requirePerm(pool, 'sets:read'), async (req, res) => {
    const n = parseVersion(req.params.version);
    const row = n && /^\d{1,9}$/.test(req.params.id) && (await pool.query(`SELECT ${REVIEW_COLS} FROM element_set_versions v ${REVIEW_JOINS} WHERE v.element_set_id = $1 AND v.version = $2`, [req.params.id, n])).rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    const reviews = (await pool.query(`SELECT u.username AS reviewer, r.decision, r.reason, r.created_at FROM element_set_reviews r JOIN users u ON u.id = r.reviewer_id
                                        WHERE r.element_set_id = $1 AND r.version = $2 ORDER BY r.id`, [row.set_id, n])).rows;
    res.json({ review: row, reviews, approvalsNeeded: row.lint && row.lint.needsTwoReviewers === true ? 2 : 1 });
  });

  /* ---------- approve / reject (task 8c) ---------- */
  for (const decision of ['approve', 'reject']) {
    app.post(`/api/element-sets/:id/versions/:version/${decision}`, A.requirePerm(pool, 'sets:review'), async (req, res) => {
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const extra = Object.keys(b).filter(k => k !== 'reason');
      if (extra.length) return res.status(400).json({ error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) });
      const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (!reason || reason.length > 1000 || /\u0000/.test(reason) || BAD_SURROGATE.test(reason)) return res.status(400).json({ error: 'invalid', message: 'A reason is required: 1 to 1000 characters of plain text.' });
      const n = parseVersion(req.params.version);
      if (!n) return res.status(404).json({ error: 'not_found' });
      const out = await tx(pool, async c => {
        const set = (await c.query('SELECT id, slug FROM element_sets WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
        if (!set) return { status: 404, body: { error: 'not_found' } };
        const v = (await c.query('SELECT status, created_by, submitted_by, lint_json FROM element_set_versions WHERE element_set_id = $1 AND version = $2 FOR UPDATE', [set.id, n])).rows[0];
        if (!v) return { status: 404, body: { error: 'not_found' } };
        const refuse = async (status, error, message) => {
          await audit(c, req, 'set.review_refused', 'element_set', set.id, { slug: set.slug, version: n, decision, reason: error });
          return { status, body: { error, message } };
        };
        if (v.status !== 'in_review') return { status: 409, body: { error: 'not_in_review', message: `This version is ${v.status}; only a version in review can be ${decision}d.` } };
        if (req.user.id === v.created_by || req.user.id === v.submitted_by) return refuse(403, 'own_version', 'You wrote or submitted this version, so you cannot review it.');
        if ((await c.query('SELECT 1 FROM element_set_reviews WHERE element_set_id = $1 AND version = $2 AND reviewer_id = $3', [set.id, n, req.user.id])).rowCount) return refuse(409, 'already_reviewed', 'You have already reviewed this version.');
        await c.query('INSERT INTO element_set_reviews(element_set_id, version, reviewer_id, decision, reason) VALUES ($1,$2,$3,$4,$5)', [set.id, n, req.user.id, decision, reason]);
        const needed = v.lint_json && v.lint_json.needsTwoReviewers === true ? 2 : 1;
        let status = 'in_review';
        if (decision === 'reject') status = 'rejected';
        else {
          const approvals = (await c.query(`SELECT count(DISTINCT reviewer_id)::int AS n FROM element_set_reviews WHERE element_set_id = $1 AND version = $2 AND decision = 'approve'`, [set.id, n])).rows[0].n;
          if (approvals >= needed) status = 'reviewed';
        }
        if (status !== 'in_review') await c.query('UPDATE element_set_versions SET status = $3 WHERE element_set_id = $1 AND version = $2', [set.id, n, status]);
        await audit(c, req, 'set.' + decision, 'element_set', set.id, { slug: set.slug, version: n, resultingStatus: status, approvalsNeeded: needed, reasonLength: reason.length });
        return { status: 200, body: { status, approvalsNeeded: needed } };
      });
      res.status(out.status).json(out.body);
    });
  }

  app.get('/api/review-queue', A.requirePerm(pool, 'sets:read'), async (_req, res) => {
    const { rows } = await pool.query(`SELECT ${REVIEW_COLS} FROM element_set_versions v ${REVIEW_JOINS} WHERE v.status = 'in_review' ORDER BY v.submitted_at, s.id LIMIT 200`);
    res.json({ queue: rows });
  });
}

module.exports = { mountReview, lintStored };
