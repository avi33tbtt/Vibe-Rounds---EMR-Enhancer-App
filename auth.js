'use strict';
/**
 * Authentication (chunk 32a): scrypt password hashes, server-side sessions, lockout, requireAuth.
 * Chunk 32c adds CSRF: token = HMAC-SHA256(SESSION_SECRET, session id), fetched with GET /api/csrf and required in the X-CSRF-Token header on every
 * POST, PUT, PATCH and DELETE under /api except login and logout. Without SESSION_SECRET a random per-process secret is used (development only; production refuses to start).
 * - Passwords: node:crypto scrypt (memory-hard, no native module to install). The parameters are stored in the hash string, so they can be raised later.
 * - Session: random 256-bit token in an httpOnly SameSite=Lax cookie (Secure in production). Only sha256(token) is stored.
 *   Idle timeout (last_seen) and absolute timeout (expires_at) are both checked with the database clock.
 * - Lockout: LOCKOUT_FAILURES wrong passwords lock that account for LOCKOUT_MINUTES (no password check while locked). A per-IP failure limiter
 *   also covers usernames that do not exist. Wrong user and wrong password give the same answer.
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { z } = require('zod');
const express = require('express');
const { allowedActions } = require('./permissions.js');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'emr_sid';
const SCRYPT = { N: 32768, r: 8, p: 1 };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return false;
  const N = +p[1], r = +p[2], pp = +p[3];
  if (![N, r, pp].every(Number.isInteger) || N < 1024 || N > 2 ** 20 || r < 1 || r > 32 || pp < 1 || pp > 16) return false;
  const want = Buffer.from(p[5], 'base64');
  const got = await scrypt(pw, Buffer.from(p[4], 'base64'), want.length, { N, r, p: pp, maxmem: 128 * N * r * 2 });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const passwordProblem = (pw) => (typeof pw !== 'string' ? 'Password required' : pw.length < 12 ? 'Use at least 12 characters' : pw.length > 200 ? 'Password too long (200 characters at most)' : null);

let dummy; const dummyHash = () => (dummy = dummy || hashPassword('not-a-real-password-for-timing'));   // unknown user costs the same time as a real one

function parseCookies(h) {
  const o = {}; String(h || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = c.slice(i + 1).trim(); }); return o;
}
const fail = (res, status, code, message, headers) => { if (headers) res.set(headers); res.status(status).json({ error: { code, message } }); };
const loginBody = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }).strict();

function createAuth({ db, idleMinutes, absoluteHours, lockoutFailures, lockoutMinutes, maxIpFailures, secure } = {}) {
  const env = process.env, num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
  const IDLE_MIN = num(idleMinutes ?? env.SESSION_IDLE_MINUTES, 30), ABS_H = num(absoluteHours ?? env.SESSION_ABSOLUTE_HOURS, 12);
  const LOCK_N = num(lockoutFailures, 5), LOCK_MIN = num(lockoutMinutes, 15), IP_MAX = num(maxIpFailures, 20), IP_WINDOW = 10 * 60 * 1000;
  const isSecure = secure !== undefined ? !!secure : env.NODE_ENV === 'production';
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: isSecure, path: '/' };
  const secret = env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 16 ? String(env.SESSION_SECRET) : null;
  if (!secret && env.NODE_ENV === 'production') throw new Error('SESSION_SECRET (16+ characters) is required when NODE_ENV=production');
  const key = secret || crypto.randomBytes(32).toString('hex');
  const csrfToken = (sessionId) => crypto.createHmac('sha256', key).update('csrf|' + sessionId).digest('hex');
  const ipFails = new Map();
  const ipBlocked = (ip) => { const e = ipFails.get(ip); if (!e) return false; if (e.reset < Date.now()) { ipFails.delete(ip); return false; } return e.n >= IP_MAX; };
  const ipFail = (ip) => {
    if (ipFails.size > 10000) { const t = Date.now(); for (const [k, v] of ipFails) if (v.reset < t) ipFails.delete(k); }
    const e = ipFails.get(ip); if (e && e.reset >= Date.now()) e.n++; else ipFails.set(ip, { n: 1, reset: Date.now() + IP_WINDOW });
  };

  async function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('DELETE FROM sessions WHERE expires_at < now() OR last_seen < now() - make_interval(mins => $1)', [IDLE_MIN]);   // housekeeping
    await db.query('INSERT INTO sessions (id,user_id,expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))', [sha(token), userId, ABS_H]);
    res.cookie(COOKIE, token, Object.assign({ maxAge: ABS_H * 3600 * 1000 }, cookieOpts));
  }

  /** Sets req.user = {id,name,role,sessionId} or answers 401. The only thing that decides who is logged in. */
  async function requireAuth(req, res, next) {
    try {
      const tok = parseCookies(req.headers.cookie)[COOKIE];
      if (!tok || !/^[0-9a-f]{64}$/.test(tok)) return fail(res, 401, 'unauthorized', 'Login required');
      const id = sha(tok);
      const q = (await db.query(`SELECT s.id, u.id AS uid, u.name, u.role, u.active,
          s.expires_at > now() AS in_abs, s.last_seen > now() - make_interval(mins => $2) AS in_idle,
          s.last_seen < now() - make_interval(secs => $3) AS stale
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [id, IDLE_MIN, Math.min(30, IDLE_MIN * 15)])).rows[0];
      if (!q) { res.clearCookie(COOKIE, cookieOpts); return fail(res, 401, 'unauthorized', 'Login required'); }
      if (!q.in_abs || !q.in_idle || !q.active) {
        await db.query('DELETE FROM sessions WHERE id=$1', [id]); res.clearCookie(COOKIE, cookieOpts);
        return fail(res, 401, q.active ? 'session_expired' : 'unauthorized', q.active ? 'Your session ended. Please log in again.' : 'Login required');
      }
      if (q.stale) await db.query('UPDATE sessions SET last_seen = now() WHERE id=$1', [id]);   // sliding idle window, written at most every 30 s
      req.user = { id: q.uid, name: q.name, role: q.role, sessionId: id };
      next();
    } catch (e) { next(e); }
  }

  /** After requireAuth: state-changing requests must carry this session's token in X-CSRF-Token. */
  function requireCsrf(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const got = Buffer.from(String(req.get('x-csrf-token') || '')), want = Buffer.from(csrfToken(req.user.sessionId));
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return next();
    return fail(res, 403, 'csrf', 'Missing or wrong CSRF token. Reload the page and try again.');
  }

  const router = express.Router();
  router.post('/login', async (req, res, next) => {
    try {
      const ip = req.ip || 'unknown';
      if (ipBlocked(ip)) return fail(res, 429, 'too_many_attempts', 'Too many failed attempts from this address. Try again later.', { 'Retry-After': String(IP_WINDOW / 1000) });
      const b = loginBody.safeParse(req.body);
      if (!b.success) return fail(res, 400, 'validation', 'Username and password are required');
      const { username, password } = b.data;
      const u = (await db.query(`SELECT id,name,role,active,password_hash,must_change_password,
          locked_until IS NOT NULL AND locked_until > now() AS locked, GREATEST(0, ceil(extract(epoch FROM locked_until - now())))::int AS wait
        FROM users WHERE lower(username)=lower($1)`, [username])).rows[0];
      if (u && u.locked) { await verifyPassword(password, await dummyHash()); return fail(res, 429, 'account_locked', 'This account is locked after repeated failed attempts. Try again later or ask an administrator.', { 'Retry-After': String(u.wait) }); }
      const ok = u && u.active && u.password_hash ? await verifyPassword(password, u.password_hash) : (await verifyPassword(password, await dummyHash()), false);
      if (!ok) {
        ipFail(ip);
        if (u && u.active) await db.query(`UPDATE users SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id=$1`, [u.id, LOCK_N, LOCK_MIN]);
        return fail(res, 401, 'invalid_credentials', 'Invalid username or password');
      }
      await db.query('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
      await startSession(res, u.id);
      res.json({ id: u.id, name: u.name, role: u.role, mustChangePassword: u.must_change_password, allowed: allowedActions(u) });
    } catch (e) { next(e); }
  });
  router.post('/logout', async (req, res, next) => {
    try {
      const tok = parseCookies(req.headers.cookie)[COOKIE];
      if (tok && /^[0-9a-f]{64}$/.test(tok)) await db.query('DELETE FROM sessions WHERE id=$1', [sha(tok)]);
      res.clearCookie(COOKIE, cookieOpts); res.status(204).end();
    } catch (e) { next(e); }
  });
  router.get('/csrf', requireAuth, (req, res) => res.json({ token: csrfToken(req.user.sessionId) }));
  router.get('/session', requireAuth, (req, res) => res.json({ id: req.user.id, name: req.user.name, role: req.user.role, allowed: allowedActions(req.user) }));

  return { router, requireAuth, requireCsrf, settings: { idleMinutes: IDLE_MIN, absoluteHours: ABS_H, lockoutFailures: LOCK_N, lockoutMinutes: LOCK_MIN } };
}

module.exports = { createAuth, hashPassword, verifyPassword, passwordProblem, COOKIE };
