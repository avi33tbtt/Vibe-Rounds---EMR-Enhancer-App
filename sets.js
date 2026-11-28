'use strict';
// Task B2a: versioned element sets (server). Routes are registered straight on the app (no nested router) so the safety tests see them.
// A set has a stable identity (slug) and versions. A version is a draft until published; a published version never changes
// (the database refuses it too, see migration 007). Every actor (created_by, published_by, retired_by) comes from the session;
// a body that names one is refused. Content is declarative data only: a fixed list of keys and types, plain text, no code.
const crypto = require('crypto');
const { tx } = require('./db');
const { audit } = require('./audit');
const A = require('./auth');
const { lint } = require('./lint');

const KINDS = ['disease', 'care', 'template', 'custom'];
const SCHEMA_VERSION = 1;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BYTES = 40000;        // canonical JSON of one definition (the request body limit is 50 kb)
const MAX_FIELDS = 200, MAX_OPTIONS = 100, MAX_BINDINGS = 20, MAX_PATH = 10;

/* ---------- canonical JSON + checksum (server-side only; a client-sent checksum is only compared, never trusted) ---------- */
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
const checksumOf = def => crypto.createHash('sha256').update(canonicalJson(def), 'utf8').digest('hex');

/* ---------- definition validation: whitelist of keys and types; plain text only ---------- */
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string';
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;   // NUL and lone surrogates (the JSON column cannot hold them)
const TOP_KEYS = { title: 'str:200', desc: 'str:2000', fields: 'fields', citation: 'str:500', sdc: 'sdc' };
const FIELD_KEYS = {
  id: 'id', label: 'str:200', type: 'str:20', unit: 'str:40', options: 'options', repeat: 'bool', required: 'bool', derived: 'bool',
  concept: 'key', flag: 'str:200', rationale: 'str:1000', citation: 'str:500', codingPolicy: 'policy', bindings: 'bindings',
  linkId: 'str:200', sdcType: 'str:40', text: 'str:500', path: 'path',
};
const SDC_KEYS = { url: 'str:500', version: 'str:100', publisher: 'str:200', modified: 'bool' };   // the original Questionnaire is not kept (rebuilt by sdc.js)
const BINDING_SOURCES = ['manual', 'llm', 'sdc'];

