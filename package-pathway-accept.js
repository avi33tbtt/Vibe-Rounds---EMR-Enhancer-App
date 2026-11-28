'use strict';
// Task D8: accept ONE staged pathway proposal as a DRAFT pathway (version 1) through the existing pathway rules. Needs import:write and sets:write.
// Each step is matched by SOURCE (artefact id, version and the checksum staged for that set in the same import), never by slug (ED-91).
// Every member must already be a PUBLISHED set version. Accept creates a draft only; publish stays the existing admin route (ED-92).
// Audit holds ids, a slug and checksums, never titles or labels. Prototype. Synthetic data only. Not for clinical use.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');
const { checksumOf } = require('./sets');
const { checkText, contentOf } = require('./pathways');

const MAX_STEPS = 30, HEX = /^[0-9a-f]{64}$/;
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function mountPackagePathwayAccept(app, pool) {
  app.post('/api/import/package-proposals/:id/accept-pathway', A.requirePerm(pool, 'import:write'), A.requirePerm(pool, 'sets:write'), async (req, res) => {
    const b0 = isObj(req.body) ? req.body : {}, extra = Object.keys(b0).filter(k => k !== 'rowVersion');
    if (extra.length) return res.status(400).json({ error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) });
    const rv = posInt(b0.rowVersion), id = /^\d{1,9}$/.test(String(req.params.id)) && +req.params.id >= 1 ? +req.params.id : null;
    if (rv === null) return res.status(400).json({ error: 'invalid', message: 'rowVersion is required (the version you loaded).' });
    if (!id) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, import_id, kind, slug, body, ready, status, row_version FROM package_proposals WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (p.status !== 'staged') return { status: 409, body: { error: 'proposal_final', message: 'This proposal was already ' + p.status + '.', currentRowVersion: p.row_version } };
      if (p.row_version !== rv) return { status: 409, body: { error: 'version_conflict', message: 'This proposal was changed by someone else. Reload it and try again.', currentRowVersion: p.row_version } };
      if (p.kind !== 'pathway') return { status: 409, body: { error: 'not_a_pathway', message: 'Only a pathway proposal is accepted here. A set goes to the set accept route.' } };
      if (!p.ready) return { status: 409, body: { error: 'not_ready', message: 'This proposal has blockers. It cannot be accepted.' } };
      const refuse = async (status, error, message, extra2 = {}) => { await audit(c, req, 'import.package_accept_refused', 'package_import', p.import_id, { proposalId: id, reason: error }); return { status, body: { error, message, ...extra2 } }; };
      const b = p.body, src = b && b.source, steps = b && b.steps;
      if (!b || b.slug !== p.slug || !src || !HEX.test(src.checksum || '') || typeof src.artefactId !== 'string' || typeof src.version !== 'string' || !isObj(b.entryForm) || !Array.isArray(b.contexts)
          || !Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS || checkText(b.title, b.description, p.slug).length)
        return refuse(422, 'invalid_pathway', 'The staged content is not valid declarative data. It was not accepted.');
      // checksums staged for each set of this same import, by source artefact id and version
      const staged = (await c.query(`SELECT body->'source' AS source FROM package_proposals WHERE import_id = $1 AND kind = 'set'`, [p.import_id])).rows.map(r => r.source);
      const rows = [], missing = [];
      for (const st of steps) {
        const s = st && st.source, want = s && staged.find(x => x && x.artefactId === s.artefactId && x.version === s.version);
        const r = want && (await c.query(`SELECT v.id AS set_version_id, v.version AS set_version, v.checksum AS set_checksum, s.id AS set_id, s.slug AS set_slug FROM element_set_versions v JOIN element_sets s ON s.id = v.element_set_id
            WHERE v.source_artefact_id = $1 AND v.source_version = $2 AND v.source_checksum = $3 AND v.status = 'published' ORDER BY v.id LIMIT 1`, [s.artefactId, s.version, want.checksum])).rows[0];
        if (r) rows.push(r); else missing.push(typeof st.set === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(st.set) ? st.set : '?');
      }
      if (missing.length) return refuse(409, 'member_not_published', 'These sets are not published from this package yet: ' + missing.join(', ') + '. Review and publish them first.', { sets: missing });
      if (new Set(rows.map(r => r.set_id)).size !== rows.length) return refuse(422, 'invalid_pathway', 'A set appears twice in the pathway. It was not accepted.');
      if ((await c.query('SELECT 1 FROM pathway_versions WHERE source_artefact_id = $1 AND source_version = $2 AND source_checksum = $3', [src.artefactId, src.version, src.checksum])).rows[0])
        return refuse(409, 'already_imported', 'This artefact version was imported before.');
      if ((await c.query('SELECT 1 FROM pathways WHERE slug = $1', [p.slug])).rows[0]) return refuse(409, 'slug_taken', 'A pathway with that slug already exists. A new version from a package is not built yet.');
      const description = b.description, checksum = checksumOf(contentOf(b.title, description, rows));
      const path = (await c.query('INSERT INTO pathways(slug, title, created_by) VALUES ($1,$2,$3) RETURNING id', [p.slug, b.title.trim(), req.user.id])).rows[0];
      const v = (await c.query(`INSERT INTO pathway_versions(pathway_id, version, title, description, checksum, created_by, source_artefact_id, source_version, source_checksum, entry_form, contexts)
        VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [path.id, b.title.trim(), description, checksum, req.user.id, src.artefactId, src.version, src.checksum, JSON.stringify(b.entryForm), JSON.stringify(b.contexts)])).rows[0];
      for (let i = 0; i < rows.length; i++) await c.query('INSERT INTO pathway_version_steps(pathway_version_id, position, element_set_id, element_set_version_id) VALUES ($1,$2,$3,$4)', [v.id, i + 1, rows[i].set_id, rows[i].set_version_id]);
      await c.query(`UPDATE package_proposals SET status = 'accepted', row_version = row_version + 1, accepted_by = $2, accepted_at = clock_timestamp(), accepted_ref = $3 WHERE id = $1`, [id, req.user.id, path.id]);
      await audit(c, req, 'import.package_accept_pathway', 'package_import', p.import_id, { proposalId: id, pathwayId: path.id, slug: p.slug, version: 1, steps: rows.length, checksum, sourceChecksum: src.checksum });
      return { status: 200, body: { pathwayId: path.id, versionId: v.id } };
    });
    res.status(out.status).json(out.body);
  });
}

module.exports = { mountPackagePathwayAccept };
