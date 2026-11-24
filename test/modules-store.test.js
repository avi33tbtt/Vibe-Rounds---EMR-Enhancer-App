'use strict';
// Row R0b-2: the storage adapter lives in modules/30-store.js, loads after the session module, and behaves as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '30-store.js'), 'utf8');

test('30-store.js loads after 20-session.js and before the inline script; the page no longer defines the adapter', () => {
  const l = localScripts();
  assert.ok(l.indexOf('modules/30-store.js') === l.indexOf('modules/20-session.js') + 1, 'order: ' + l.join(', '));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const re of [/const srvMode=/, /const Store=\{/, /function interimRead\(/, /function interimWrite\(/, /function fromRow\(/, /function storeEnter\(/, /function storeLeave\(/, /function storeFlush\(/, /async function doFlush\(/, /async function storeLoadCases\(/, /const CASE_PATIENT_CAP=/, /const blankCase=/]) {
    assert.ok(!re.test(inline), 'still inline: ' + re);
    assert.ok(re.test(mod), 'missing from the module: ' + re);
  }
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}

test('signed out the adapter is in local mode; fromRow maps a server row and keeps local values from the old object', async () => {
  const w = await page();
  assert.equal(w.eval('srvMode()'), false);
  const c = JSON.parse(w.eval(`JSON.stringify(fromRow({id:7,row_version:3,title:'T',status:'archived',patient_id:2,created_at:'a',updated_at:'b'},{narrative:'n',narrativeSent:'n',applied:[1],values:{x:1},notes:[2]}))`));
  assert.equal(c.id, 's7'); assert.equal(c.serverId, 7); assert.equal(c.rowVersion, 3); assert.equal(c.status, 'archived');
  assert.deepEqual(c.applied, [1]); assert.equal(c.narrative, 'n');
  assert.equal(w.eval(`fromRow({id:1,status:'open'}).narrative`), '');
});

test('interim storage keeps only custom sets and the import record under vr_interim (no case data)', async () => {
  const w = await page();
  w.eval(`Srv.user={username:'u',perms:[]}`);
  w.eval(`interimWrite({k:1})`);
  const saved = JSON.parse(w.localStorage.getItem('vr_interim'));
  assert.deepEqual(Object.keys(saved).sort(), ['_temporary', 'customs', 'imported']);
  assert.deepEqual(saved.imported, { k: 1 });
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(interimRead().imported)')), { k: 1 });
  assert.equal(w.localStorage.getItem('vr_traj'), null, 'signed in: vr_traj is never written');
});

test('storeEnter/storeLeave switch between server and demo cases; storeFlush with nothing dirty is a no-op', async () => {
  const w = await page();
  w.eval(`Srv.user={username:'u',perms:[]}; storeEnter()`);
  assert.equal(w.eval('CASES.length'), 0);
  assert.equal(w.eval('CASE.unsaved'), true);
  assert.equal(await w.eval('storeFlush()'), true);
  w.eval(`Srv.user=null; storeLeave()`);
  assert.ok(w.eval('CASES.length') >= 1, 'demo cases are back');
  assert.equal(w.eval('srvMode()'), false);
});