function validateDefinition(def, slug, kind) {
  const errors = [];
  const err = (path, message) => { if (errors.length < 20) errors.push({ path, message }); };
  if (!isObj(def)) return [{ path: '', message: 'definition must be an object.' }];

  // 1. every value anywhere: only text, true/false, lists and objects. No numbers, no null, no NUL or broken characters, bounded depth.
  const walk = (v, path, depth) => {
    if (depth > 8) return err(path, 'is nested too deeply.');
    if (isStr(v)) { if (BAD_CHARS.test(v)) err(path, 'contains characters that cannot be stored.'); }
    else if (typeof v === 'boolean') return;
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    else if (isObj(v)) for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k, depth + 1);
    else err(path, 'must be text, true/false, a list or an object (no numbers or null).');
  };
  walk(def, '', 0);
  if (errors.length) return errors;
  if (Buffer.byteLength(canonicalJson(def), 'utf8') > MAX_BYTES) return [{ path: '', message: `definition is larger than ${MAX_BYTES} bytes.` }];

  // 2. known keys only, with the right type and length
  const str = (v, max, path, required) => {
    if (!isStr(v) || (required && !v.trim())) return err(path, required ? 'is required text.' : 'must be text.');
    if (v.length > max) err(path, `must be at most ${max} characters.`);
  };
  const check = (kind_, v, path) => {
    const [t, n] = kind_.split(':');
    if (t === 'str') return str(v, +n, path);
    if (t === 'bool') return typeof v === 'boolean' || err(path, 'must be true or false.');
    if (t === 'key') { if (!isStr(v) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(v)) err(path, 'must be 1 to 64 lowercase letters, digits, . _ - (starting with a letter or digit).'); return; }
    if (t === 'id') { if (!isStr(v) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v)) err(path, 'must be 1 to 64 letters, digits, . _ - (starting with a letter or digit).'); return; }
    if (t === 'options') {
      if (!Array.isArray(v) || v.length > MAX_OPTIONS) return err(path, `must be a list of at most ${MAX_OPTIONS} options.`);
      return v.forEach((o, i) => str(o, 200, `${path}[${i}]`, true));
    }
    if (t === 'policy') {
      if (!isObj(v)) return err(path, 'must be an object.');
      for (const k of Object.keys(v)) if (!['mode', 'systems'].includes(k)) err(`${path}.${k}`, 'is not allowed here.');
      if (v.systems !== undefined) { if (!Array.isArray(v.systems) || v.systems.length > 20) err(`${path}.systems`, 'must be a list of at most 20 system keys.'); else v.systems.forEach((s, i) => str(s, 80, `${path}.systems[${i}]`, true)); }
      return;
    }
    if (t === 'bindings') {
      if (!Array.isArray(v) || v.length > MAX_BINDINGS) return err(path, `must be a list of at most ${MAX_BINDINGS} bindings.`);
      return v.forEach((b, i) => {
        const p = `${path}[${i}]`;
        if (!isObj(b)) return err(p, 'must be an object.');
        for (const k of Object.keys(b)) if (!['system', 'code', 'display', 'source', 'version'].includes(k)) err(`${p}.${k}`, 'is not allowed here.');
        str(b.system, 80, `${p}.system`, true); str(b.code, 100, `${p}.code`, true);
        if (b.display !== undefined) str(b.display, 300, `${p}.display`);
        if (b.version !== undefined && !(isStr(b.version) && /^[1-9]\d{0,8}$/.test(b.version))) err(`${p}.version`, 'must be the term version as digits in text, for example "2" (stored sets hold no numbers).');
        if (b.source !== undefined && !BINDING_SOURCES.includes(b.source)) err(`${p}.source`, 'must be one of: ' + BINDING_SOURCES.join(', ') + '.');
      });
    }
    if (t === 'path') {
      if (!Array.isArray(v) || v.length > MAX_PATH) return err(path, `must be a list of at most ${MAX_PATH} groups.`);
      return v.forEach((g, i) => {
        const p = `${path}[${i}]`;
        if (!isObj(g)) return err(p, 'must be an object.');
        for (const k of Object.keys(g)) if (!['linkId', 'text'].includes(k)) err(`${p}.${k}`, 'is not allowed here.');
        str(g.linkId, 200, `${p}.linkId`); if (g.text !== undefined) str(g.text, 500, `${p}.text`);
      });
    }
  };
  for (const k of Object.keys(def)) {
    if (!(k in TOP_KEYS)) { err(k, 'is not an allowed key (allowed: ' + Object.keys(TOP_KEYS).join(', ') + ').'); continue; }
    if (TOP_KEYS[k] === 'fields') {
      if (!Array.isArray(def.fields) || !def.fields.length || def.fields.length > MAX_FIELDS) { err('fields', `must be a list of 1 to ${MAX_FIELDS} fields.`); continue; }
      def.fields.forEach((f, i) => {
        if (!isObj(f)) return err(`fields[${i}]`, 'must be an object.');
        for (const fk of Object.keys(f)) fk in FIELD_KEYS ? check(FIELD_KEYS[fk], f[fk], `fields[${i}].${fk}`) : err(`fields[${i}].${fk}`, 'is not an allowed field key.');
      });
    } else if (TOP_KEYS[k] === 'sdc') {
      if (!isObj(def.sdc)) { err('sdc', 'must be an object.'); continue; }
      for (const sk of Object.keys(def.sdc)) sk in SDC_KEYS ? check(SDC_KEYS[sk], def.sdc[sk], `sdc.${sk}`) : err(`sdc.${sk}`, 'is not allowed (the original Questionnaire is not stored).');
    } else check(TOP_KEYS[k], def[k], k);
  }
  if (def.title === undefined || (isStr(def.title) && !def.title.trim())) err('title', 'is required text.');
  if (errors.length) return errors;

  // 3. the shared lint rules that make a set "declarative data": schema and executable-looking text.
  // (Doses without a citation, unverified codes and patient-like text are the submit-for-review gate in 8b, not this one.)
  const res = lint({ id: slug, kind: kind === 'custom' ? 'template' : kind, ...def }, { scrub: false });
  for (const f of res.findings) if (f.severity === 'error' && (f.rule === 'schema' || f.rule === 'executable') && !['id', 'kind'].includes(f.path)) err(f.path, f.message);
  return errors;
}

