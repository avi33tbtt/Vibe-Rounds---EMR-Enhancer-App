'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { tx } = require('./db');
const { audit } = require('./audit');
const { permsFor } = require('./permissions');
const A = require('./auth');
const { mountAi } = require('./ai');
const { mountCases } = require('./cases');
const { mountSets } = require('./sets');
const { mountReview } = require('./review');
const { mountObservations } = require('./observations');
const { mountNotes } = require('./notes');
const { mountPathways } = require('./pathways');
const { mountContext } = require('./context');
const { mountCcisRuns, isRunImportPath } = require('./ccis-runs');
const { createLimiter } = require('./ratelimit');

const PATIENT_SELECT = `
  SELECT p.id, p.mrn, p.name, p.dob, p.sex, p.archived, p.created_at,
         date_part('year', age(p.dob))::int AS age,
         e.id AS open_encounter_id, e.bed AS open_bed, e.opened_at AS open_since
    FROM patients p
    LEFT JOIN encounters e ON e.patient_id = p.id AND e.status = 'open'`;

const like = s => '%' + String(s).replace(/[\\%_]/g, m => '\\' + m) + '%';
const bad = (res, error, message) => res.status(400).json({ error, message });

function validatePatient(b) {
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const mrn = String(b.mrn || '').trim();
  const dob = String(b.dob || '').trim();
  const sex = String(b.sex || '').trim().toUpperCase();
  if (!name || name.length > 200) return { error: 'Name is required (max 200 characters).' };
  if (!/^[A-Za-z0-9._\/-]{1,40}$/.test(mrn)) return { error: 'MRN is required: letters, digits, . _ - / only (max 40).' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(Date.parse(dob + 'T00:00:00Z')) ||
      new Date(dob + 'T00:00:00Z').toISOString().slice(0, 10) !== dob) return { error: 'Date of birth must be a real date (YYYY-MM-DD).' };
  if (dob > new Date().toISOString().slice(0, 10)) return { error: 'Date of birth cannot be in the future.' };
  if (dob < '1880-01-01') return { error: 'Date of birth is not plausible.' };
  if (!['M', 'F', 'O', 'U'].includes(sex)) return { error: 'Sex must be M, F, O or U.' };
  return { value: { name, mrn, dob, sex } };
}

const envOn = v => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
// TRUST_PROXY = number of reverse proxies in front (1 for one proxy). Never "true": that would let a client spoof its IP.
const proxyHops = v => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n > 0 ? n : false; };
// Defaults are per process (see ratelimit.js). Login counts FAILED attempts only; writes are per session.
const DEFAULT_LIMITS = {
  loginIp: { max: 20, windowMs: 10 * 60 * 1000 },
  loginUser: { max: 5, windowMs: 10 * 60 * 1000 },
  write: { max: 120, windowMs: 60 * 1000 },
};

// Content-Security-Policy (chunk 06d-1). The nonce is new for every response and is injected into the page's <script> tags.
// script-src-attr is 'none': the page has no inline on*="" handlers (6d-2c); actions run through the delegated listener.
// style-src keeps 'unsafe-inline' (one <style> block and inline style="" attributes); it is not about script execution.
const DEFAULT_TX_HOST = 'https://tx.fhir.org';
function txOrigin(v) {
  try { const u = new URL(String(v || DEFAULT_TX_HOST)); return /^https?:$/.test(u.protocol) ? u.origin : new URL(DEFAULT_TX_HOST).origin; }
  catch (_) { return DEFAULT_TX_HOST; }
}
function cspHeader(nonce, tx) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    `connect-src 'self' ${tx}`,
  ].join('; ');
}

