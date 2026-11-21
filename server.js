'use strict';
const { makePool } = require('./db');
const { migrate } = require('./migrate');
const { createApp } = require('./app');

(async () => {
  const pool = makePool();
  const applied = await migrate(pool);
  if (applied.length) console.log('Applied migrations:', applied.join(', '));
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createApp(pool).listen(port, host, () => console.log(`EMR Enhancer (synthetic data only) on http://${host}:${port}`));
})().catch(e => { console.error(e.message); process.exit(1); });
