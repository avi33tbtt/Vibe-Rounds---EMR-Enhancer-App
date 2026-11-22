'use strict';
// Chunk 05, check 5: migrations run from an empty database AND from every earlier version of the schema,
// keep the data that was already there, refuse edited migrations, and leave nothing half-done on failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makePool } = require('../db');
const { migrate } = require('../migrate');
const { hashPassword } = require('../auth');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const REAL = path.join(__dirname, '..', 'migrations');
const FILES = fs.readdirSync(REAL).filter(f => /\.sql$/.test(f)).sort();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

let pool;
const tmpDirs = [];
test.before(() => { if (!URL) throw new Error('Set TEST_DATABASE_URL to an empty scratch database (it is wiped).'); pool = makePool(URL); });
test.after(async () => { await pool.end(); for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const reset = () => pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
const names = async () => (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name);
const tables = async () => (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows.map(r => r.table_name);
const exists = async t => (await tables()).includes(t);
function dirOf(files, edit = {}, extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-mig-')); tmpDirs.push(d);
  for (const f of files) fs.writeFileSync(path.join(d, f), (edit[f] || (s => s))(fs.readFileSync(path.join(REAL, f), 'utf8')));
  for (const [f, sql] of Object.entries(extra)) fs.writeFileSync(path.join(d, f), sql);
  return d;
}

test('migration files are numbered 001, 002, ... with no gaps and no duplicates', () => {
  assert.ok(FILES.length >= 4);
  FILES.forEach((f, i) => assert.match(f, new RegExp('^' + String(i + 1).padStart(3, '0') + '_[a-z0-9_]+\\.sql$'), f));
});

test('from an empty database: every migration applies once, in order, and a second run does nothing', async () => {
  await reset();
  assert.deepEqual(await migrate(pool), FILES);
  assert.deepEqual(await names(), FILES);
  assert.deepEqual(await migrate(pool), []);
  const sums = Object.fromEntries((await pool.query('SELECT name, checksum FROM schema_migrations')).rows.map(r => [r.name, r.checksum]));
  for (const f of FILES) assert.equal(sums[f], sha(fs.readFileSync(path.join(REAL, f), 'utf8')), 'checksum of ' + f);
  for (const t of ['users', 'sessions', 'audit_log', 'patients', 'encounters', 'ai_settings']) assert.ok(await exists(t), t);
  // safe defaults after a fresh install
  const ai = (await pool.query('SELECT * FROM ai_settings')).rows;
  assert.equal(ai.length, 1); assert.equal(ai[0].enabled, false);
  assert.equal((await pool.query('SELECT count(*) n FROM users')).rows[0].n, '0', 'migrations create no users');
});

// Puts a little data into whichever tables exist at that version, so the upgrade has something to keep.
async function fixture() {
  const out = {};
  if (await exists('users')) {
    await pool.query(`INSERT INTO users(username, display_name, role, password_hash) VALUES ('mig-doc','Mig Doc','doctor',$1)`, [hashPassword('x')]);
    out.users = 1;
  }
  const uid = out.users ? (await pool.query(`SELECT id FROM users WHERE username = 'mig-doc'`)).rows[0].id : null;
  if (await exists('audit_log')) { await pool.query(`INSERT INTO audit_log(user_id, username, role, action) VALUES ($1,'mig-doc','doctor','fixture.before')`, [uid]); out.audit_log = 1; }
  if (await exists('patients')) {
    const p = await pool.query(`INSERT INTO patients(mrn, name, dob, sex, created_by) VALUES ('MIG-1','Mig Patient','1970-05-05','F',$1) RETURNING id`, [uid]);
    await pool.query(`INSERT INTO encounters(patient_id, bed, opened_by) VALUES ($1,'MIG-BED',$2)`, [p.rows[0].id, uid]);
    out.patients = 1; out.encounters = 1;
  }
  return out;
}
const countsOf = async fx => Object.fromEntries(await Promise.all(Object.keys(fx).map(async t => [t, Number((await pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n)])));

test('from every earlier version: upgrades apply only the missing migrations and keep existing data', async () => {
  for (let k = 1; k < FILES.length; k++) {
    await reset();
    const older = dirOf(FILES.slice(0, k));
    assert.deepEqual(await migrate(pool, older), FILES.slice(0, k), `old version ${k}`);
    const fx = await fixture();
    const before = await countsOf(fx);
    assert.deepEqual(await migrate(pool), FILES.slice(k), `upgrade from ${FILES[k - 1]}`);
    assert.deepEqual(await names(), FILES);
    assert.deepEqual(await countsOf(fx), before, `rows kept when upgrading from ${FILES[k - 1]}`);
    // the rules added by later migrations hold on the upgraded database, on rows that existed before AND rows added after
    const uid = (await pool.query(`SELECT id FROM users WHERE username = 'mig-doc'`)).rows[0].id;
    await pool.query(`INSERT INTO audit_log(user_id, username, role, action) VALUES ($1,'mig-doc','doctor','fixture.after')`, [uid]);
    await pool.query(`INSERT INTO patients(mrn, name, dob, sex, created_by) VALUES ('MIG-AFTER','After Upgrade','1990-01-01','M',$1)`, [uid]);
    await assert.rejects(pool.query(`UPDATE audit_log SET action = 'x'`), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM audit_log`), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM patients`), /not allowed/);
  }
  // upgraded data is intact and usable, e.g. the encounter rules still hold
  const dup = await pool.query(`SELECT count(*) n FROM encounters WHERE status = 'open'`);
  assert.equal(dup.rows[0].n, '1');
});

test('an applied migration that is edited later is refused (add a new migration instead)', async () => {
  await reset();
  await migrate(pool);
  const edited = dirOf(FILES, { [FILES[0]]: s => s + '\n-- sneaky change\n' });
  await assert.rejects(migrate(pool, edited), /was edited after being applied/);
  assert.deepEqual(await names(), FILES, 'nothing was changed');
});

test('a failing migration is rolled back completely and not recorded; earlier good ones stay applied', async () => {
  const BAD = 'CREATE TABLE half_done (x int); INSERT INTO half_done VALUES (1); SELECT 1/0;';
  // bad one in the middle of a run
  await reset();
  await assert.rejects(migrate(pool, dirOf(FILES.slice(0, 2), {}, { '003_bad.sql': BAD, '004_never.sql': 'CREATE TABLE never_made (x int);' })), /003_bad\.sql failed/);
  assert.ok(!(await exists('half_done')), 'no half-applied table');
  assert.ok(!(await exists('never_made')), 'nothing after the failure ran');
  assert.deepEqual(await names(), FILES.slice(0, 2), 'only the good ones before it are recorded');
  // bad one at the end, on top of a full install
  await reset();
  await migrate(pool);
  await assert.rejects(migrate(pool, dirOf(FILES, {}, { '999_bad.sql': BAD })), /999_bad\.sql failed/);
  assert.ok(!(await exists('half_done')));
  assert.deepEqual(await names(), FILES);
  assert.deepEqual(await migrate(pool), [], 'the real set is still fully applied');
});

test('two servers starting at once: each migration is applied exactly once', async () => {
  await reset();
  const other = makePool(URL);
  try {
    const [a, b] = await Promise.all([migrate(pool), migrate(other)]);
    assert.deepEqual([...a, ...b].sort(), FILES, 'every migration ran once, by exactly one of the two');
    assert.deepEqual(await names(), FILES);
  } finally { await other.end(); }
});
