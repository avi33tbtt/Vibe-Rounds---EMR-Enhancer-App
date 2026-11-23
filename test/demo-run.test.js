'use strict';
// Row DM3d: export -> map -> (stub) CCIS CLI -> import, against the real server and database. SYNTHETIC DATA ONLY.
// The stub CLI copies a CCIS fixture record and sets its case reference from the mapped input, as the real CLI does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, PW, client } = require('./helpers');
const { seedDemo } = require('../scripts/seed-demo');
const { importRun, runDemo } = require('../scripts/demo-bridge');

const FIXTURE = path.join(__dirname, 'fixtures', 'ccis', 'run-record-good-completed.json');
const STUB = `const fs = require('fs'); const a = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(a[a.indexOf('--envelope') + 1], 'utf8'));
const rec = JSON.parse(fs.readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));
rec.id = 'run-stub-' + a[a.indexOf('--at') + 1].replace(/[^0-9]/g, '');
rec.snapshot.case = { ref: input.case.ref };
fs.writeFileSync(a[a.indexOf('--out') + 1], JSON.stringify(rec) + '\\n');`;

let env, seeded, dir, ccis, k = 0;
test.before(async () => {
  env = await setup({ contextSecret: 'demo-secret-demo-secret-demo-secret-12' });
  seeded = await seedDemo({ base: env.base, password: PW });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demorun-'));
  ccis = path.join(dir, 'ccis'); fs.mkdirSync(ccis); fs.writeFileSync(path.join(ccis, 'ccis-cli.js'), STUB);
});
test.after(async () => { fs.rmSync(dir, { recursive: true, force: true }); await env.close(); });
const go = (over = {}) => runDemo({ base: env.base, password: PW, caseId: seeded.caseId, outDir: path.join(dir, 'out' + (++k)), ccisPath: ccis, at: '2026-11-23T12:00:00Z', ...over });
const runs = async () => (await env.pool.query('SELECT * FROM ccis_runs WHERE case_id = $1', [seeded.caseId])).rows;

test('one call leaves a run in the case: stored record carries the hash of the exported file', async () => {
  const r = await go();
  assert.equal(r.alreadyImported, false);
  assert.equal(r.httpStatus, 201);
  const rows = await runs();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].envelope_sha256, r.envelopeSha256);
  assert.equal(rows[0].run_record['x-envelopeSha256'], r.envelopeSha256);
  const d = client(env.base); await d.login('doctor1');
  const list = await d.get(`/api/cases/${seeded.caseId}/ccis-runs`);
  assert.equal(list.body.runs.length, 1);
  assert.equal(list.body.runs[0].imported_by, 'doctor1');
});

test('retrying with the same record gives alreadyImported and stores nothing more', async () => {
  const r = await go();                              // a new export, so a new hash and a new record: stored
  const again = await importRun({ base: env.base, username: 'doctor1', password: PW, caseId: seeded.caseId, recordPath: r.recordPath });
  assert.equal(again.alreadyImported, true);
  assert.equal(again.runId, r.runId);
  assert.equal(again.httpStatus, 200);
  const before = (await runs()).length;
  await importRun({ base: env.base, username: 'doctor1', password: PW, caseId: seeded.caseId, recordPath: r.recordPath });
  assert.equal((await runs()).length, before);
});

test('the server\'s refusals reach the caller as plain errors; a viewer cannot import', async () => {
  const r = await go();
  const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, JSON.stringify({ id: 'nope' }));
  await assert.rejects(importRun({ base: env.base, username: 'doctor1', password: PW, caseId: seeded.caseId, recordPath: bad }), /Import failed \(422\)/);
  await assert.rejects(importRun({ base: env.base, username: 'viewer1', password: PW, caseId: seeded.caseId, recordPath: r.recordPath }), /Import failed \(403\)/);
  await assert.rejects(importRun({ base: env.base, username: 'doctor1', password: 'wrong-password', caseId: seeded.caseId, recordPath: r.recordPath }), /Login as doctor1 failed/);
  await assert.rejects(importRun({ base: env.base, username: 'doctor1', password: PW, caseId: '1; DROP', recordPath: r.recordPath }), /caseId must be a number/);
});

test('a record made from another case\'s envelope is refused by the server', async () => {
  const r = await go();
  const d = client(env.base); await d.login('doctor1');
  const p = await d.post('/api/patients', { name: 'Other Patient', mrn: 'OTHER-' + process.pid, dob: '1980-01-01', sex: 'F' });
  const other = (await d.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Other case' })).body.case;
  await assert.rejects(importRun({ base: env.base, username: 'doctor1', password: PW, caseId: other.id, recordPath: r.recordPath }), /Import failed \(422\)/);
});

test('a failing CLI stops the run before any import', async () => {
  const before = (await runs()).length;
  const bad = path.join(dir, 'ccis-fail'); fs.mkdirSync(bad); fs.writeFileSync(path.join(bad, 'ccis-cli.js'), 'process.exit(2)');
  await assert.rejects(go({ ccisPath: bad }), /CCIS CLI failed/);
  assert.equal((await runs()).length, before);
});
