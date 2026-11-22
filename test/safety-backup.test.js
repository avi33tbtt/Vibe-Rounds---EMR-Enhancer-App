'use strict';
// Chunk 7b: encrypted backups. The dump must be unreadable without the private key, checksummed, and pruned to the newest N.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setup } = require('./helpers');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const has = cmd => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const tools = has('age') && has('age-keygen') && has('pg_dump') && has('pg_restore') && has('sha256sum') && has('bash');
// Like the browser smoke test: skipped on a machine without the tools, but a failure on CI.
const skip = !tools && process.env.CI !== 'true' ? 'needs age, pg_dump, pg_restore and bash on PATH' : false;

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backup.sh');
const run = (env, cwd) => spawnSync('bash', [SCRIPT], { env: { ...process.env, BACKUP_DATABASE_URL: URL, ...env }, cwd, encoding: 'utf8' });
const keypair = dir => {
  const file = path.join(dir, 'key-' + Math.random().toString(36).slice(2) + '.txt');
  const r = spawnSync('age-keygen', ['-o', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { file, pub: fs.readFileSync(file, 'utf8').match(/public key: (age1\w+)/)[1] };
};
const backups = dir => fs.readdirSync(dir).filter(f => /^emr-.*\.dump\.age$/.test(f)).sort();

test('backup is encrypted, checksummed, restorable with the key only, and pruned to the newest N', { skip }, async () => {
  assert.ok(tools, 'CI must have age and the PostgreSQL client tools installed');
  const { pool, close } = await setup();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-backup-'));
  try {
    const MARK = 'BACKUP-MARKER-' + Math.random().toString(36).slice(2, 10);
    await pool.query(`INSERT INTO users(username, display_name, role, password_hash) VALUES ('bk_marker', $1, 'viewer', 'x')`, [MARK]);
    const dir = path.join(tmp, 'out');
    const good = keypair(tmp), other = keypair(tmp);

    // 1. One run writes one encrypted file and a matching checksum.
    let r = run({ BACKUP_DIR: dir, BACKUP_AGE_RECIPIENT: good.pub, BACKUP_KEEP: '2' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let files = backups(dir);
    assert.equal(files.length, 1);
    const enc = path.join(dir, files[0]);
    const bytes = fs.readFileSync(enc);
    assert.equal(bytes.subarray(0, 21).toString(), 'age-encryption.org/v1', 'an age file');
    assert.ok(!bytes.includes('PGDMP'), 'no plain pg_dump header in the file');
    assert.ok(!bytes.includes(MARK), 'the data cannot be read from the file');
    assert.equal(spawnSync('sha256sum', ['-c', files[0] + '.sha256'], { cwd: dir }).status, 0, 'checksum matches');
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.partial')), [], 'no half-written file left');

    // 2. The wrong key cannot open it; the right key can, and the dump holds the data and audit_log.
    const bad = spawnSync('age', ['-d', '-i', other.file, '-o', path.join(tmp, 'bad.dump'), enc], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0, 'wrong key must fail');
    assert.ok(!fs.existsSync(path.join(tmp, 'bad.dump')) || fs.statSync(path.join(tmp, 'bad.dump')).size === 0);
    const plain = path.join(tmp, 'ok.dump');
    assert.equal(spawnSync('age', ['-d', '-i', good.file, '-o', plain, enc]).status, 0, 'right key opens it');
    const toc = spawnSync('pg_restore', ['-l', plain], { encoding: 'utf8' }).stdout;
    assert.match(toc, /TABLE DATA public audit_log/, 'audit_log is in the backup');
    const data = spawnSync('pg_restore', ['--data-only', '--table=users', '-f', '-', plain], { encoding: 'utf8' }).stdout;
    assert.ok(data.includes(MARK), 'restored data contains the marker row');

    // 3. Keep only the newest 2 of 3, together with their checksum files.
    for (let i = 0; i < 2; i++) assert.equal(run({ BACKUP_DIR: dir, BACKUP_AGE_RECIPIENT: good.pub, BACKUP_KEEP: '2' }).status, 0);
    const after = backups(dir);
    assert.equal(after.length, 2);
    assert.ok(!after.includes(files[0]), 'the oldest backup was removed');
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.sha256')).length, 2, 'checksum files follow their backups');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await close();
  }
});

test('backup refuses to run without a public key, and keeps nothing when pg_dump fails', { skip }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-backup-'));
  try {
    const dir = path.join(tmp, 'out');
    const { pub } = keypair(tmp);
    for (const key of ['', 'not-a-key', fs.readFileSync(path.join(tmp, fs.readdirSync(tmp)[0]), 'utf8').match(/AGE-SECRET-KEY-\S+/)[0]]) {
      const r = run({ BACKUP_DIR: dir, BACKUP_AGE_RECIPIENT: key });
      assert.notEqual(r.status, 0, 'a missing or private key is refused: ' + key.slice(0, 12));
      assert.ok(!key.startsWith('AGE-SECRET-KEY') || !r.stdout.includes(key), 'the private key is never echoed');
    }
    assert.ok(!fs.existsSync(dir) || backups(dir).length === 0, 'nothing written');
    const r = run({ BACKUP_DIR: dir, BACKUP_AGE_RECIPIENT: pub, BACKUP_DATABASE_URL: 'postgres://nobody:nope@127.0.0.1:1/none' });
    assert.notEqual(r.status, 0, 'a failed dump is a failed backup');
    assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no empty or partial file kept');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
