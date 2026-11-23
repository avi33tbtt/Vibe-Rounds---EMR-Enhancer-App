'use strict';
// Row DM3a: demo bridge, step 1. SYNTHETIC DATA ONLY. Prototype, not for clinical use.
// Logs in over HTTP, asks the EMR for the context envelope of ONE case and writes the response bytes to a file, unchanged.
// The file's SHA-256 is the same hash the server logged in context_exports, so the file can be matched to its export record later.
// DM3b added id mapping, DM3c the CCIS CLI child process, DM3d the import and `npm run demo:run`. The only link to CCIS stays files plus a child process.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { mapEnvelope } = require('./demo-map');

async function login(base, username, password) {
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-emr': '1' }, body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(`Login as ${username} failed (${login.status}).`);
  const sc = login.headers.get('set-cookie');
  if (!sc) throw new Error('Login gave no session cookie.');
  return sc.split(';')[0];
}

async function exportEnvelope({ base, username, password, caseId, outDir }) {
  if (!/^\d{1,9}$/.test(String(caseId))) throw new Error('caseId must be a number.');
  if (!outDir) throw new Error('outDir is required.');
  const cookie = await login(base, username, password);

  const res = await fetch(`${base}/api/cases/${caseId}/context`, { headers: { 'x-emr': '1', cookie } });
  const bytes = Buffer.from(await res.arrayBuffer());      // raw bytes: never parsed and written back
  if (res.status !== 200) {
    let msg = 'no message'; try { const j = JSON.parse(bytes.toString('utf8')); msg = j.message || j.error || msg; } catch (_) { /* not JSON */ }
    throw new Error(`Context export failed (${res.status}): ${msg}`);
  }
  const m = /filename="([A-Za-z0-9._-]+)"/.exec(res.headers.get('content-disposition') || '');
  const name = m ? path.basename(m[1]) : `context-envelope-case-${caseId}.json`;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, bytes);
  return { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

// Row DM3c: run the sibling CCIS checkout's CLI as a child process. No shell, no network: files in, file out.
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

async function runCcis({ envelopeFile, outDir, at, ccisPath = process.env.CCIS_PATH, timeoutMs = 30000, demoParameters = false }) {
  if (!envelopeFile || !outDir) throw new Error('envelopeFile and outDir are required.');
  if (!ccisPath) throw new Error('CCIS_PATH is not set (folder of the CCIS checkout).');
  if (!AT.test(String(at))) throw new Error('at must be an ISO date-time with a Z or +hh:mm offset.');
  const cli = path.join(ccisPath, 'ccis-cli.js');
  if (!fs.existsSync(cli)) throw new Error(`ccis-cli.js not found in ${ccisPath}.`);

  const original = fs.readFileSync(envelopeFile);                       // the exported bytes: hashed, never changed
  const envelopeSha256 = crypto.createHash('sha256').update(original).digest('hex');
  const mapped = mapEnvelope(JSON.parse(original.toString('utf8')));    // throws on anything unknown
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(envelopeFile).replace(/\.json$/, '');
  const mappedFile = path.join(outDir, `${base}.ccis-input.json`);
  const rawFile = path.join(outDir, `${base}.ccis-raw.json`);
  const recordPath = path.join(outDir, `${base}.run-record.json`);
  fs.writeFileSync(mappedFile, JSON.stringify(mapped, null, 2) + '\n');

  const args = [cli, 'run', '--envelope', mappedFile, '--out', rawFile, '--at', at];
  if (demoParameters) args.push('--demo-parameters');
  await new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: ccisPath, env: { PATH: process.env.PATH }, timeout: timeoutMs, shell: false }, (err, _out, stderr) => {
      if (!err) return resolve();
      const why = err.killed ? `timed out after ${timeoutMs} ms` : `exit ${err.code}: ${String(stderr || err.message).trim().split('\n')[0]}`;
      reject(new Error(`CCIS CLI failed (${why}).`));
    });
  });
  if (!fs.existsSync(rawFile)) throw new Error('CCIS CLI wrote no record.');
  const record = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  record['x-envelopeSha256'] = envelopeSha256;                          // the hand-off extension DM2a needs (CCIS gap G-05)
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  return { recordPath, record, status: record.status, envelopeSha256 };
}

// Row DM3d: import the final run record through the DM2a route. The file text is sent as it is (never parsed and rewritten),
// so the server stores and hashes exactly what is on disk. Safe to repeat: the same record gives `alreadyImported`.
async function importRun({ base, username, password, caseId, recordPath }) {
  if (!/^\d{1,9}$/.test(String(caseId))) throw new Error('caseId must be a number.');
  if (!recordPath) throw new Error('recordPath is required.');
  const cookie = await login(base, username, password);
  const res = await fetch(`${base}/api/cases/${caseId}/ccis-runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-emr': '1', cookie }, body: fs.readFileSync(recordPath) });
  let body = null; try { body = await res.json(); } catch (_) { /* no body */ }
  if (res.status !== 200 && res.status !== 201) {
    const first = body && Array.isArray(body.errors) && body.errors[0] ? ` (${body.errors[0].path}: ${body.errors[0].message})` : '';
    throw new Error(`Import failed (${res.status}): ${(body && (body.message || body.error)) || 'no message'}${first}`);
  }
  return { runId: body.run.id, status: body.run.status, alreadyImported: !!body.alreadyImported, httpStatus: res.status };
}

// Export, run, import: what `npm run demo:run -- <case id>` does.
async function runDemo({ base, username = 'doctor1', password, caseId, outDir, at = new Date().toISOString(), ccisPath, demoParameters = false, timeoutMs }) {
  const exp = await exportEnvelope({ base, username, password, caseId, outDir });
  const run = await runCcis({ envelopeFile: exp.path, outDir, at, ccisPath, demoParameters, ...(timeoutMs ? { timeoutMs } : {}) });
  const imp = await importRun({ base, username, password, caseId, recordPath: run.recordPath });
  return { envelopePath: exp.path, envelopeSha256: exp.sha256, recordPath: run.recordPath, ...imp };
}

module.exports = { exportEnvelope, runCcis, importRun, runDemo };

if (require.main === module) {
  (async () => {
    const caseId = process.argv.slice(2).find(a => !a.startsWith('--'));
    if (!caseId) throw new Error('Usage: npm run demo:run -- <case id> [--demo-parameters]   (the server must be running)');
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('Set SEED_PASSWORD in .env (the password the demo users were created with).');
    const base = process.env.DEMO_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
    const r = await runDemo({ base, username: process.env.DEMO_USER || 'doctor1', password, caseId, outDir: process.env.DEMO_OUT_DIR || 'demo-out', demoParameters: process.argv.includes('--demo-parameters') });
    console.log(r.alreadyImported ? `Already imported: run ${r.runId} (${r.status}).` : `Imported run ${r.runId} (${r.status}). Open case ${caseId} in the page to see it.`);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
