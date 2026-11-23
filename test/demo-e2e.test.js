'use strict';
// Row DM4b: the whole demo path in one test, against the real server and database. SYNTHETIC DATA ONLY.
// seed -> envelope export -> map -> (stub) CCIS CLI -> import -> acknowledge -> read back.
// The CLI is a stub that copies a CCIS fixture record (the real CLI run is row DM4c / the runbook).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, PW, client } = require('./helpers');
const { seedDemo } = require('../scripts/seed-demo');
const { runDemo } = require('../scripts/demo-bridge');

const FIXTURE = path.join(__dirname, 'fixtures', 'ccis', 'run-record-good-completed.json');
const STUB = `const fs = require('fs'); const a = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(a[a.indexOf('--envelope') + 1], 'utf8'));
const rec = JSON.parse(fs.readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));
rec.id = 'run-e2e-' + a[a.indexOf('--at') + 1].replace(/[^0-9]/g, '');
rec.snapshot.case = { ref: input.case.ref };
fs.writeFileSync(a[a.indexOf('--out') + 1], JSON.stringify(rec) + '\\n');`;

let env, dir;
test.before(async () => { env = await setup({ contextSecret: 'demo-secret-demo-secret-demo-secret-12' }); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demoe2e-')); });
test.after(async () => { fs.rmSync(dir, { recursive: true, force: true }); await env.close(); });

test('demo path end to end: seed, export, map, run, import, acknowledge, read back', async () => {
  // 1. seed (real routes, real review rules)
  const seeded = await seedDemo({ base: env.base, password: PW });
  assert.equal(seeded.created, true);

  // 2. a fake CCIS checkout whose CLI is the stub
  const ccis = path.join(dir, 'ccis'); fs.mkdirSync(ccis); fs.writeFileSync(path.join(ccis, 'ccis-cli.js'), STUB);

  // 3. export -> map -> CLI -> import in one call
  const out = path.join(dir, 'out');
  const r = await runDemo({ base: env.base, password: PW, caseId: seeded.caseId, outDir: out, ccisPath: ccis, at: '2026-11-23T12:00:00Z' });
  assert.equal(r.alreadyImported, false);
  assert.equal(r.httpStatus, 201);

  // the exported file is exactly what the server logged, and the mapped input is a separate file
  const exported = fs.readFileSync(r.envelopePath);
  assert.equal(crypto.createHash('sha256').update(exported).digest('hex'), r.envelopeSha256);
  const logged = (await env.pool.query('SELECT envelope_sha256 FROM context_exports WHERE case_id = $1', [seeded.caseId])).rows;
  assert.ok(logged.some(x => x.envelope_sha256 === r.envelopeSha256), 'the export record carries the hash of the file on disk');
  assert.ok(fs.readdirSync(out).some(f => f.endsWith('.ccis-input.json')));

  // 4. the doctor sees one unacknowledged run on the case
  const doctor = client(env.base); assert.equal((await doctor.login('doctor1')).status, 200);
  let list = (await doctor.get(`/api/cases/${seeded.caseId}/ccis-runs`)).body.runs;
  assert.equal(list.length, 1);
  assert.equal(list[0].imported_by, 'doctor1');
  assert.deepEqual(list[0].acks, []);
  assert.equal(list[0].run_record['x-envelopeSha256'], r.envelopeSha256);

  // 5. acknowledge (person and time come from the session)
  const ack = await doctor.post(`/api/ccis-runs/${list[0].id}/ack`, { note: 'Seen on the demo round.' });
  assert.equal(ack.status, 201);
  assert.equal(ack.body.ack.acknowledged_by, 'doctor1');

  // 6. read back: the ack is on the run; a second ack by the same person is refused
  list = (await doctor.get(`/api/cases/${seeded.caseId}/ccis-runs`)).body.runs;
  assert.deepEqual(list[0].acks.map(a => a.acknowledged_by), ['doctor1']);
  assert.equal((await doctor.post(`/api/ccis-runs/${list[0].id}/ack`, {})).status, 409);

  // 7. audit: import and ack are logged; the note text is not
  const audit = (await env.pool.query(`SELECT action, detail::text AS d FROM audit_log WHERE action IN ('ccis.import','ccis.ack') ORDER BY id`)).rows;
  assert.deepEqual(audit.map(a => a.action), ['ccis.import', 'ccis.ack']);
  assert.ok(!audit.some(a => a.d.includes('Seen on the demo round')));
});
