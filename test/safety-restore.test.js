'use strict';
// Chunk 7c: restore from an encrypted backup into a new database, and compare counts with the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setup } = require('./helpers');

const U = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://x@localhost/x');
const SRC_DB = U.pathname.slice(1);
const PGENV = { PGHOST: U.hostname, PGPORT: U.port || '5432', PGUSER: decodeURIComponent(U.username), ...(U.password ? { PGPASSWORD: decodeURIComponent(U.password) } : {}) };
const has = cmd => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const tools = ['age', 'age-keygen', 'pg_dump', 'pg_restore', 'psql', 'createdb', 'dropdb', 'sha256sum', 'bash'].every(has);
const skip = !tools && process.env.CI !== 'true' ? 'needs age and the PostgreSQL client tools on PATH' : false;

const S = f => path.join(__dirname, '..', 'scripts', f);
const sh = (script, args, env = {}) => spawnSync('bash', [S(script), ...args], { env: { ...process.env, ...PGENV, ...env }, encoding: 'utf8' });
const psql = (db, sql) => spawnSync('psql', ['-X', '-At', '-d', db, '-c', sql], { env: { ...process.env, ...PGENV }, encoding: 'utf8' });
const dbExists = name => psql('postgres', `SELECT 1 FROM pg_database WHERE datname='${name}'`).stdout.trim() === '1';
const rand = () => Math.random().toString(36).slice(2, 8);

test('restore: backup goes into a new database; counts match; refuses overwrite, wrong key and damaged file', { skip }, async () => {
  assert.ok(tools, 'CI must have age and the PostgreSQL client tools installed');
  const { pool, close } = await setup();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-restore-'));
  const made = [];
  try {
    // Source data: 2 patients, 1 encounter, some audit rows.
    const uid = (await pool.query(`SELECT id FROM users WHERE username='admin1'`)).rows[0].id;
    await pool.query(`INSERT INTO patients(mrn,name,dob,sex,created_by) VALUES ('R1','Restore One','1990-01-01','F',$1),('R2','Restore Two','1985-05-05','M',$1)`, [uid]);
    await pool.query(`INSERT INTO encounters(patient_id,bed,opened_by) SELECT id,'B1',$1 FROM patients WHERE mrn='R1'`, [uid]);
    for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO audit_log(user_id,username,role,action) VALUES ($1,'admin1','admin','test.restore')`, [uid]);

    // Back it up with the real script.
    const keyFile = path.join(tmp, 'key.txt'), wrongKey = path.join(tmp, 'wrong.txt');
    assert.equal(spawnSync('age-keygen', ['-o', keyFile]).status, 0);
    assert.equal(spawnSync('age-keygen', ['-o', wrongKey]).status, 0);
    const pub = fs.readFileSync(keyFile, 'utf8').match(/public key: (age1\w+)/)[1];
    const dir = path.join(tmp, 'bk');
    const b = sh('backup.sh', [], { BACKUP_DIR: dir, BACKUP_AGE_RECIPIENT: pub, BACKUP_DATABASE_URL: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
    assert.equal(b.status, 0, b.stdout + b.stderr);
    const file = path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.dump.age')));
    const counts = path.join(tmp, 'counts.txt');
    const p = sh('verify-restore.sh', ['print', SRC_DB]);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout.trim(), /^patients=2 encounters=1 audit_log=\d+ audit_last_id=\d+$/);
    fs.writeFileSync(counts, p.stdout);

    // 1. Restore into a new database; the migrations check and counts pass (against the file and against the source).
    const db = 'emr_restore_' + rand(); made.push(db);
    const r = sh('restore.sh', [file, keyFile, db]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /checksum ok/);
    assert.match(r.stdout, /migrations: \d+ recorded, \d+ in this code/);
    for (const src of [counts, SRC_DB]) {
      const v = sh('verify-restore.sh', ['compare', db, src]);
      assert.equal(v.status, 0, v.stdout + v.stderr);
      assert.match(v.stdout, /MATCH/);
    }
    // The restricted role still has its limits in the restored database.
    assert.equal(psql(db, `SELECT has_table_privilege('emr_app','patients','SELECT')`).stdout.trim(), 't');
    assert.equal(psql(db, `SELECT has_table_privilege('emr_app','patients','DELETE')`).stdout.trim(), 'f');
    assert.equal(psql(db, `SELECT has_table_privilege('emr_app','audit_log','DELETE')`).stdout.trim(), 'f');

    // 2. A difference is caught.
    psql(db, `INSERT INTO audit_log(action) VALUES ('extra')`);
    const bad = sh('verify-restore.sh', ['compare', db, counts]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /audit_log\s+\d+\s+\d+\s+NO/);

    // 3. It never overwrites an existing database.
    const again = sh('restore.sh', [file, keyFile, db]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);
    assert.equal(psql(db, `SELECT count(*) FROM patients`).stdout.trim(), '2', 'the existing database is untouched');

    // 4. Wrong key: fails and leaves no new database behind.
    const db2 = 'emr_restore_' + rand(); made.push(db2);
    const wk = sh('restore.sh', [file, wrongKey, db2]);
    assert.notEqual(wk.status, 0);
    assert.equal(dbExists(db2), false, 'a failed restore drops its new database');

    // 5. Damaged file: the checksum stops it before any database is created.
    const copy = path.join(tmp, 'copy.dump.age');
    fs.copyFileSync(file, copy); fs.copyFileSync(file + '.sha256', copy + '.sha256');
    fs.writeFileSync(copy + '.sha256', fs.readFileSync(copy + '.sha256', 'utf8').replace(/^./, c => (c === '0' ? '1' : '0')));
    const db3 = 'emr_restore_' + rand(); made.push(db3);
    const dm = sh('restore.sh', [copy, keyFile, db3]);
    assert.notEqual(dm.status, 0);
    assert.match(dm.stderr, /checksum does not match/);
    assert.equal(dbExists(db3), false);

    // 6. Bad arguments.
    assert.notEqual(sh('restore.sh', [file, keyFile, 'Bad-Name']).status, 0);
    assert.notEqual(sh('restore.sh', ['/no/such.age', keyFile, 'emr_x']).status, 0);
  } finally {
    for (const d of made) spawnSync('dropdb', ['--if-exists', d], { env: { ...process.env, ...PGENV } });
    fs.rmSync(tmp, { recursive: true, force: true });
    await close();
  }
});
