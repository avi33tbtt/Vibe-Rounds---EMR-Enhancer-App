'use strict';
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v); // keep DATE columns as 'YYYY-MM-DD' strings (no timezone shift)

function makePool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString: url });
}

// Run fn(client) inside one transaction (action + its audit row commit together).
async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { makePool, tx };
