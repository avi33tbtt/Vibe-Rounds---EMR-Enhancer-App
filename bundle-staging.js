'use strict';
// Task R6f-2a: stage a FHIR Bundle as PROPOSALS (stage, list, read one, reject one). Nothing here creates a clinical record and NO accept exists yet (R6f-2b, R6f-2c).
// The parser is bundle-import.js (R6f-1, pure, unchanged). The request body IS the bundle; the person is the session user, never a value from the file.
// Stored: the bundle hash, the parser's counts and the proposal fields. Never the raw bundle, names, notes or Patient identifiers (the parser reports a count only).
// The same bundle (same hash) is staged once; a second try gives 409 with the id of the first. A proposal is rejected with a reason and the loaded row_version; rejected is final.
// Audit rows hold counts, ids and a hash only: never labels, values, reasons or identifiers. One permission, import:write, guards all four routes.
const express = require('express');
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');
const { parseBundle, BundleImportError } = require('./bundle-import');

const BUNDLE_BODY_LIMIT = '2mb';   // up to 500 entries, so this route may exceed the 50 kb default (app.js skips the default for it)
const MAX_LIST = 50, MAX_REASON = 1000;
const isBundleStagePath = p => p === '/api/import/bundles';
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !BAD_CHARS.test(v);
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}

function mountBundleStaging(app, pool) {
  const PCOLS = `p.id, p.bundle_id, p.key, p.kind, p.entry_index, p.fields, p.blockers, p.warnings, p.ready, p.source_status, p.starts_as, p.status, p.row_version,
                 ru.username AS rejected_by, p.rejected_at, p.reject_reason`;
  const PFROM = `FROM import_proposals p LEFT JOIN users ru ON ru.id = p.rejected_by`;
  const BCOLS = `b.id, b.bundle_hash, b.bundle_type, b.summary, b.warnings, b.rejected, su.username AS staged_by, b.staged_at`;
  const BFROM = `FROM import_bundles b JOIN users su ON su.id = b.staged_by`;
  const loadBundle = async (c, id) => {
    const bundle = (await c.query(`SELECT ${BCOLS} ${BFROM} WHERE b.id = $1`, [id])).rows[0];
    if (!bundle) return null;
    bundle.proposals = (await c.query(`SELECT ${PCOLS} ${PFROM} WHERE p.bundle_id = $1 ORDER BY p.entry_index, p.id`, [id])).rows;
    return bundle;
  };

  // The route-level parser comes AFTER the permission guard, so a signed-out or forbidden caller never makes the server read a large body.
  app.post('/api/import/bundles', A.requirePerm(pool, 'import:write'), express.json({ limit: BUNDLE_BODY_LIMIT }), async (req, res) => {
    let parsed;
    try { parsed = parseBundle(req.body); }
    catch (e) {
      if (!(e instanceof BundleImportError)) throw e;
      await audit(pool, req, 'import.refused', 'import_bundle', null, { reason: 'not_a_readable_bundle' });
      return res.status(400).json({ error: 'invalid_bundle', message: e.message });
    }
    const out = await tx(pool, async c => {
      const dup = (await c.query('SELECT id FROM import_bundles WHERE bundle_hash = $1', [parsed.audit.hash])).rows[0];
      if (dup) return { status: 409, body: { error: 'already_staged', message: 'This bundle was staged before.', bundleId: dup.id } };
      const id = (await c.query('INSERT INTO import_bundles(bundle_hash, bundle_type, summary, warnings, rejected, staged_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [parsed.audit.hash, parsed.audit.bundleType, JSON.stringify({ ...parsed.summary, byType: parsed.audit.byType }), JSON.stringify(parsed.warnings), JSON.stringify(parsed.rejected), req.user.id])).rows[0].id;
      for (const p of parsed.proposals) {
        await c.query(`INSERT INTO import_proposals(bundle_id, key, kind, entry_index, fields, blockers, warnings, ready, source_status, starts_as) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, p.key, p.kind, p.index, JSON.stringify(p.fields || {}), JSON.stringify(p.blockers), JSON.stringify(p.warnings), p.ready, p.sourceStatus || null, p.startsAs || null]);
      }
      await audit(c, req, 'import.stage', 'import_bundle', id, parsed.audit);
      return { status: 201, body: { bundle: await loadBundle(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  app.get('/api/import/bundles', A.requirePerm(pool, 'import:write'), async (req, res) => {
    const bundles = (await pool.query(`SELECT ${BCOLS},
        count(p.id) FILTER (WHERE p.status = 'staged')::int AS staged_count, count(p.id) FILTER (WHERE p.status = 'rejected')::int AS rejected_count, count(p.id) FILTER (WHERE p.status = 'accepted')::int AS accepted_count
      ${BFROM} LEFT JOIN import_proposals p ON p.bundle_id = b.id GROUP BY b.id, su.username ORDER BY b.id DESC LIMIT ${MAX_LIST}`)).rows;
    await audit(pool, req, 'import.bundles_view', 'import_bundle', null, { count: bundles.length });
    res.json({ bundles });
  });

  app.get('/api/import/bundles/:id', A.requirePerm(pool, 'import:write'), async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const bundle = await loadBundle(pool, id);
    if (!bundle) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'import.bundle_view', 'import_bundle', id, { proposals: bundle.proposals.length });
    res.json({ bundle });
  });

  app.post('/api/import/proposals/:id/reject', A.requirePerm(pool, 'import:write'), async (req, res) => {
    const s = strict(req.body, ['reason', 'rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
    if (!text(s.body.reason, MAX_REASON)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, bundle_id, kind, status, row_version FROM import_proposals WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.status !== 'staged') return { status: 409, body: { error: 'proposal_final', message: 'This proposal was already ' + p.status + '.', currentRowVersion: p.row_version } };
      if (p.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This proposal was changed by someone else. Reload it and try again.', currentRowVersion: p.row_version } };
      const reason = s.body.reason.trim();
      await c.query(`UPDATE import_proposals SET status = 'rejected', row_version = row_version + 1, rejected_by = $2, rejected_at = clock_timestamp(), reject_reason = $3 WHERE id = $1`, [id, req.user.id, reason]);
      await audit(c, req, 'import.proposal_reject', 'import_bundle', p.bundle_id, { proposalId: id, kind: p.kind, length: reason.length, rowVersion: rv + 1 });
      return { status: 200, body: { proposal: (await c.query(`SELECT ${PCOLS} ${PFROM} WHERE p.id = $1`, [id])).rows[0] } };
    });
    res.status(out.status).json(out.body);
  });
}
module.exports = { mountBundleStaging, isBundleStagePath };
