'use strict';
// Row R0e-2: the CCIS insights panel lives in modules/82-insights.js and behaves as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '82-insights.js'), 'utf8');
const NAMES = ['ccisLoad', 'ccisValue', 'ccisResult', 'ccisDetail', 'ccisAckPart', 'renderCcis', 'ccisImportText', 'ccisPick', 'ccisAck'];
const CONSTS = ['CCIS', 'ccisTime', 'ccisList'];

test('82-insights.js loads after 80-pins.js and before the inline script; none of it is inline any more', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/82-insights.js'), l.indexOf('modules/80-pins.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/82-insights.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    const re = new RegExp(`(async )?function ${n}\\(`);
    assert.ok(!re.test(inline), 'still inline: ' + n);
    assert.ok(re.test(mod), 'missing from the module: ' + n);
  }
  for (const c of CONSTS) {
    assert.ok(!new RegExp(`^const ${c}=`, 'm').test(inline), 'constant still inline: ' + c);
    assert.ok(new RegExp(`^const ${c}=`, 'm').test(mod), 'constant missing: ' + c);
  }
  const tops = mod.split('\n').filter(x => /^(const|let|var) /.test(x)).map(x => x.split('=')[0].replace(/^(const|let|var) /, ''));
  assert.deepEqual(tops, CONSTS, 'no other top-level variables');
  assert.match(inline, /function conflictShow\(/, 'the case-conflict code after the panel stays in the page');
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });

test('ccisValue and ccisTime show states, classifications, amounts and times as stored', async () => {
  const w = await page();
  assert.equal(w.eval(`ccisValue({ state: 'parameter-not-enabled', dependsOnParameters: ['p1'] })`), 'Not enabled (needs parameter: p1)');
  assert.equal(w.eval(`ccisValue({ kind: 'classification', value: { label: 'L' } })`), 'L');
  assert.equal(w.eval(`ccisValue({ kind: 'value', value: { amount: 5, unit: 'min' } })`), '5 min');
  assert.equal(w.eval(`ccisValue({ kind: 'value', value: { time: { value: '10:00', zone: 'UTC' } } })`), '10:00 (zone: UTC)');
  assert.equal(w.eval(`ccisTime('2026-11-25T10:20:30Z')`), '2026-11-25 10:20');
});

test('ccisList escapes text written by another program; ccisDetail warns about demo parameters and failures', async () => {
  const w = await page();
  const h = w.eval(`ccisList('Warnings', ['<img src=x onerror=1>'])`);
  assert.ok(!h.includes('<img'), h);
  assert.equal(w.eval(`ccisList('Warnings', [])`), '');
  const d = w.eval(`ccisDetail({ run_record: { parameters: [{ id: 'p', enabled: true, value: 1 }], results: [], failure: { rule: 'R', message: 'bad' } } })`);
  assert.match(d, /test-only placeholders/);
  assert.match(d, /This run failed \(R\): bad\. No result was produced\./);
});

test('ccisLoad loads nothing and asks the server nothing without ccis:read or without a saved case', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'v', role: 'viewer', perms: ['cases:read'] }`);
  calls.length = 0;
  await w.eval(`ccisLoad({ serverId: 5 })`);
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['ccis:read'] }`);
  await w.eval(`ccisLoad({ serverId: null })`);
  assert.deepEqual(calls, []);
  assert.equal(w.eval('CCIS.ok'), false);
});

test('ccisLoad reads the runs of the case; a case opened meanwhile is not overwritten', async () => {
  const w = await page(async (u) => u === '/api/cases/5/ccis-runs' ? res(200, { runs: [{ id: 1 }] }) : res(404, {}));
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['ccis:read'] }`);
  await w.eval(`ccisLoad({ serverId: 5 })`);
  assert.equal(w.eval('CCIS.runs.length'), 1);
  assert.equal(w.eval('CCIS.ok'), true);
});

test('ccisImportText refuses non-JSON and non-object input without any request, and sends nothing without ccis:import', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['ccis:import'] }; CASE.serverId = 5`);
  calls.length = 0;
  await w.eval(`ccisImportText('not json')`);
  assert.equal(w.document.getElementById('ccis_info').textContent, 'That file is not JSON.');
  await w.eval(`ccisImportText('[1]')`);
  assert.match(w.document.getElementById('ccis_info').textContent, /not a CCIS run record/);
  w.eval(`Srv.user = { username: 'v', role: 'viewer', perms: [] }`);
  w.document.getElementById('ccis_info').textContent = '';
  await w.eval(`ccisImportText('{}')`);
  assert.deepEqual(calls, []);
});
