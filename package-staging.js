'use strict';
// Task D6: stage a package bundle as PROPOSALS (stage, list, read one, reject one). Staging, listing, reading and rejecting create no element set, no pathway and no clinical record.
// The parser is package-import.js (D5, D5a, pure, unchanged). The person is the session user, never a value from the file. The raw bundle is never stored.
// A package with blockers IS staged so a person can read them; a package with no readable element is refused (400). The same bundle (same hash) is staged once: a second try gives 409.
// Audit rows hold counts, ids and a hash only: never titles, labels or reasons. One permission, import:write, guards all four routes. Accepting is D7 and D8.
// Prototype. Synthetic data only. Not for clinical use.
const express = require('express');
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');
const { parsePackage, PackageImportError } = require('./package-import');

const BODY_LIMIT = '2mb', MAX_LIST = 50, MAX_REASON = 1000;
const isPackageStagePath = p => p === '/api/import/packages';
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

function mountPackageStaging(app, pool) {
  const PCOLS = `p.id, p.import_id, p.key, p.kind, p.slug, p.body, p.blockers, p.ready, p.status, p.row_version, ru.username AS rejected_by, p.rejected_at, p.reject_reason`;
  const PFROM = `FROM package_proposals p LEFT JOIN users ru ON ru.id = p.rejected_by`;
  const ICOLS = `i.id, i.bundle_hash, i.summary, i.blockers, i.concept_map, su.username AS staged_by, i.staged_at`;
  const IFROM = `FROM package_imports i JOIN users su ON su.id = i.staged_by`;
  const load = async (c, id) => {
    const imp = (await c.query(`SELECT ${ICOLS} ${IFROM} WHERE i.id = $1`, [id])).rows[0];
    if (!imp) return null;
    imp.proposals = (await c.query(`SELECT ${PCOLS} ${PFROM} WHERE p.import_id = $1 ORDER BY p.id`, [id])).rows;
    return imp;
  };
  const guard = A.requirePerm(pool, 'import:write');

  // The route-level parser comes AFTER the permission guard, so a signed-out or forbidden caller never makes the server read a large body.
  app.post('/api/import/packages', guard, express.json({ limit: BODY_LIMIT }), async (req, res) => {
    let r;
    try { r = await parsePackage(req.body); }
    catch (e) {
      if (!(e instanceof PackageImportError)) throw e;
      await audit(pool, req, 'import.package_refused', 'package_import', null, { reason: 'not_a_readable_package' });
      return res.status(400).json({ error: 'invalid_package', message: e.message });
    }
    if (!r.proposals.length) {
      await audit(pool, req, 'import.package_refused', 'package_import', null, { reason: 'no_readable_element', blockers: r.blockers.length });
      return res.status(400).json({ error: 'invalid_package', message: 'No element in this package could be read.', blockers: r.blockers.slice(0, 50) });
    }
    const out = await tx(pool, async c => {
      const dup = (await c.query('SELECT id FROM package_imports WHERE bundle_hash = $1', [r.bundleHash])).rows[0];
      if (dup) return { status: 409, body: { error: 'already_staged', message: 'This package was staged before.', importId: dup.id } };
      const id = (await c.query('INSERT INTO package_imports(bundle_hash, summary, blockers, concept_map, staged_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [r.bundleHash, JSON.stringify(r.counts), JSON.stringify(r.blockers), JSON.stringify(r.conceptMap), req.user.id])).rows[0].id;
      const rows = [...r.proposals.map(p => ['set', p]), ...r.pathways.map(p => ['pathway', p])];
      for (const [kind, p] of rows) {
        const blockers = Array.isArray(p.blockers) ? p.blockers : [];
        await c.query(`INSERT INTO package_proposals(import_id, key, kind, slug, body, blockers, ready) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, `${kind}${p.artefact || '#' + id}`.slice(0, 80), kind, String(p.slug || 'unnamed').slice(0, 80), JSON.stringify(p), JSON.stringify(blockers), blockers.length === 0]);
      }
      await audit(c, req, 'import.package_stage', 'package_import', id, { hash: r.bundleHash, ...r.counts });
      return { status: 201, body: { import: await load(c, id) } };
    });
    res.status(out.status).json(out.body);
  });

  app.get('/api/import/packages', guard, async (req, res) => {
    const imports = (await pool.query(`SELECT ${ICOLS},
        count(p.id) FILTER (WHERE p.status = 'staged')::int AS staged_count, count(p.id) FILTER (WHERE p.status = 'rejected')::int AS rejected_count, count(p.id) FILTER (WHERE p.status = 'accepted')::int AS accepted_count
      ${IFROM} LEFT JOIN package_proposals p ON p.import_id = i.id GROUP BY i.id, su.username ORDER BY i.id DESC LIMIT ${MAX_LIST}`)).rows;
    await audit(pool, req, 'import.packages_view', 'package_import', null, { count: imports.length });
    res.json({ imports });
  });

  app.get('/api/import/packages/:id', guard, async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const imp = await load(pool, id);
    if (!imp) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'import.package_view', 'package_import', id, { proposals: imp.proposals.length });
    res.json({ import: imp });
  });

  app.post('/api/import/package-proposals/:id/reject', guard, async (req, res) => {
    const s = strict(req.body, ['reason', 'rowVersion']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), rv = posInt(s.body.rowVersion);
    if (!text(s.body.reason, MAX_REASON)) return bad(res, `A reason of 1 to ${MAX_REASON} characters is required.`);
    if (rv === null) return bad(res, 'rowVersion is required (the version you loaded).');
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, import_id, kind, status, row_version FROM package_proposals WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.status !== 'staged') return { status: 409, body: { error: 'proposal_final', message: 'This proposal was already ' + p.status + '.', currentRowVersion: p.row_version } };
      if (p.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This proposal was changed by someone else. Reload it and try again.', currentRowVersion: p.row_version } };
      const reason = s.body.reason.trim();
      await c.query(`UPDATE package_proposals SET status = 'rejected', row_version = row_version + 1, rejected_by = $2, rejected_at = clock_timestamp(), reject_reason = $3 WHERE id = $1`, [id, req.user.id, reason]);
      await audit(c, req, 'import.package_proposal_reject', 'package_import', p.import_id, { proposalId: id, kind: p.kind, length: reason.length, rowVersion: rv + 1 });
      return { status: 200, body: { proposal: (await c.query(`SELECT ${PCOLS} ${PFROM} WHERE p.id = $1`, [id])).rows[0] } };
    });
    res.status(out.status).json(out.body);
  });
}

module.exports = { mountPackageStaging, isPackageStagePath };