function createApp(pool, opts = {}) {
  const app = express();
  const https = opts.https ?? envOn(process.env.HTTPS);
  const LIM = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([k, v]) => [k, { ...v, ...(opts.limits || {})[k] }]));
  const lim = Object.fromEntries(Object.entries(LIM).map(([k, v]) => [k, createLimiter(v)]));
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? proxyHops(process.env.TRUST_PROXY));
  const txConnect = txOrigin(opts.txHost ?? process.env.TX_HOST);
  const json50 = express.json({ limit: '50kb' });
  app.use((req, res, next) => (req.method === 'POST' && isRunImportPath(req.path) ? next() : json50(req, res, next)));   // run-record import has its own, larger limit (ccis-runs.js)
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', cspHeader(res.locals.cspNonce, txConnect));
    res.set({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    });
    if (https) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(A.csrfGuard);
  app.use(A.sessionLoader(pool));

  // Refuse with 429 and write ONE audit row per key per window (a flood cannot fill the audit log).
  async function refuse(req, res, r, scope, detail = {}) {
    res.set('Retry-After', String(r.retryAfter));
    if (r.first) await audit(pool, req, 'rate_limited', 'rate_limit', null, { scope, method: req.method, path: req.baseUrl + req.path, ...detail });
    res.status(429).json({ error: 'rate_limited', message: `Too many ${scope === 'write' ? 'requests' : 'sign-in attempts'}. Try again in ${r.retryAfter} seconds.` });
  }
  // Write routes: per session. Reads are not limited here.
  app.use('/api', async (req, res, next) => {
    try {
      if (!req.user || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      const r = lim.write.hit(req.sessionHash);
      return r.ok ? next() : await refuse(req, res, r, 'write', { limit: LIM.write.max, windowMs: LIM.write.windowMs });
    } catch (e) { next(e); }
  });

  app.param('id', (_req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : res.status(404).json({ error: 'not_found' })));

  const html = path.join(__dirname, 'emr-enhancer.html');
  // The page is served with this response's nonce on every <script> tag (read per request; the file is small).
  app.get(['/', '/emr-enhancer.html'], (_req, res, next) => {
    fs.readFile(html, 'utf8', (err, src) => {
      if (err) return next(err);
      res.type('html').send(src.replace(/<script(?=[\s>])/g, `<script nonce="${res.locals.cspNonce}"`));
    });
  });
  const sdc = path.join(__dirname, 'sdc.js');   // the one shared copy of the SDC code
  app.get('/sdc.js', (_req, res) => res.sendFile(sdc));
  // R0a: page modules (classic scripts, same origin). Only plain file names in modules/ are served.
  const modulesDir = path.join(__dirname, 'modules');
  app.get('/modules/:file', (req, res) => {
    const notFound = () => { if (!res.headersSent) res.status(404).json({ error: 'not_found' }); };
    if (!/^[a-z0-9][a-z0-9-]*\.js$/.test(req.params.file)) return notFound();
    res.sendFile(path.join(modulesDir, req.params.file), err => { if (err) notFound(); });
  });

  /* ---------- session ---------- */
  app.post('/api/login', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const ukey = username.slice(0, 60);
    const byIp = lim.loginIp.blocked(req.ip);
    if (byIp) return refuse(req, res, byIp, 'login_ip', { username: ukey });
    const byUser = lim.loginUser.blocked(ukey);
    if (byUser) return refuse(req, res, byUser, 'login_username', { username: ukey });
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND active', [username]);
    const u = rows[0];
    // Always run a hash check so timing does not reveal whether the user exists.
    const ok = A.checkPassword(password, u ? u.password_hash : 'scrypt$00$00') && !!u;
    if (!ok) {
      lim.loginIp.hit(req.ip); lim.loginUser.hit(ukey);
      await audit(pool, req, 'login.failed', 'user', null, { username: username.slice(0, 60) });
      return res.status(401).json({ error: 'bad_credentials' });
    }
    lim.loginUser.reset(ukey);
    const token = await A.createSession(pool, u.id);
    req.user = { id: u.id, username: u.username, role: u.role };
    await audit(pool, req, 'login', 'user', u.id);
    res.set('Set-Cookie', A.cookieHeader(token, A.SESSION_HOURS * 3600, https));
    res.json({ user: { username: u.username, displayName: u.display_name, role: u.role, perms: permsFor(u.role) } });
  });

  app.post('/api/logout', A.requireLogin, async (req, res) => {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionHash]);
    await audit(pool, req, 'logout', 'user', req.user.id);
    res.set('Set-Cookie', A.cookieHeader('', 0, https));
    res.json({ ok: true });
  });

  app.get('/api/me', A.requireLogin, (req, res) =>
    res.json({ user: { username: req.user.username, displayName: req.user.display_name, role: req.user.role, perms: permsFor(req.user.role) } }));

  /* ---------- patients ---------- */
  app.get('/api/patients', A.requirePerm(pool, 'patients:read'), async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    const args = []; const where = [];
    if (!includeArchived) where.push('NOT p.archived');
    if (q) { args.push(like(q)); where.push(`(p.name ILIKE $${args.length} OR p.mrn ILIKE $${args.length})`); }
    const { rows } = await pool.query(`${PATIENT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name, p.id LIMIT 200`, args);
    await audit(pool, req, 'patient.search', 'patient', null, { hasQuery: !!q, includeArchived, count: rows.length });
    res.json({ patients: rows });
  });

  app.get('/api/patients/:id', A.requirePerm(pool, 'patients:read'), async (req, res) => {
    const { rows } = await pool.query(`${PATIENT_SELECT} WHERE p.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(pool, req, 'patient.view', 'patient', rows[0].id);
    res.json({ patient: rows[0] });
  });

  app.post('/api/patients', A.requirePerm(pool, 'patients:register'), async (req, res) => {
    const v = validatePatient(req.body || {});
    if (v.error) return bad(res, 'invalid', v.error);
    const { name, mrn, dob, sex } = v.value;
    const confirm = req.body.confirmDuplicate === true;
    // createdBy is never read from the body: it comes from the session.
    let out;
    try {
    out = await tx(pool, async c => {
      const mrnHit = await c.query('SELECT id FROM patients WHERE lower(mrn) = lower($1)', [mrn]);
      if (mrnHit.rows[0]) {
        await audit(c, req, 'patient.register_rejected', 'patient', null, { reason: 'mrn_taken' });
        return { status: 409, body: { error: 'mrn_taken', message: 'That MRN is already registered.' } };
      }
      const dupes = (await c.query(
        `${PATIENT_SELECT} WHERE lower(btrim(p.name)) = lower($1) AND p.dob = $2 ORDER BY p.id`, [name, dob])).rows;
      if (dupes.length && !confirm) {
        await audit(c, req, 'patient.duplicate_warning', 'patient', null, { matches: dupes.map(d => d.id) });
        return { status: 409, body: { error: 'possible_duplicate', message: 'A patient with the same name and date of birth already exists.', duplicates: dupes } };
      }
      const ins = await c.query(
        'INSERT INTO patients(mrn, name, dob, sex, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [mrn, name, dob, sex, req.user.id]);
      const id = ins.rows[0].id;
      await audit(c, req, 'patient.register', 'patient', id, dupes.length ? { duplicateWarningOverridden: true, matches: dupes.map(d => d.id) } : {});
      return { status: 201, body: { patient: (await c.query(`${PATIENT_SELECT} WHERE p.id = $1`, [id])).rows[0] } };
    });
    } catch (e) {
      // Two people registering the same MRN at the same moment: the second one loses the race at the unique index.
      if (e.code === '23505' && e.constraint === 'patients_mrn_uq') {
        await audit(pool, req, 'patient.register_rejected', 'patient', null, { reason: 'mrn_taken' });
        out = { status: 409, body: { error: 'mrn_taken', message: 'That MRN is already registered.' } };
      } else throw e;
    }
    res.status(out.status).json(out.body);
  });

  app.patch('/api/patients/:id/archive', A.requirePerm(pool, 'patients:archive'), async (req, res) => {
    if (typeof req.body.archived !== 'boolean') return bad(res, 'invalid', 'archived must be true or false.');
    const archived = req.body.archived;
    const out = await tx(pool, async c => {
      const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!p) return { status: 404, body: { error: 'not_found' } };
      if (archived) {
        const open = (await c.query(`SELECT 1 FROM encounters WHERE patient_id = $1 AND status = 'open'`, [p.id])).rowCount;
        if (open) return { status: 409, body: { error: 'open_encounter', message: 'Close the open encounter before archiving this patient.' } };
      }
      await c.query(
        `UPDATE patients SET archived = $2, archived_at = CASE WHEN $2 THEN now() END, archived_by = CASE WHEN $2 THEN $3::int END WHERE id = $1`,
        [p.id, archived, req.user.id]);
      await audit(c, req, archived ? 'patient.archive' : 'patient.restore', 'patient', p.id);
      return { status: 200, body: { patient: (await c.query(`${PATIENT_SELECT} WHERE p.id = $1`, [p.id])).rows[0] } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- encounters ---------- */
  app.get('/api/patients/:id/encounters', A.requirePerm(pool, 'patients:read'), async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, patient_id, bed, status, opened_at, closed_at FROM encounters WHERE patient_id = $1 ORDER BY id DESC`, [req.params.id]);
    res.json({ encounters: rows });
  });

  app.post('/api/patients/:id/encounters', A.requirePerm(pool, 'encounters:write'), async (req, res) => {
    const bed = String(req.body.bed || '').trim().replace(/\s+/g, ' ');
    if (!bed || bed.length > 30) return bad(res, 'invalid', 'Bed is required (max 30 characters).');
    try {
      const out = await tx(pool, async c => {
        const p = (await c.query('SELECT id, archived FROM patients WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
        if (!p) return { status: 404, body: { error: 'not_found' } };
        if (p.archived) return { status: 409, body: { error: 'patient_archived', message: 'Restore the patient before opening an encounter.' } };
        const ins = await c.query('INSERT INTO encounters(patient_id, bed, opened_by) VALUES ($1,$2,$3) RETURNING id, patient_id, bed, status, opened_at',
          [p.id, bed, req.user.id]);
        await audit(c, req, 'encounter.open', 'encounter', ins.rows[0].id, { patientId: p.id, bed });
        return { status: 201, body: { encounter: ins.rows[0] } };
      });
      res.status(out.status).json(out.body);
    } catch (e) {
      if (e.code === '23505' && e.constraint === 'encounters_open_bed_uq') {
        await audit(pool, req, 'encounter.open_rejected', 'patient', req.params.id, { reason: 'bed_occupied', bed });
        return res.status(409).json({ error: 'bed_occupied', message: `Bed ${bed} already has an open encounter.` });
      }
      if (e.code === '23505' && e.constraint === 'encounters_open_patient_uq') {
        await audit(pool, req, 'encounter.open_rejected', 'patient', req.params.id, { reason: 'patient_has_open_encounter', bed });
        return res.status(409).json({ error: 'patient_has_open_encounter', message: 'This patient already has an open encounter.' });
      }
      throw e;
    }
  });

  app.post('/api/encounters/:id/close', A.requirePerm(pool, 'encounters:write'), async (req, res) => {
    const out = await tx(pool, async c => {
      const e = (await c.query('SELECT id, patient_id, bed, status FROM encounters WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!e) return { status: 404, body: { error: 'not_found' } };
      if (e.status === 'closed') return { status: 409, body: { error: 'already_closed', message: 'This encounter is already closed.' } };
      const r = await c.query(`UPDATE encounters SET status = 'closed', closed_by = $2, closed_at = now() WHERE id = $1
                               RETURNING id, patient_id, bed, status, opened_at, closed_at`, [e.id, req.user.id]);
      await audit(c, req, 'encounter.close', 'encounter', e.id, { patientId: e.patient_id, bed: e.bed });
      return { status: 200, body: { encounter: r.rows[0] } };
    });
    res.status(out.status).json(out.body);
  });

  /* ---------- cases (task B1a) ---------- */
  mountCases(app, pool);

  /* ---------- element sets (task B2a) ---------- */
  mountSets(app, pool);

  /* ---------- submit for review (task 8b) ---------- */
  mountReview(app, pool);

  /* ---------- applied sets, observations, clinical timeline (task B3a) ---------- */
  mountObservations(app, pool);

  /* ---------- notes and signing (task B3c-1) ---------- */
  mountNotes(app, pool);

  /* ---------- pathways and applying them (task B4a) ---------- */
  mountPathways(app, pool);

  /* ---------- context envelope for CCIS (task B5) ---------- */
  mountContext(app, pool, opts);

  /* ---------- CCIS run records: import and acknowledge (task DM2a) ---------- */
  mountCcisRuns(app, pool, opts);

  /* ---------- audit (read-only) ---------- */
  app.get('/api/audit', A.requirePerm(pool, 'audit:read'), async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const { rows } = await pool.query('SELECT id, at, username, role, action, entity_type, entity_id, detail FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
    res.json({ entries: rows });
  });

  /* ---------- AI (chunk 04b): off by default, key only in the server environment ---------- */
  mountAi(app, pool, opts);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
    if (!opts.quiet) console.error(err);
    res.status(500).json({ error: 'server_error' });
  });
  return app;
}

module.exports = { createApp };
