'use strict';
// Row DM3a: demo bridge, step 1. SYNTHETIC DATA ONLY. Prototype, not for clinical use.
// Logs in over HTTP, asks the EMR for the context envelope of ONE case and writes the response bytes to a file, unchanged.
// The file's SHA-256 is the same hash the server logged in context_exports, so the file can be matched to its export record later.
// Later rows (DM3b to DM3d) add id mapping, the CCIS CLI child process and the import. The only link to CCIS stays files plus a child process.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

async function exportEnvelope({ base, username, password, caseId, outDir }) {
  if (!/^\d{1,9}$/.test(String(caseId))) throw new Error('caseId must be a number.');
  if (!outDir) throw new Error('outDir is required.');
  const hdr = { 'content-type': 'application/json', 'x-emr': '1' };
  const login = await fetch(base + '/api/login', { method: 'POST', headers: hdr, body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(`Login as ${username} failed (${login.status}).`);
  const sc = login.headers.get('set-cookie');
  if (!sc) throw new Error('Login gave no session cookie.');
  const cookie = sc.split(';')[0];

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

module.exports = { exportEnvelope };
