'use strict';
// Row DM3a: the bridge's export step. The file must be the exact bytes the server sent and hashed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv2020 = require('ajv/dist/2020');
const { setup, PW } = require('./helpers');
const { seedDemo } = require('../scripts/seed-demo');
const { exportEnvelope } = require('../scripts/demo-bridge');

const C = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', f), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(C('manifest.schema.json'));
const validate = ajv.compile(C('context-envelope.schema.json'));

let env, seeded, dir;
test.before(async () => {
  env = await setup({ contextSecret: 'demo-secret-demo-secret-demo-secret-12' });
  seeded = await seedDemo({ base: env.base, password: PW });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
});
test.after(async () => { fs.rmSync(dir, { recursive: true, force: true }); await env.close(); });

test('the file is the exact bytes sent: its hash equals the returned hash and the context_exports row', async () => {
  const r = await exportEnvelope({ base: env.base, username: 'doctor1', password: PW, caseId: seeded.caseId, outDir: dir });
  const onDisk = fs.readFileSync(r.path);
  assert.equal(crypto.createHash('sha256').update(onDisk).digest('hex'), r.sha256);
  assert.equal(r.bytes, onDisk.length);
  const rows = (await env.pool.query('SELECT envelope_sha256 FROM context_exports WHERE case_id = $1 ORDER BY id DESC LIMIT 1', [seeded.caseId])).rows;
  assert.equal(rows[0].envelope_sha256, r.sha256);
  assert.equal(path.dirname(r.path), dir);
});

test('the exported file validates against the CCIS envelope schema and holds no identity', async () => {
  const r = await exportEnvelope({ base: env.base, username: 'doctor1', password: PW, caseId: seeded.caseId, outDir: dir });
  const text = fs.readFileSync(r.path, 'utf8');
  assert.equal(validate(JSON.parse(text)), true, JSON.stringify(validate.errors));
  assert.equal(/DEMO, Patient|DEMO-0001/.test(text), false);
});

test('a bad login, an unknown case and a user without context permission all throw', async () => {
  const base = { base: env.base, caseId: seeded.caseId, outDir: dir };
  await assert.rejects(exportEnvelope({ ...base, username: 'doctor1', password: 'wrong-password' }), /Login as doctor1 failed/);
  await assert.rejects(exportEnvelope({ ...base, username: 'doctor1', password: PW, caseId: 999999 }), /failed \(404\)/);
  await assert.rejects(exportEnvelope({ ...base, username: 'doctor1', password: PW, caseId: '1; DROP' }), /caseId must be a number/);
  await assert.rejects(exportEnvelope({ ...base, username: 'viewer1', password: PW }), /failed \(403\)/);
});
