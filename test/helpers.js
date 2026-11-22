'use strict';
const { makePool } = require('../db');
const { migrate } = require('../migrate');
const { createApp } = require('../app');
const { hashPassword } = require('../auth');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const PW = 'test-password-1';

async function setup(appOpts = {}) {
  if (!URL) throw new Error('Set TEST_DATABASE_URL to an empty scratch database (it is wiped).');
  const pool = makePool(URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  for (const [u, r] of [['admin1', 'admin'], ['doctor1', 'doctor'], ['nurse1', 'nurse'], ['viewer1', 'viewer'], ['informatician1', 'informatician'], ['informatician2', 'informatician']]) {
    await pool.query('INSERT INTO users(username, display_name, role, password_hash) VALUES ($1,$2,$3,$4)', [u, u, r, hashPassword(PW)]);
  }
  // The app under test runs as the restricted emr_app role (migration 005), like production.
  // `pool` stays the owner connection for fixtures and for tests that probe the database directly.
  const appPool = makePool(URL);
  appPool.on('connect', c => c.query('SET ROLE emr_app'));
  const server = createApp(appPool, { quiet: true, ...appOpts }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { await new Promise(r => server.close(r)); await appPool.end(); await pool.end(); };
  return { pool, appPool, base, close };
}

// Tiny client that keeps its own session cookie.
function client(base) {
  let cookie = '';
  async function call(method, path, body, extra = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-emr': '1', ...(cookie ? { cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch (_) { /* no body */ }
    return { status: res.status, body: json };
  }
  return {
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b = {}) => call('PATCH', p, b), raw: call,
    login: (u, pw = PW) => call('POST', '/api/login', { username: u, password: pw }),
  };
}
module.exports = { setup, client, PW };
