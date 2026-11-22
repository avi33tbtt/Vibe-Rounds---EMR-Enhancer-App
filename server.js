'use strict';
const { makePool } = require('./db');
const { migrate } = require('./migrate');
const { createApp } = require('./app');

(async () => {
  // With MIGRATE_DATABASE_URL set, migrations run on the owner connection and the server itself
  // runs on DATABASE_URL (the restricted emr_app role). Without it (local dev) one connection does both.
  const pool = makePool();
  const migrateUrl = process.env.MIGRATE_DATABASE_URL;
  const mpool = migrateUrl ? makePool(migrateUrl) : pool;
  const applied = await migrate(mpool);
  if (migrateUrl) await mpool.end();
  else console.warn('MIGRATE_DATABASE_URL is not set: the server is running with owner rights (local dev only).');
  if (applied.length) console.log('Applied migrations:', applied.join(', '));
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createApp(pool).listen(port, host, () => console.log(`EMR Enhancer (synthetic data only) on http://${host}:${port}`));
})().catch(e => { console.error(e.message); process.exit(1); });