const bad = (res, message, extra = {}) => res.status(400).json({ error: 'invalid', message, ...extra });
// Only these body keys are accepted per route. Anything else (createdBy, publishedBy, status ...) is refused, not ignored.
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  return extra.length ? { error: { error: 'unknown_field', message: 'These fields cannot be set: ' + extra.slice(0, 10).join(', '), fields: extra.slice(0, 10) } } : { body: b };
}
const parseVersion = v => (/^\d{1,9}$/.test(v) && +v >= 1 ? +v : null);
const invalidDef = (res, errors) => res.status(400).json({ error: 'invalid_definition', message: 'The definition is not valid declarative data: ' + errors.slice(0, 3).map(e => (e.path ? e.path + ' ' : '') + e.message).join(' '), errors });
const checksumMismatch = res => res.status(400).json({ error: 'checksum_mismatch', message: 'The checksum you sent does not match the content. The server computes it; reload and try again.' });
const asChecksum = v => (v === undefined ? { ok: true } : (isStr(v) && /^[0-9a-f]{64}$/.test(v) ? { ok: true, value: v } : { ok: false }));

const SET_COLS = `s.id, s.slug, s.title, s.kind, s.status, s.created_at, s.updated_at`;
const VERSION_COLS = `v.version, v.status, v.schema_version, v.checksum, v.created_at, v.published_at, v.retired_at,
  cu.username AS created_by, pu.username AS published_by, ru.username AS retired_by`;
const VERSION_JOINS = `JOIN users cu ON cu.id = v.created_by LEFT JOIN users pu ON pu.id = v.published_by LEFT JOIN users ru ON ru.id = v.retired_by`;

