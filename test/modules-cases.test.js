'use strict';
// Row R0c-2: the cases list and server case helpers live in modules/50-cases.js and behave as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '50-cases.js'), 'utf8');
const NAMES = ['newCase', 'openCase', 'openCaseLocal', 'archiveCase', 'restoreCase', 'renderCases', 'casesShow', 'openCaseSrv', 'ptOpenCaseSrv', 'newCaseSrv', 'opSend', 'opRun', 'caseSaveMeta', 'archiveCaseSrv', 'restoreCaseSrv', 'renderSrvCase'];

test('50-cases.js loads after 40-patients.js and before the inline script; none of its functions is inline any more', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/50-cases.js'), l.indexOf('modules/40-patients.js') + 1, l.join(', '));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    const re = new RegExp(`(async )?function ${n}\\(`);
    assert.ok(!re.test(inline), 'still inline: ' + n);
    assert.ok(re.test(mod), 'missing from the module: ' + n);
  }
  assert.ok(!/const caseTitleNow=|const EDITABLE_STATUS=/.test(inline), 'constants moved too');
  const tops = mod.split('\n').filter(l => /^(const|let|var) /.test(l)).map(l => l.split('=')[0].replace(/^(const|let|var) /, ''));
  assert.deepEqual(tops, ['caseTitleNow', 'EDITABLE_STATUS'], 'only these two top-level variables, both read at call time');
  assert.match(inline, /async function ctxDownload\(/, 'the context download stays in the page (R0e)');
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const ROW = (id, extra = {}) => ({ id, patient_id: 5, title: 'T' + id, status: 'active', row_version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra });

test('signed out: newCase adds a local case, archiveCase archives it and opens another, restoreCase brings it back', async () => {
  const w = await page();
  const n0 = w.eval('CASES.length');
  w.eval('newCase()');
  assert.equal(w.eval('CASES.length'), n0 + 1);
  const id = w.eval('CASE.id');
  w.eval('archiveCase()');
  assert.equal(w.eval(`CASES.find(c => c.id === '${id}').status`), 'archived');
  assert.notEqual(w.eval('CASE.id'), id, 'another case is open');
  w.eval(`restoreCase('${id}')`);
  assert.equal(w.eval(`CASES.find(c => c.id === '${id}').status`), 'open');
  assert.equal(w.eval('CASES.length'), n0 + 1, 'nothing was deleted');
});

test('signed in: newCaseSrv needs an open patient and the write permission, and sends no request without them', async () => {
  const calls = [];
  const w = await page(async (u, o) => { calls.push((o && o.method || 'GET') + ' ' + u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:read'] }; CASE = blankCase()`);
  await w.eval('newCaseSrv()');
  assert.match(w.document.getElementById('toast').textContent, /Open a patient on the Patients tab first/);
  w.eval(`CASE.patientId = 5`);
  await w.eval('newCaseSrv()');
  assert.match(w.document.getElementById('toast').textContent, /role cannot create cases/);
  assert.ok(!calls.some(c => c.startsWith('POST')), 'no POST: ' + calls.join(', '));
});

test('signed in: newCaseSrv posts to the patient\'s cases and adds the server case', async () => {
  const calls = [];
  const w = await page(async (u, o) => {
    const m = (o && o.method) || 'GET'; calls.push(m + ' ' + u);
    if (m === 'POST' && u === '/api/patients/5/cases') return res(201, { case: ROW(11) });
    if (u === '/api/cases/11') return res(200, { case: ROW(11), narrative: null });
    return res(404, {});
  });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:read', 'cases:write'] }; CASE = blankCase(); CASE.patientId = 5`);
  await w.eval('newCaseSrv()');
  assert.ok(calls.includes('POST /api/patients/5/cases'), calls.join(', '));
  assert.equal(w.eval(`CASES.some(c => c.serverId === 11)`), true);
});

test('a 409 version conflict stops the change: opRun returns false, shows the conflict screen, and the case is not overwritten', async () => {
  const calls = [];
  const w = await page(async (u, o) => {
    const m = (o && o.method) || 'GET'; calls.push(m + ' ' + u);
    if (m === 'PATCH') return res(409, { error: 'version_conflict' });
    if (u === '/api/cases/3') return res(200, { case: ROW(3, { row_version: 2, title: 'Server title' }), narrative: null });
    return res(404, {});
  });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:read', 'cases:write'] }; CASES = [fromRow(${JSON.stringify(ROW(3))})]; CASE = CASES[0]`);
  const ok = await w.eval(`opRun(CASE, { op: 'meta', title: 'Mine', status: 'active' })`);
  assert.equal(ok, false);
  assert.equal(w.eval('CASE.title'), 'T3', 'local case not changed by the refused write');
  assert.equal(calls.filter(c => c.startsWith('PATCH')).length, 1, 'the write was not retried');
  assert.notEqual(w.eval('Store.conflict'), null, 'conflict state is set');
});
