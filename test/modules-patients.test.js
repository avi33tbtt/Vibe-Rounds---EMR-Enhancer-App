'use strict';
// Row R0c-1: sign-in display, patients tab and encounters live in modules/40-patients.js and behave as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '40-patients.js'), 'utf8');
const NAMES = ['renderWho', 'srvInit', 'loadLinkedAll', 'refreshPatient', 'srvLogin', 'srvLogout', 'ptShow', 'ptDebounce', 'ptLoad', 'ptToggleForm', 'ptRegister', 'ptArchive', 'ptOpenCase', 'ptOpenCaseLocal', 'renderEncounter', 'encOpen', 'encClose'];

test('40-patients.js loads after 30-store.js and before the inline script; none of its functions is defined inline any more', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/40-patients.js'), l.indexOf('modules/30-store.js') + 1, l.join(', '));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    const re = new RegExp(`(async )?function ${n}\\(`);
    assert.ok(!re.test(inline), 'still inline: ' + n);
    assert.ok(re.test(mod), 'missing from the module: ' + n);
  }
  assert.ok(!/^(const|let|var) /m.test(mod.replace(/^\s+.*$/gm, '')), 'module has no top-level variables: it only declares functions');
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}

test('renderWho shows the signed-in user escaped, and "Not signed in" otherwise', async () => {
  const w = await page();
  assert.equal(w.document.getElementById('who').textContent.trim(), 'Not signed in');
  w.eval(`Srv.user = { username: '<b>x</b>', role: 'doctor', perms: [] }; renderWho()`);
  const who = w.document.getElementById('who');
  assert.ok(!who.querySelector('b'), 'username is escaped, not parsed as HTML');
  assert.match(who.textContent, /<b>x<\/b> \(doctor\)/);
  assert.ok(who.querySelector('[data-act=srvLogout]'));
});

test('signed in, ptLoad asks the server for patients and the list shows them escaped', async () => {
  const calls = [];
  const w = await page(async (url, o) => {
    calls.push(url);
    if (url.startsWith('/api/patients')) return { status: 200, json: async () => ({ patients: [{ id: 1, name: '<i>Test</i> Patient', mrn: 'M1', age: 30, sex: 'F', status: 'active' }] }) };
    return { status: 404, json: async () => ({}) };
  });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['patients:read'] }`);
  await w.eval('ptLoad()');
  assert.ok(calls.some(u => u.startsWith('/api/patients')), 'patients were requested: ' + calls.join(','));
  const html = w.document.body.innerHTML;
  assert.ok(!/<i>Test<\/i>/.test(html), 'patient name is escaped');
  assert.ok(html.includes('&lt;i&gt;Test&lt;/i&gt;'));
});

test('signed out, ptOpenCase(patientId) opens (or creates) a LOCAL case for that patient and makes no server call', async () => {
  const calls = [];
  const w = await page(async u => { calls.push(u); throw new Error('offline'); });
  const before = w.eval('CASES.length');
  w.eval('ptOpenCase(42)');
  assert.equal(w.eval('CASE.patientId'), 42);
  assert.equal(w.eval('CASES.length'), before + 1, 'one local case was created for patient 42');
  w.eval('ptOpenCase(42)');
  assert.equal(w.eval('CASES.length'), before + 1, 'a second call reuses it');
  assert.ok(!calls.some(u => /\/api\/patients\/\d+\/cases/.test(u)), 'no server case call when signed out');
});