function mountSets(app, pool) {
  const setById = async (c, id, lock) => (await c.query(`SELECT ${SET_COLS} FROM element_sets s WHERE s.id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  const versionRow = async (c, setId, n) => (await c.query(`SELECT ${VERSION_COLS} FROM element_set_versions v ${VERSION_JOINS} WHERE v.element_set_id = $1 AND v.version = $2`, [setId, n])).rows[0];

  /* ---------- create a set (and its first draft version) ---------- */
  app.post('/api/element-sets', A.requirePerm(pool, 'sets:write'), async (req, res) => {
    const s = strict(req.body, ['slug', 'kind', 'definition', 'checksum']);
    if (s.error) return res.status(400).json(s.error);
    const { slug, kind, definition } = s.body;
    if (!isStr(slug) || !SLUG_RE.test(slug)) return bad(res, 'slug must be 1 to 64 characters: lowercase letters, digits, _ and -, starting with a letter or digit.');
    if (!KINDS.includes(kind)) return bad(res, 'kind must be one of: ' + KINDS.join(', '));
    const errors = validateDefinition(definition, slug, kind);
    if (errors.length) return invalidDef(res, errors);
    const cs = asChecksum(s.body.checksum);
    if (!cs.ok) return bad(res, 'checksum must be 64 hex characters (or leave it out).');
    const checksum = checksumOf(definition);
    if (cs.value && cs.value !== checksum) return checksumMismatch(res);
    try {
      const out = await tx(pool, async c => {
        const set = (await c.query('INSERT INTO element_sets(slug, title, kind, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [slug, definition.title.trim(), kind, req.user.id])).rows[0];
        await c.query(`INSERT INTO element_set_versions(element_set_id, version, schema_version, definition_json, checksum, created_by) VALUES ($1,1,$2,$3,$4,$5)`,
          [set.id, SCHEMA_VERSION, JSON.stringify(definition), checksum, req.user.id]);
        await audit(c, req, 'set.create', 'element_set', set.id, { slug, kind, version: 1, checksum });
        return { status: 201, body: { set: await setById(c, set.id), version: await versionRow(c, set.id, 1) } };
      });
      res.status(out.status).json(out.body);
    } catch (e) {
      if (e.code === '23505' && e.constraint === 'element_sets_slug_key') {
        await audit(pool, req, 'set.create_rejected', 'element_set', null, { reason: 'slug_taken', slug });
        return res.status(409).json({ error: 'slug_taken', message: 'A set with that slug already exists. Slugs are never reused; add a new version to the existing set.' });
      }
      throw e;
    }
  });

  /* ---------- list + read ---------- */
  app.get('/api/element-sets', A.requirePerm(pool, 'sets:read'), async (req, res) => {
    const kind = req.query.kind;
    if (kind !== undefined && !KINDS.includes(kind)) return bad(res, 'kind must be one of: ' + KINDS.join(', '));
    const { rows } = await pool.query(
      `SELECT ${SET_COLS},
              (SELECT max(version) FROM element_set_versions v WHERE v.element_set_id = s.id) AS latest_version,
              (SELECT max(version) FROM element_set_versions v WHERE v.element_set_id = s.id AND v.status = 'published') AS published_version
         FROM element_sets s ${kind ? 'WHERE s.kind = $1' : ''} ORDER BY s.slug LIMIT 500`, kind ? [kind] : []);
    res.json({ sets: rows });
  });

  app.get('/api/element-sets/:id', A.requirePerm(pool, 'sets:read'), async (req, res) => {
    const set = await setById(pool, req.params.id);
    if (!set) return res.status(404).json({ error: 'not_found' });
    const versions = (await pool.query(`SELECT ${VERSION_COLS} FROM element_set_versions v ${VERSION_JOINS} WHERE v.element_set_id = $1 ORDER BY v.version DESC`, [set.id])).rows;
    res.json({ set, versions });
  });

  app.get('/api/element-sets/:id/versions/:version', A.requirePerm(pool, 'sets:read'), async (req, res) => {
    const n = parseVersion(req.params.version);
    const set = n && await setById(pool, req.params.id);
    if (!set) return res.status(404).json({ error: 'not_found' });
    const v = (await pool.query(`SELECT ${VERSION_COLS}, v.definition_json AS definition FROM element_set_versions v ${VERSION_JOINS} WHERE v.element_set_id = $1 AND v.version = $2`, [set.id, n])).rows[0];
    if (!v) return res.status(404).json({ error: 'not_found' });
    res.json({ set, version: v });
  });

  /* ---------- new draft version (the number is chosen by the server) ---------- */
  app.post('/api/element-sets/:id/versions', A.requirePerm(pool, 'sets:write'), async (req, res) => {
    const s = strict(req.body, ['definition', 'checksum']);
    if (s.error) return res.status(400).json(s.error);
    const cs = asChecksum(s.body.checksum);
    if (!cs.ok) return bad(res, 'checksum must be 64 hex characters (or leave it out).');
    const out = await tx(pool, async c => {
      const set = await setById(c, req.params.id, true);   // the set row is the lock that serialises version numbers
      if (!set) return { status: 404, body: { error: 'not_found' } };
      const errors = validateDefinition(s.body.definition, set.slug, set.kind);
      if (errors.length) return { status: 400, body: { error: 'invalid_definition', message: 'The definition is not valid declarative data: ' + errors.slice(0, 3).map(e => (e.path ? e.path + ' ' : '') + e.message).join(' '), errors } };
      const checksum = checksumOf(s.body.definition);
      if (cs.value && cs.value !== checksum) return { status: 400, body: { error: 'checksum_mismatch', message: 'The checksum you sent does not match the content. The server computes it; reload and try again.' } };
      const n = (await c.query('SELECT COALESCE(max(version), 0) + 1 AS n FROM element_set_versions WHERE element_set_id = $1', [set.id])).rows[0].n;
      await c.query(`INSERT INTO element_set_versions(element_set_id, version, schema_version, definition_json, checksum, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [set.id, n, SCHEMA_VERSION, JSON.stringify(s.body.definition), checksum, req.user.id]);
      if (set.status === 'retired') await c.query(`UPDATE element_sets SET status = 'active', updated_at = now() WHERE id = $1`, [set.id]);
      await audit(c, req, 'set.version_create', 'element_set', set.id, { slug: set.slug, version: n, checksum });
      return { status: 201, body: { set: await setById(c, set.id), version: await versionRow(c, set.id, n) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- publish (reviewed -> published; the version is frozen from here on) ---------- */
  app.post('/api/element-sets/:id/versions/:version/publish', A.requirePerm(pool, 'sets:publish'), async (req, res) => {
    const s = strict(req.body, ['checksum']);
    if (s.error) return res.status(400).json(s.error);
    const cs = asChecksum(s.body.checksum);
    if (!cs.ok) return bad(res, 'checksum must be 64 hex characters (or leave it out).');
    const n = parseVersion(req.params.version);
    if (!n) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const set = await setById(c, req.params.id, true);
      if (!set) return { status: 404, body: { error: 'not_found' } };
      const v = (await c.query('SELECT status, checksum, definition_json FROM element_set_versions WHERE element_set_id = $1 AND version = $2 FOR UPDATE', [set.id, n])).rows[0];
      if (!v) return { status: 404, body: { error: 'not_found' } };
      // 8c-2: only an approved version is published. The database refuses anything else too (migration 010).
      if (['draft', 'in_review'].includes(v.status)) {
        await audit(c, req, 'set.publish_rejected', 'element_set', set.id, { slug: set.slug, version: n, reason: 'not_reviewed', status: v.status });
        return { status: 409, body: { error: 'not_reviewed', message: `This version is ${v.status === 'draft' ? 'a draft' : 'still in review'}; only a version approved by a reviewer can be published.` } };
      }
      if (v.status !== 'reviewed') return { status: 409, body: { error: 'not_publishable', message: `This version is ${v.status}; only an approved version can be published.` } };
      // What is published is exactly what was stored: recompute from the stored content, and compare with what the publisher saw.
      const reject = async (reason, message) => {
        await audit(c, req, 'set.publish_rejected', 'element_set', set.id, { slug: set.slug, version: n, reason });
        return { status: 409, body: { error: reason, message } };
      };
      if (checksumOf(v.definition_json) !== v.checksum) return reject('checksum_mismatch', 'The stored content no longer matches its checksum. It was not published.');
      if (cs.value && cs.value !== v.checksum) return reject('checksum_mismatch', 'The checksum you sent is not the checksum of this version. Reload it and check what you are publishing.');
      const errors = validateDefinition(v.definition_json, set.slug, set.kind);
      if (errors.length) return reject('invalid_definition', 'The stored content is not valid declarative data. It was not published.');
      await c.query(`UPDATE element_set_versions SET status = 'published', published_by = $3, published_at = now() WHERE element_set_id = $1 AND version = $2`, [set.id, n, req.user.id]);
      await c.query(`UPDATE element_sets SET title = $2, status = 'active', updated_at = now() WHERE id = $1`, [set.id, v.definition_json.title.trim()]);
      await audit(c, req, 'set.publish', 'element_set', set.id, { slug: set.slug, version: n, checksum: v.checksum });
      return { status: 200, body: { set: await setById(c, set.id), version: await versionRow(c, set.id, n) } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- retire (published -> retired; cases that pinned it keep reading it) ---------- */
  app.post('/api/element-sets/:id/versions/:version/retire', A.requirePerm(pool, 'sets:publish'), async (req, res) => {
    const s = strict(req.body, []);
    if (s.error) return res.status(400).json(s.error);
    const n = parseVersion(req.params.version);
    if (!n) return res.status(404).json({ error: 'not_found' });
    const out = await tx(pool, async c => {
      const set = await setById(c, req.params.id, true);
      if (!set) return { status: 404, body: { error: 'not_found' } };
      const v = (await c.query('SELECT status FROM element_set_versions WHERE element_set_id = $1 AND version = $2 FOR UPDATE', [set.id, n])).rows[0];
      if (!v) return { status: 404, body: { error: 'not_found' } };
      if (v.status !== 'published') return { status: 409, body: { error: 'not_published', message: `This version is ${v.status}; only a published version can be retired.` } };
      await c.query(`UPDATE element_set_versions SET status = 'retired', retired_by = $3, retired_at = now() WHERE element_set_id = $1 AND version = $2`, [set.id, n, req.user.id]);
      const live = (await c.query(`SELECT 1 FROM element_set_versions WHERE element_set_id = $1 AND status <> 'retired' LIMIT 1`, [set.id])).rowCount;
      if (!live) await c.query(`UPDATE element_sets SET status = 'retired', updated_at = now() WHERE id = $1`, [set.id]);
      await audit(c, req, 'set.retire', 'element_set', set.id, { slug: set.slug, version: n, setRetired: !live });
      return { status: 200, body: { set: await setById(c, set.id), version: await versionRow(c, set.id, n) } };
    });
    res.status(out.status).json(out.body);
  });
}

module.exports = { mountSets, canonicalJson, checksumOf, validateDefinition, KINDS, SCHEMA_VERSION };
