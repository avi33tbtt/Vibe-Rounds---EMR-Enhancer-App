'use strict';
// Creates synthetic demo users. Set SEED_PASSWORD, or a random one is printed once.
const crypto = require('crypto');
const { makePool } = require('./db');
const { migrate } = require('./migrate');
const { hashPassword } = require('./auth');

(async () => {
  // Creates users, so it needs the owner connection (the app role can only read users).
  const pool = makePool(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL);
  await migrate(pool);
  const pw = process.env.SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const users = [['admin1', 'Demo Admin', 'admin'], ['doctor1', 'Demo Doctor', 'doctor'], ['nurse1', 'Demo Nurse', 'nurse'], ['viewer1', 'Demo Viewer', 'viewer']];
  for (const [u, n, r] of users) {
    await pool.query(`INSERT INTO users(username, display_name, role, password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING`, [u, n, r, hashPassword(pw)]);
  }
  console.log('Users: ' + users.map(u => u[0]).join(', ') + (process.env.SEED_PASSWORD ? '' : `\nPassword (shown once): ${pw}`));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
