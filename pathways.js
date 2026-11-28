'use strict';
// Task B4a: pathways with immutable versions (server), and applying a pathway to a case.
// A pathway version is an ordered list of steps; each step names an EXACT published element set version, so nothing mutable is embedded.
// Applying a pathway to a case creates one case_applied_pathways row plus ordinary case_applied_sets pins that link back to it;
// every pin stays independently withdrawable (the withdraw route from B3a). An existing pin is never changed by a pathway:
// updating a pin stays an explicit action. Every actor (created_by, published_by, applied_by) comes from the session; a body that names one is refused.
// Routes are registered straight on the app (no nested router) so the safety tests see them.
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');
const { checksumOf, validateDefinition } = require('./sets');
const { APPLIED, APPLIED_FROM } = require('./observations');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_STEPS = 30;

const bad = (res, message, extra = {}) => res.status(400).json({ error: 'invalid', message, ...extra });
// Only these body keys are accepted per route. Anything else (createdBy, publishedBy, status ...) is refused, not ignored.
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const isStr = v => typeof v === 'string';
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = v => (Number.isInteger(v) && v >= 1 && v <= 2147483646 ? v : null);
const idParam = v => (/^\d{1,9}$/.test(String(v)) && +v >= 1 ? +v : null);

// Title and description are plain text: the same rules as element set text (length, no markup-like or broken text), by reusing that validator.
function checkText(title, description, slug) {
  if (!isStr(title) || !title.trim()) return [{ path: 'title', message: 'is required text.' }];
  if (description !== undefined && !isStr(description)) return [{ path: 'description', message: 'must be text.' }];
  return validateDefinition({ title, desc: description === undefined ? '' : description, fields: [{ id: 'x', label: 'x', type: 'text' }] }, slug, 'template')
    .map(e => (e.path === 'desc' ? { ...e, path: 'description' } : e));
}
// steps: [{ setId, version }], 1 to 30, each set at most once. Returns { error } or { steps }.
function checkSteps(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_STEPS) return { error: `steps must be a list of 1 to ${MAX_STEPS} steps.` };
  const seen = new Set(), steps = [];
  for (let i = 0; i < raw.length; i++) {
    const st = raw[i];
    if (!isObj(st)) return { error: `steps[${i}] must be an object.` };
    const extra = Object.keys(st).filter(k => !['setId', 'version'].includes(k));
    if (extra.length) return { error: `steps[${i}] cannot set: ${extra.slice(0, 5).join(', ')}.` };
    const setId = posInt(st.setId), version = posInt(st.version);
    if (!setId || !version) return { error: `steps[${i}] needs setId and version as whole numbers (a step names an exact set version).` };
    if (seen.has(setId)) return { error: `steps[${i}]: each set can appear only once in a pathway version.` };
    seen.add(setId); steps.push({ setId, version });
  }
  return { steps };
}

const PATH_COLS = `p.id, p.slug, p.title, p.status, p.created_at, p.updated_at`;
const VER_COLS = `v.id AS version_id, v.version, v.title, v.description, v.status, v.checksum, v.created_at, v.published_at, v.retired_at,
  cu.username AS created_by, pu.username AS published_by, ru.username AS retired_by,
  (SELECT count(*)::int FROM pathway_version_steps st WHERE st.pathway_version_id = v.id) AS step_count`;
const VER_JOINS = `JOIN users cu ON cu.id = v.created_by LEFT JOIN users pu ON pu.id = v.published_by LEFT JOIN users ru ON ru.id = v.retired_by`;
const STEP_SQL = `SELECT st.position, st.element_set_id AS set_id, s.slug AS set_slug, s.title AS set_title, sv.version AS set_version,
                         st.element_set_version_id AS set_version_id, sv.checksum AS set_checksum, sv.status AS set_status
                    FROM pathway_version_steps st JOIN element_set_versions sv ON sv.id = st.element_set_version_id JOIN element_sets s ON s.id = st.element_set_id
                   WHERE st.pathway_version_id = $1 ORDER BY st.position`;
// What the checksum covers: title, description and the ordered exact members (set slug, version and the checksum of that set version).
const contentOf = (title, description, steps) => ({
  title: title.trim(), description,
  steps: steps.map((s, i) => ({ position: i + 1, set: s.set_slug, version: s.set_version, checksum: s.set_checksum })),
});

