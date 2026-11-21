'use strict';
// Numbered migrations: applied once, in filename order, never edited afterwards.
// A checksum is stored so an edited, already-applied migration is detected and refused.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makePool } = require('./db');

async function migrate(pool, dir = path.join(__dirname, 'migrations')) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map(r => [r.name, r.checksum]));
    const files = fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
    const applied = [];
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`Migration ${f} was edited after being applied. Add a new migration instead.`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)', [f, sum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
      applied.push(f);
    }
    return applied;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(727001)'); } catch (_) { /* ignore */ }
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const pool = makePool();
  migrate(pool)
    .then(a => { console.log(a.length ? 'Applied: ' + a.join(', ') : 'Up to date'); return pool.end(); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
