'use strict';
const crypto = require('crypto');
const { can } = require('./permissions');
const { audit } = require('./audit');

const SESSION_HOURS = 12;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function createSession(pool, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' hours')::interval)`,
    [sha(token), userId, String(SESSION_HOURS)]);
  return token;
}

const cookieHeader = (token, maxAge) =>
  `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

// Middleware: loads req.user from the session cookie (identity always comes from here).
function sessionLoader(pool) {
  return async (req, _res, next) => {
    req.user = null;
    const token = parseCookies(req).sid;
    if (token) {
      const { rows } = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha(token)]);
      if (rows[0]) { req.user = rows[0]; req.sessionHash = sha(token); }
    }
    next();
  };
}

const requireLogin = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'login_required' });

// Permission guard. Denied attempts are written to the audit log.
const requirePerm = (pool, perm) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'login_required' });
  if (can(req.user.role, perm)) return next();
  await audit(pool, req, 'permission.denied', null, null, { perm, method: req.method, path: req.path });
  res.status(403).json({ error: 'forbidden', perm });
};

// Mutating requests must be JSON and carry a custom header (a browser form post cannot add it).
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-emr') !== '1') return res.status(400).json({ error: 'missing_x_emr_header' });
  next();
}

module.exports = { hashPassword, checkPassword, createSession, cookieHeader, sessionLoader, requireLogin, requirePerm, csrfGuard, sha, parseCookies, SESSION_HOURS };
