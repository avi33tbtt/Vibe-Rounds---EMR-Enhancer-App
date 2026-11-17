'use strict';
/**
 * EMR Enhancer server (chunk 26). One file on purpose: config, database,
 * migration runner, health check and static serving. Later chunks add
 * routes/auth/audit to this file or to a few sibling files in the same folder.
 * Run:  node server.js            (start)
 *       node server.js --migrate  (apply pending migrations, then exit)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const { mountApi } = require('./api.js');

// ---------- config (environment only, fail fast) ----------
function loadConfig(env = process.env) {
  const missing = ['DATABASE_URL'].filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}. See .env.example.`);
  }
  const port = env.PORT ? Number(env.PORT) : 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer 0-65535');
  return {
    databaseUrl: env.DATABASE_URL,
    port,
    nodeEnv: env.NODE_ENV || 'development',
    migrationsDir: env.MIGRATIONS_DIR || __dirname,
  };
}

// ---------- database ----------
function createDb(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  pool.on('error', (e) => console.error('pg pool error:', e.message));
  /** Run fn(client) inside one transaction; commits on success, rolls back on any throw. */
  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection may be gone */ }
      throw e;
    } finally {
      client.release();
    }
  }
  return { pool, query: (t, p) => pool.query(t, p), withTx, close: () => pool.end() };
}

// ---------- migration runner ----------
// Numbered files in the migrations folder: 001_core.sql, 002_x.sql ... (pattern NNN_name.sql).
// Each runs once, in its own transaction, recorded in schema_migrations with a checksum.
// A file that was already applied but has since changed makes the runner stop (never edit an applied migration).
async function migrate(db, dir) {
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const seen = new Set();
  for (const f of files) {
    const n = f.slice(0, 3);
    if (seen.has(n)) throw new Error(`Duplicate migration number ${n}`);
    seen.add(n);
  }
  const applied = [];
  await db.withTx(async (c) => {
    // advisory lock: two servers starting together cannot both migrate
    await c.query('SELECT pg_advisory_xact_lock(727274)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  });
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const sum = crypto.createHash('sha256').update(sql).digest('hex');
    await db.withTx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727274)');
      const r = await c.query('SELECT checksum FROM schema_migrations WHERE version=$1', [f]);
      if (r.rows.length) {
        if (r.rows[0].checksum !== sum) throw new Error(`Migration ${f} was changed after it was applied. Add a new migration instead.`);
        return; // already applied: refuse to run twice
      }
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1,$2)', [f, sum]);
      applied.push(f);
    });
  }
  return applied;
}

// ---------- app ----------
// Only these files are public. The folder also holds server.js, .env and SQL, which must never be served.
const STATIC_FILES = ['enhancer.html', 'element-sets.js', 'cds-rules.js', 'store.js'];

function createApp({ db, getActor }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', express.json({ limit: '1mb' }));

  app.get('/api/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch (e) {
      res.status(503).json({ status: 'degraded', db: 'down' }); // no error detail to the client
    }
  });

  mountApi(app, { db, getActor });

  const sendStatic = (name) => (req, res) => res.sendFile(name, { root: __dirname, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });
  app.get('/', sendStatic('enhancer.html'));
  for (const f of STATIC_FILES) app.get('/' + f, sendStatic(f));

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route' } }));
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const st = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (st === 500) console.error(err);
    const msg = st === 413 ? 'Request body too large' : st === 500 ? 'Internal error' : 'Invalid request body';
    res.status(st).json({ error: { code: st === 413 ? 'too_large' : st === 500 ? 'server_error' : 'bad_request', message: msg } });
  });
  return app;
}

module.exports = { loadConfig, createDb, migrate, createApp, STATIC_FILES };

if (require.main === module) {
  (async () => {
    try { process.loadEnvFile && fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) { /* optional */ }
    const cfg = loadConfig();
    const db = createDb(cfg.databaseUrl);
    const done = await migrate(db, cfg.migrationsDir);
    console.log(done.length ? `Applied migrations: ${done.join(', ')}` : 'Database is up to date.');
    if (process.argv.includes('--migrate')) return db.close();
    const server = createApp({ db }).listen(cfg.port, () => console.log(`EMR Enhancer on http://localhost:${cfg.port}`));
    const stop = () => server.close(() => db.close().then(() => process.exit(0)));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
