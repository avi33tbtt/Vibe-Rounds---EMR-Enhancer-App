'use strict';
// Row R0a: the page loads code from modules/ under the CSP, and the tests can see that code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { setup } = require('./helpers');
const { pageHtml, pageSource, localScripts } = require('./html');

const get = (base, p) => fetch(base + p, { headers: { 'x-emr': '1' } });
const nonceOf = csp => /'nonce-([^']+)'/.exec(csp)[1];

test('the page loads modules/00-boot.js (classic script, relative src) before the inline script', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
  assert.deepEqual(localScripts().slice(0, 2), ['sdc.js', 'modules/00-boot.js']);   // later rows add more modules after these
  assert.ok(raw.indexOf('modules/00-boot.js') < raw.indexOf('<script>'), 'module comes before the inline script');
  assert.ok(!/type="module"/.test(raw), 'no ES modules: the page must work from file://');
  assert.ok(!/const \$=i=>/.test(raw), 'the helpers live in the module only');
});

test('pageSource() includes module code; pageHtml() inlines it and the helpers still work in the page', async () => {
  assert.match(pageSource(), /const tg=id=>/);
  assert.ok(!/<script src="modules\//.test(pageHtml()), 'no local src tag is left in the test page');
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = async () => { throw new Error('offline'); }; w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));   // same start-up wait as the other page tests
  const w = dom.window;
  assert.equal(typeof w.eval('$'), 'function');
  w.eval('toast("hello")');
  assert.equal(w.document.getElementById('toast').textContent, 'hello');
  w.eval('tg("setPanel")');
  assert.equal(w.document.getElementById('setPanel').style.display, 'block');
});

test('GET /modules/00-boot.js is served as JavaScript with the CSP; the page tag carries the nonce', async () => {
  const { base, close } = await setup();
  try {
    const r = await get(base, '/modules/00-boot.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('content-security-policy'));
    assert.equal(await r.text(), fs.readFileSync(path.join(__dirname, '..', 'modules', '00-boot.js'), 'utf8'));
    const page = await get(base, '/');
    const nonce = nonceOf(page.headers.get('content-security-policy'));
    const tag = (await page.text()).match(/<script\b[^>]*modules\/00-boot\.js[^>]*>/)[0];
    assert.ok(tag.includes(`nonce="${nonce}"`));
  } finally { await close(); }
});

test('only plain .js names inside modules/ are served: traversal, other files and unknown names give 404', async () => {
  const { base, close } = await setup();
  try {
    for (const p of ['/modules/nope.js', '/modules/app.js', '/modules/package-lock.json', '/modules/00-boot.txt', '/modules/..%2Fapp.js', '/modules/%2e%2e%2fpackage.json', '/modules/.hidden.js', '/modules/00-boot.js/x', '/modules/']) {
      const r = await get(base, p);
      assert.equal(r.status, 404, p);
      assert.ok(!(await r.text()).includes('require('), 'no source leaked: ' + p);
    }
  } finally { await close(); }
});
