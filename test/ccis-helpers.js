'use strict';
// Shared by ccis-runs.test.js and safety-routes.test.js (DM2a): a case with a real envelope export, and run records made from a CCIS fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { caseRef } = require('../envelope');

const SECRET = 'test-secret-test-secret-test-secret-1234';
const fixture = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ccis', f), 'utf8'));
let n = 0;

// Registers a patient, opens a case and exports its envelope through the real route. Returns the case id, its reference and the export hash.
async function caseWithExport(doctor, pool) {
  const k = ++n;
  const p = await doctor.post('/api/patients', { name: 'Ccis Patient ' + k, mrn: `CCIS-${k}-${process.pid}`, dob: '1980-01-01', sex: 'F' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const c = await doctor.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'CCIS case ' + k });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const caseId = c.body.case.id;
  return { caseId, ...(await exportEnvelope(doctor, pool, caseId)) };
}
async function exportEnvelope(doctor, pool, caseId) {
  const e = await doctor.get(`/api/cases/${caseId}/context`);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const sha = (await pool.query('SELECT envelope_sha256 FROM context_exports WHERE case_id = $1 ORDER BY id DESC LIMIT 1', [caseId])).rows[0].envelope_sha256;
  return { ref: caseRef(SECRET, caseId), sha };
}
// A valid CCIS run record that names this case and this export. `edit` may change it; `name` picks the fixture.
function runRecord({ ref, sha }, edit, name = 'run-record-good-completed.json') {
  const r = fixture(name);
  r.id = 'run-synthetic-' + String(++n).padStart(4, '0');
  r.snapshot.case = { ref };
  r['x-envelopeSha256'] = sha;
  if (edit) edit(r);
  return r;
}
module.exports = { SECRET, fixture, caseWithExport, exportEnvelope, runRecord };
