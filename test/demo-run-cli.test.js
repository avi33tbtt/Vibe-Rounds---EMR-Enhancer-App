'use strict';
// Row DM3c: runCcis against a STUB CLI (no CCIS checkout, no database). The stub records how it was called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildEnvelope } = require('../envelope');
const { runCcis } = require('../scripts/demo-bridge');

const SET = { id: 1, slug: 'snake-envenomation-timing', version: 1, state: 'active', definition_json: { fields: [{ id: 'bite_time', type: 'datetime' }] } };
const PW = { id: 1, slug: 'snake-envenomation-documentation', version: 1 };
const rows = [{ id: 1, applied_set_id: 1, field_key: 'bite_time', value_type: 'datetime', value_json: '2026-11-23T08:00:00Z', unit_display: null,
  effective_at: new Date(Date.UTC(2026, 10, 23, 8)), recorded_at: new Date(Date.UTC(2026, 10, 23, 9)), source_type: 'clinician', status: 'final', corrects_id: null, recorded_role: 'doctor' }];
const envelope = rows => buildEnvelope({ caseRow: { id: 7 }, pins: { sets: [SET], pathways: [PW] }, observations: rows, exportedAt: new Date(Date.UTC(2026, 10, 23, 10)), producerVersion: '0.1.0', refSecret: 'x'.repeat(32) });

const STUB = `const fs = require('fs'); const a = process.argv.slice(2);
fs.writeFileSync(__dirname + '/argv.json', JSON.stringify({ args: a, env: Object.keys(process.env), cwd: process.cwd(), input: JSON.parse(fs.readFileSync(a[a.indexOf('--envelope') + 1], 'utf8')) }));
if (__dirname.endsWith('fail')) { console.error('error: boom\\nusage: ...'); process.exit(2); }
if (__dirname.endsWith('hang')) setTimeout(() => {}, 60000); else if (!__dirname.endsWith('silent')) fs.writeFileSync(a[a.indexOf('--out') + 1], JSON.stringify({ id: 'run-stub', status: 'complete' }) + '\\n');`;

let root, orig, origBytes;
const mkCli = name => { const d = path.join(root, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'ccis-cli.js'), STUB); return d; };
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'runcli-'));
  ['ok', 'fail', 'hang', 'silent'].forEach(mkCli);
  orig = path.join(root, 'context-envelope-case-7.json');
  origBytes = JSON.stringify(envelope(rows), null, 2) + '\n';
  fs.writeFileSync(orig, origBytes);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let k = 0;
const run = (over = {}) => runCcis({ envelopeFile: orig, outDir: path.join(root, 'out' + (++k)), at: '2026-11-23T12:00:00Z', ccisPath: path.join(root, 'ok'), ...over });
const called = () => JSON.parse(fs.readFileSync(path.join(root, 'ok', 'argv.json'), 'utf8'));

test('hash is of the ORIGINAL file; the CLI gets the mapped copy; the original is untouched', async () => {
  const r = await run();
  assert.equal(r.envelopeSha256, crypto.createHash('sha256').update(origBytes).digest('hex'));
  assert.equal(r.record['x-envelopeSha256'], r.envelopeSha256);
  assert.equal(JSON.parse(fs.readFileSync(r.recordPath, 'utf8'))['x-envelopeSha256'], r.envelopeSha256);
  assert.equal(r.status, 'complete');
  assert.equal(fs.readFileSync(orig, 'utf8'), origBytes);
  assert.equal(called().input.observations[0].concept.id, 'snake.envenomation-timing.bite-time');   // mapped, not the EMR name
});

test('array arguments, no shell, only PATH in the environment, cwd is the CCIS folder; demo flag only when asked', async () => {
  await run();
  let c = called();
  assert.equal(c.args[0], 'run');
  assert.match(c.args[c.args.indexOf('--envelope') + 1], /\.ccis-input\.json$/);
  assert.equal(c.args.includes('--demo-parameters'), false);
  assert.deepEqual(c.env, ['PATH']);
  assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(path.join(root, 'ok')));
  assert.equal(c.args[c.args.indexOf('--at') + 1], '2026-11-23T12:00:00Z');
  await run({ demoParameters: true });
  c = called(); assert.equal(c.args.includes('--demo-parameters'), true);
});

test('a path with shell characters is passed as one argument, not run', async () => {
  const d = path.join(root, 'ok'), weird = path.join(root, 'a b; touch pwned');
  fs.mkdirSync(weird); fs.copyFileSync(path.join(d, 'ccis-cli.js'), path.join(weird, 'ccis-cli.js')); fs.copyFileSync(orig, path.join(weird, 'e.json'));
  await runCcis({ envelopeFile: path.join(weird, 'e.json'), outDir: weird, at: '2026-11-23T12:00:00Z', ccisPath: weird });
  assert.equal(fs.existsSync(path.join(root, 'pwned')) || fs.existsSync(path.join(weird, 'pwned')), false);
});

test('throws: no CCIS_PATH, wrong folder, bad time, unmappable envelope, CLI exit 2, timeout, no record', async () => {
  const saved = process.env.CCIS_PATH; delete process.env.CCIS_PATH;
  await assert.rejects(runCcis({ envelopeFile: orig, outDir: root, at: '2026-11-23T12:00:00Z' }), /CCIS_PATH is not set/);
  if (saved !== undefined) process.env.CCIS_PATH = saved;
  await assert.rejects(run({ ccisPath: path.join(root, 'nope') }), /ccis-cli\.js not found/);
  await assert.rejects(run({ at: '2026-11-23 12:00' }), /ISO date-time/);
  await assert.rejects(run({ at: undefined }), /ISO date-time/);
  const e = envelope(rows), bad = path.join(root, 'bad.json');
  e.observations[0].concept.id = 'other.thing'; fs.writeFileSync(bad, JSON.stringify(e));
  await assert.rejects(run({ envelopeFile: bad }), /Cannot map concept/);
  await assert.rejects(run({ ccisPath: path.join(root, 'fail') }), /CCIS CLI failed \(exit 2: error: boom\)/);
  await assert.rejects(run({ ccisPath: path.join(root, 'hang'), timeoutMs: 300 }), /timed out after 300 ms/);
  await assert.rejects(run({ ccisPath: path.join(root, 'silent') }), /wrote no record/);
});
