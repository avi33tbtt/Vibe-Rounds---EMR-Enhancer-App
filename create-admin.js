'use strict';
/**
 * Create the first administrator (chunk 32c). Run by hand:  node create-admin.js
 * It asks for a username, a display name and a password (typed twice, not shown). There is NO default password anywhere: nothing is created
 * without one you type, and the password is never taken from the command line or an environment variable. Refuses when an active admin with a
 * password already exists (use the admin screen, chunk 32e), unless you pass --allow-more. Needs DATABASE_URL (or a .env file).
 */
const fs = require('node:fs');
const readline = require('node:readline');
const { createDb, migrate } = require('./server.js');
const { hashPassword, passwordProblem } = require('./auth.js');

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,100}$/;

/** Insert one admin. Throws Error with a plain message for every refusal. mustChange is false for the first admin (the person typed the password). */
async function createAdmin(db, { username, name, password }, { allowMore = false } = {}) {
  if (!USERNAME_RE.test(username || '')) throw new Error('Username: 1 to 100 characters, letters, digits and . _ @ - only');
  const nm = String(name || '').trim();
  if (!nm || nm.length > 200) throw new Error('Name is required (200 characters at most)');
  const bad = passwordProblem(password);
  if (bad) throw new Error(bad);
  const hash = await hashPassword(password);
  return db.withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727275)');                 // two scripts at once cannot both pass the check
    if (!allowMore && (await c.query("SELECT 1 FROM users WHERE role='admin' AND active AND password_hash IS NOT NULL")).rows.length) {
      throw new Error('An administrator with a password already exists. Manage users in the admin screen, or pass --allow-more.');
    }
    const r = await c.query(`INSERT INTO users (username,name,role,password_hash,active,must_change_password) VALUES ($1,$2,'admin',$3,true,false)
      ON CONFLICT DO NOTHING RETURNING id`, [username, nm, hash]);
    if (!r.rows.length) throw new Error('That username is already taken');
    return r.rows[0].id;
  });
}

function makeAsk(rl) {
  if (rl.terminal) {                                                       // interactive: password typed hidden
    return (q, hidden) => new Promise((resolve) => {
      const out = rl.output, w = out.write.bind(out);
      if (hidden) out.write = (x) => (String(x).includes(q) ? w(x) : true);
      rl.question(q, (a) => { out.write = w; if (hidden) w('\n'); resolve(a); });
    });
  }
  const lines = [], waiting = []; let ended = false;                       // piped input: queue the lines
  rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on('close', () => { ended = true; while (waiting.length) waiting.shift()(''); });
  return (q) => { process.stdout.write(q); return new Promise((resolve) => (lines.length ? resolve(lines.shift()) : ended ? resolve('') : waiting.push(resolve))); };
}

async function main() {
  try { process.loadEnvFile && fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) { /* optional */ }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');
  const db = createDb(process.env.DATABASE_URL);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY }), ask = makeAsk(rl);
  try {
    await migrate(db, __dirname);
    const username = (await ask('Username: ')).trim(), name = (await ask('Full name: ')).trim();
    const pw = await ask('Password (12+ characters): ', true), again = await ask('Repeat password: ', true);
    if (pw !== again) throw new Error('The two passwords differ. Nothing was created.');
    await createAdmin(db, { username, name, password: pw }, { allowMore: process.argv.includes('--allow-more') });
    console.log(`Administrator "${username}" created. Log in with it, then add the other staff.`);
  } finally { rl.close(); await db.close(); }
}

module.exports = { createAdmin };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
