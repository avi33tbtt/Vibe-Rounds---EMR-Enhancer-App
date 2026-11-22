'use strict';
// Chunk 06d-1: Content-Security-Policy with a per-response nonce (server half).
// 6d-2a to 6d-2c convert the inline on*="" handlers; 6d-2c then removes the temporary script-src-attr rule pinned below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const MUST_RUN = process.env.CI === 'true' || process.env.SAFETY_REQUIRE_BROWSER === '1';
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { /* reported below */ }

const get = (base, p) => fetch(base + p, { headers: { 'x-emr': '1' } });
const directives = csp => Object.fromEntries(csp.split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
const nonceOf = csp => /'nonce-([^']+)'/.exec(csp)[1];

test('CSP is on page, script and API responses with the required directives', async () => {
  const { base, close } = await setup();
  try {
    for (const p of ['/', '/emr-enhancer.html', '/sdc.js', '/api/me', '/api/nope']) {
      const csp = (await get(base, p)).headers.get('content-security-policy');
      assert.ok(csp, 'CSP missing on ' + p);
      const d = directives(csp);
      assert.deepEqual(d['default-src'], ["'self'"], p);
      assert.ok(d['script-src'].includes("'self'") && d['script-src'].some(x => /^'nonce-[A-Za-z0-9+/=]{16,}'$/.test(x)), 'script-src has self + nonce ' + p);
      assert.ok(!d['script-src'].includes("'unsafe-inline'") && !d['script-src'].includes("'unsafe-eval'"), 'script-src allows no inline or eval ' + p);
      assert.deepEqual(d['object-src'], ["'none'"]); assert.deepEqual(d['base-uri'], ["'self'"]); assert.deepEqual(d['frame-ancestors'], ["'none'"]);
      assert.deepEqual(d['connect-src'], ["'self'", 'https://tx.fhir.org'], 'default terminology host');
    }
  } finally { await close(); }
});

test('the nonce differs per response and matches every <script> tag of the served page', async () => {
  const { base, close } = await setup();
  try {
    const a = await get(base, '/'), b = await get(base, '/');
    const na = nonceOf(a.headers.get('content-security-policy')), nb = nonceOf(b.headers.get('content-security-policy'));
    assert.notEqual(na, nb);
    const htmlA = await a.text();
    const src = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
    const tags = htmlA.match(/<script\b[^>]*>/g);
    assert.equal(tags.length, (src.match(/<script\b/g) || []).length, 'no script tag was lost or added');
    assert.ok(tags.length >= 2);
    for (const t of tags) assert.ok(t.includes(`nonce="${na}"`), 'tag without this response\'s nonce: ' + t);
    assert.ok(!htmlA.includes(nb), 'the other response\'s nonce is not in this page');
    assert.equal(htmlA.replace(/ nonce="[^"]+"/g, ''), src, 'the page is otherwise served unchanged');
  } finally { await close(); }
});

test('the terminology host comes from TX_HOST / opts and is reduced to an origin; junk falls back to the default', async () => {
  for (const [txHost, want] of [['https://tx.example.org/r4', 'https://tx.example.org'], ['javascript:alert(1)', 'https://tx.fhir.org'], ['not a url', 'https://tx.fhir.org']]) {
    const { base, close } = await setup({ txHost });
    try { assert.deepEqual(directives((await get(base, '/api/me')).headers.get('content-security-policy'))['connect-src'], ["'self'", want], txHost); }
    finally { await close(); }
  }
});

test('TEMPORARY rule: script-src-attr allows inline handlers until 6d-2c (this test must be changed when that row removes it)', async () => {
  const { base, close } = await setup();
  try {
    const d = directives((await get(base, '/')).headers.get('content-security-policy'));
    assert.deepEqual(d['script-src-attr'], ["'unsafe-inline'"]);
    assert.ok(/ on(click|change|input|keydown)="/.test(fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8')), 'inline handlers still exist, which is why the rule exists');
  } finally { await close(); }
});
test.todo('6d-2c: no inline on*="" handlers in the page and script-src-attr is \'none\' (flip the temporary-rule test above)');

test('real Chrome: a <script> without the nonce does not run; the page itself loads with no CSP violation', async (t) => {
  let browser;
  const env = await setup();
  try {
    if (!chromium) throw new Error('playwright-core is not installed');
    const args = ['--no-sandbox', '--disable-dev-shm-usage'];
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true, args } : { channel: 'chrome', headless: true, args });
  } catch (e) {
    await env.close();
    if (MUST_RUN) throw new Error('Browser required (CI=true) but could not start: ' + e.message);
    return t.skip('no browser: ' + e.message);
  }
  try {
    const page = await browser.newPage();
    const violations = [];
    page.on('console', m => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
    await page.goto(env.base + '/');
    await page.locator('[data-t=patients]').waitFor();
    assert.deepEqual(violations, [], 'the real page triggers no CSP violation');
    // A stored-XSS style injection: a script element with no nonce, and an external-origin one.
    const r = await page.evaluate(() => new Promise(resolve => {
      const seen = [];
      document.addEventListener('securitypolicyviolation', e => seen.push(e.violatedDirective));
      const s = document.createElement('script'); s.textContent = 'window.__pwned = 1'; document.body.appendChild(s);
      const x = document.createElement('script'); x.src = 'https://example.invalid/x.js'; document.body.appendChild(x);
      setTimeout(() => resolve({ pwned: window.__pwned === 1, seen }), 300);
    }));
    assert.equal(r.pwned, false, 'inline script without nonce must not run');
    assert.ok(r.seen.some(v => v.startsWith('script-src')), 'the browser reported the violation: ' + r.seen);
    // The page's own nonce'd script did run (the app is alive).
    assert.equal(await page.evaluate(() => typeof window.liveCheck), 'function');
  } finally { await browser.close(); await env.close(); }
});