function mountPathways(app, pool) {
  const pathById = async (c, id, lock) => (await c.query(`SELECT ${PATH_COLS} FROM pathways p WHERE p.id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  const versionRow = async (c, pathwayId, n) => (await c.query(`SELECT ${VER_COLS} FROM pathway_versions v ${VER_JOINS} WHERE v.pathway_id = $1 AND v.version = $2`, [pathwayId, n])).rows[0];
  const stepsOf = async (c, versionId) => (await c.query(STEP_SQL, [versionId])).rows;
  const withSteps = async (c, v) => v && { ...v, steps: await stepsOf(c, v.version_id) };

  // Resolve [{setId, version}] to the exact published set versions, in order. Returns { error: [status, code, message] } or { rows }.
  const resolveSteps = async (c, steps) => {
    const rows = [];
    for (let i = 0; i < steps.length; i++) {
      const r = (await c.query(`SELECT v.id AS set_version_id, v.element_set_id AS set_id, v.version AS set_version, v.status AS set_status, v.checksum AS set_checksum, s.slug AS set_slug
                                  FROM element_set_versions v JOIN element_sets s ON s.id = v.element_set_id WHERE v.element_set_id = $1 AND v.version = $2`,
        [steps[i].setId, steps[i].version])).rows[0];
      if (!r) return { error: [400, 'step_not_found', `steps[${i}]: that set version does not exist.`] };
      if (r.set_status !== 'published') return { error: [409, 'member_not_published', `steps[${i}]: only a published set version can be a step (it is ${r.set_status}).`] };
      rows.push(r);
    }
    return { rows };
  };

  /* ---------- create a pathway (and its first draft version) ---------- */
  app.post('/api/pathways', A.requirePerm(pool, 'sets:write'), async (req, res) => {
    const s = strict(req.body, ['slug', 'title', 'description', 'steps']);
    if (s.error) return res.status(400).json(s.error);
    const { slug, title } = s.body, description = s.body.description === undefined ? '' : s.body.description;
    if (!isStr(slug) || !SLUG_RE.test(slug)) return bad(res, 'slug must be 1 to 64 characters: lowercase letters, digits, _ and -, starting with a letter or digit.');
    const terr = checkText(title, description, slug);
    if (terr.length) return bad(res, 'The text is not valid plain text: ' + terr[0].path + ' ' + terr[0].message, { errors: terr });
    const st = checkSteps(s.body.steps);
    if (st.error) return bad(res, st.error);
    try {
      const out = await tx(pool, async c => {
        const r = await resolveSteps(c, st.steps);
        if (r.error) return { status: r.error[0], body: { error: r.error[1], message: r.error[2] } };
        const checksum = checksumOf(contentOf(title, description, r.rows));
        const p = (await c.query('INSERT INTO pathways(slug, title, created_by) VALUES ($1,$2,$3) RETURNING id', [slug, title.trim(), req.user.id])).rows[0];
        const v = (await c.query(`INSERT INTO pathway_versions(pathway_id, version, title, description, checksum, created_by) VALUES ($1,1,$2,$3,$4,$5) RETURNING id`,
          [p.id, title.trim(), description, checksum, req.user.id])).rows[0];
        for (let i = 0; i < r.rows.length; i++) await c.query('INSERT INTO pathway_version_steps(pathway_version_id, position, element_set_id, element_set_version_id) VALUES ($1,$2,$3,$4)', [v.id, i + 1, r.rows[i].set_id, r.rows[i].set_version_id]);
        await audit(c, req, 'pathway.create', 'pathway', p.id, { slug, version: 1, steps: r.rows.length, checksum });
        return { status: 201, body: { pathway: await pathById(c, p.id), version: await withSteps(c, await versionRow(c, p.id, 1)) } };
      });
      res.status(out.status).json(out.body);
    } catch (e) {
      if (e.code === '23505' && e.constraint === 'pathways_slug_key') {
        await audit(pool, req, 'pathway.create_rejected', 'pathway', null, { reason: 'slug_taken', slug });
        return res.status(409).json({ error: 'slug_taken', message: 'A pathway with that slug already exists. Slugs are never reused; add a new version to the existing pathway.' });
      }
      throw e;
    }
  });

  /* ---------- list + read ---------- */
  app.get('/api/pathways', A.requirePerm(pool, 'sets:read'), async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${PATH_COLS},
              (SELECT max(version) FROM pathway_versions v WHERE v.pathway_id = p.id) AS latest_version,
              (SELECT max(version) FROM pathway_versions v WHERE v.pathway_id = p.id AND v.status = 'published') AS published_version
         FROM pathways p ORDER BY p.slug LIMIT 500`);
    res.json({ pathways: rows });
  });

  app.get('/api/pathways/:id', A.requirePerm(pool, 'sets:read'), async (req, res) => {
    const id = idParam(req.params.id);
    const p = id && await pathById(pool, id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    const versions = (await pool.query(`SELECT ${VER_COLS} FROM pathway_versions v ${VER_JOINS} WHERE v.pathway_id = $1 ORDER BY v.version DESC`, [p.id])).rows;
    res.json({ pathway: p, versions });
  });

  app.get('/api/pathways/:id/versions/:version', A.requirePerm(pool, 'sets:read'), async (req, res) => {
    const id = idParam(req.params.id), n = idParam(req.params.version);
    const p = id && n && await pathById(pool, id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    const v = await versionRow(pool, p.id, n);
    if (!v) return res.status(404).json({ error: 'not_found' });
    res.json({ pathway: p, version: await withSteps(pool, v) });
  });

  /* ---------- new draft version (the number is chosen by the server) ---------- */
  app.post('/api/pathways/:id/versions', A.requirePerm(pool, 'sets:write'), async (req, res) => {
    const s = strict(req.body, ['title', 'description', 'steps']);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const description = s.body.description === undefined ? '' : s.body.description;
    const st = checkSteps(s.body.steps);
    if (st.error) return bad(res, st.error);
    const out = await tx(pool, async c => {
      const p = await pathById(c, id, true);                       // the pathway row is the lock that serialises version numbers
      if (!p) return { status: 404, body: { error: 'not_found' } };
      const terr = checkText(s.body.title, description, p.slug);
      if (terr.length) return { status: 400, body: { error: 'invalid', message: 'The text is not valid plain text: ' + terr[0].path + ' ' + terr[0].message, errors: terr } };
      const r = await resolveSteps(c, st.steps);
      if (r.error) return { status: r.error[0], body: { error: r.error[1], message: r.error[2] } };
      const checksum = checksumOf(contentOf(s.body.title, description, r.rows));
      const n = (await c.query('SELECT COALESCE(max(version), 0) + 1 AS n FROM pathway_versions WHERE pathway_id = $1', [p.id])).rows[0].n;
      const v = (await c.query(`INSERT INTO pathway_versions(pathway_id, version, title, description, checksum, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [p.id, n, s.body.title.trim(), description, checksum, req.user.id])).rows[0];
      for (let i = 0; i < r.rows.length; i++) await c.query('INSERT INTO pathway_version_steps(pathway_version_id, position, element_set_id, element_set_version_id) VALUES ($1,$2,$3,$4)', [v.id, i + 1, r.rows[i].set_id, r.rows[i].set_version_id]);
      await audit(c, req, 'pathway.version_create', 'pathway', p.id, { slug: p.slug, version: n, steps: r.rows.length, checksum });
      return { status: 201, body: { pathway: await pathById(c, p.id), version: await withSteps(c, await versionRow(c, p.id, n)) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- publish (draft -> published; frozen from here on) ---------- */
  app.post('/api/pathways/:id/versions/:version/publish', A.requirePerm(pool, 'sets:publish'), async (req, res) => {
    const s = strict(req.body, []);
    if (s.error) return res.status(400).json(s.error);
    const id = idParam(req.params.id), n = idParam(req.params.version);
    if (!id || !n) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const p = await pathById(c, id, true);
      if (!p) return { status: 404, body: { error: 'not_found' } };
      const v = (await c.query('SELECT id, status, title, description, checksum FROM pathway_versions WHERE pathway_id = $1 AND version = $2 FOR UPDATE', [p.id, n])).rows[0];
      if (!v) return { status: 404, body: { error: 'not_found' } };
      if (v.status !== 'draft') return { status: 409, body: { error: 'not_publishable', message: `This version is ${v.status}; only a draft can be published.` } };
      const reject = async (reason, message) => {
        await audit(c, req, 'pathway.publish_rejected', 'pathway', p.id, { slug: p.slug, version: n, reason });
        return { status: 409, body: { error: reason, message } };
      };
      const steps = await stepsOf(c, v.id);
      if (checksumOf(contentOf(v.title, v.description, steps)) !== v.checksum) return reject('checksum_mismatch', 'The stored content no longer matches its checksum. It was not published.');
      const gone = steps.filter(x => x.set_status !== 'published');
      if (gone.length) return reject('member_not_published', 'These steps name a set version that is no longer published: ' + gone.map(x => `${x.set_slug} v${x.set_version}`).join(', ') + '. Make a new draft version with current set versions.');
      await c.query(`UPDATE pathway_versions SET status = 'published', published_by = $3, published_at = now() WHERE pathway_id = $1 AND version = $2`, [p.id, n, req.user.id]);
      await c.query(`UPDATE pathways SET title = $2, status = 'active', updated_at = now() WHERE id = $1`, [p.id, v.title]);
      await audit(c, req, 'pathway.publish', 'pathway', p.id, { slug: p.slug, version: n, checksum: v.checksum });
      return { status: 200, body: { pathway: await pathById(c, p.id), version: await withSteps(c, await versionRow(c, p.id, n)) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- apply a published pathway version to a case ---------- */
  app.post('/api/cases/:id/applied-pathways', A.requirePerm(pool, 'cases:write'), async (req, res) => {
    const s = strict(req.body, ['pathwayId', 'version']);
    if (s.error) return res.status(400).json(s.error);
    const pathwayId = posInt(s.body.pathwayId), version = posInt(s.body.version);
    if (!pathwayId || !version) return bad(res, 'pathwayId and version must be whole numbers.');
    const caseId = idParam(req.params.id);
    if (!caseId) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const cs = (await c.query('SELECT id, status FROM clinical_cases WHERE id = $1 FOR UPDATE', [caseId])).rows[0];
      if (!cs) return { status: 404, body: { error: 'not_found' } };
      if (cs.status === 'archived') return { status: 409, body: { error: 'case_archived', message: 'Restore the case before changing it.' } };
      const v = (await c.query('SELECT id, status, version, title FROM pathway_versions WHERE pathway_id = $1 AND version = $2', [pathwayId, version])).rows[0];
      if (!v) return { status: 404, body: { error: 'version_not_found' } };
      if (v.status !== 'published') return { status: 409, body: { error: 'not_published', message: 'Only a published version of a pathway can be applied to a case.' } };
      const steps = await stepsOf(c, v.id);
      const gone = steps.filter(x => x.set_status !== 'published');
      if (gone.length) return { status: 409, body: { error: 'member_not_published', message: 'These sets are no longer published, so the pathway cannot be applied: ' + gone.map(x => `${x.set_slug} v${x.set_version}`).join(', ') + '.' } };
      // A pathway never touches a pin the case already has (an update of a pin is an explicit action of its own); it reports it.
      const pins = (await c.query(`SELECT a.element_set_id, v.version FROM case_applied_sets a JOIN element_set_versions v ON v.id = a.element_set_version_id
                                    WHERE a.case_id = $1 AND a.state = 'active' AND a.element_set_id = ANY($2::int[]) FOR UPDATE OF a`, [cs.id, steps.map(x => x.set_id)])).rows;
      const have = new Map(pins.map(p => [p.element_set_id, p.version]));
      const todo = steps.filter(x => !have.has(x.set_id));
      const skipped = steps.filter(x => have.has(x.set_id)).map(x => ({ setId: x.set_id, slug: x.set_slug, reason: have.get(x.set_id) === x.set_version ? 'already_applied' : 'other_version_applied', appliedVersion: have.get(x.set_id), pathwayVersion: x.set_version }));
      if (!todo.length) return { status: 409, body: { error: 'nothing_to_apply', message: 'Every set of this pathway is already applied to the case.', skipped } };
      const ap = (await c.query('INSERT INTO case_applied_pathways(case_id, pathway_id, pathway_version_id, applied_by) VALUES ($1,$2,$3,$4) RETURNING id, applied_at', [cs.id, pathwayId, v.id, req.user.id])).rows[0];
      const ids = [];
      for (const st of todo) {
        const id = (await c.query('INSERT INTO case_applied_sets(case_id, element_set_id, element_set_version_id, applied_by, from_applied_pathway_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [cs.id, st.set_id, st.set_version_id, req.user.id, ap.id])).rows[0].id;
        ids.push(id);
        await event(c, cs.id, 'set_applied', req.user.id, { appliedSetId: id, setId: st.set_id, version: st.set_version, appliedPathwayId: ap.id });
      }
      await event(c, cs.id, 'pathway_applied', req.user.id, { appliedPathwayId: ap.id, pathwayId, version, appliedSetIds: ids, skippedSetIds: skipped.map(x => x.setId) });
      await c.query('UPDATE clinical_cases SET updated_at = now() WHERE id = $1', [cs.id]);
      await audit(c, req, 'case.pathway_apply', 'case', cs.id, { appliedPathwayId: ap.id, pathwayId, version, appliedSetIds: ids, skipped: skipped.length });
      const appliedSets = (await c.query(`SELECT ${APPLIED} ${APPLIED_FROM} WHERE a.id = ANY($1::int[]) ORDER BY a.id`, [ids])).rows;
      return { status: 201, body: { appliedPathway: { id: ap.id, pathway_id: pathwayId, version, title: v.title, applied_at: ap.applied_at }, appliedSets, skipped } };
    });
    res.status(out.status).json(out.body);
  });

  // The clinical timeline event (same rule as observations.js: the case's open linked encounter at that moment, or none).
  async function event(c, caseId, type, userId, detail) {
    const enc = (await c.query(`SELECT ce.encounter_id FROM case_encounters ce JOIN encounters e ON e.id = ce.encounter_id
                                 WHERE ce.case_id = $1 AND e.status = 'open' ORDER BY ce.id DESC LIMIT 1`, [caseId])).rows[0];
    await c.query('INSERT INTO clinical_events(case_id, encounter_id, event_type, actor_id, detail) VALUES ($1,$2,$3,$4,$5)',
      [caseId, enc ? enc.encounter_id : null, type, userId, JSON.stringify(detail)]);
  }
}

module.exports = { mountPathways, checkText, contentOf };
