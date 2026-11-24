'use strict';
// Row R0b-1: the escaper and the session/API block live in modules/, load in order, and behave as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = f => fs.readFileSync(path.join(__dirname, '..', 'modules', f), 'utf8');

test('the modules load in order, before the inline script, and the page no longer defines them inline', () => {
  assert.deepEqual(localScripts().slice(0, 4), ['sdc.js', 'modules/00-boot.js', 'modules/10-escape.js', 'modules/20-session.js']);   // R0b-2 adds 30-store after these (see modules-store.test.js)
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const re of [/function escA\(/, /function jsA\(/, /const Srv=/, /async function api\(/, /const apiMsg=/, /const srvCan=/, /const user=\(\)=>/]) {
    assert.ok(!re.test(inline), 'still inline: ' + re);
  }
  assert.match(mod('10-escape.js'), /function escA\(/);
  assert.match(mod('20-session.js'), /const Srv=/);
  assert.match(mod('20-session.js'), /async function api\(/);
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}

test('escA escapes both quote kinds and angle brackets; jsA gives an attribute-safe string literal', async () => {
  const w = await page();
  assert.equal(w.eval(`escA('<a href="x" onclick=\\'y\\'>&')`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.equal(w.eval('escA(null)'), '');
  assert.equal(w.eval(`jsA('a"b')`), '&quot;a\\&quot;b&quot;');
});

test('api(): offline error when the network fails; a 401 while signed in clears the session', async () => {
  let w = await page();
  assert.deepEqual(JSON.parse(await w.eval(`api('GET','/api/x').then(r => JSON.stringify(r))`)), { status: 0, body: { error: 'offline', message: 'Cannot reach the server.' } });
  w = await page(async () => ({ status: 401, json: async () => ({ error: 'unauthenticated' }) }));
  w.eval(`Srv.user = { username: 'u', role: 'doctor', perms: ['cases:read'] }; Srv.pts = { 1: { name: 'N' } }`);
  assert.equal(w.eval('user()'), 'u');
  assert.equal(w.eval(`srvCan('cases:read')`), true);
  const r = JSON.parse(await w.eval(`api('GET','/api/cases/1').then(r => JSON.stringify(r))`));
  assert.equal(r.status, 401);
  assert.equal(w.eval('Srv.user'), null, 'session cleared on 401');
  assert.equal(w.eval('user()'), '');
  assert.equal(w.eval(`apiMsg({ status: 403, body: {} })`), 'Your role does not have permission for this action.');
});
