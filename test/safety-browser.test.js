'use strict';
// Chunk 05, check 8: ONE smoke test in a real browser (Chrome, driven by playwright-core).
//   sign in -> open a patient's case -> enter a value -> build and download the FHIR export
// Everything else in the pack runs in jsdom; this is the one place the real page meets a real browser engine,
// against the real server and PostgreSQL.
//
// Needs Google Chrome (GitHub's ubuntu runners have it). Set CHROME_PATH to use a different binary.
// Without a browser: the test is skipped on your machine, and FAILS when CI=true or SAFETY_REQUIRE_BROWSER=1,
// so the pipeline can never go green by quietly skipping it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { setup, client, PW } = require('./helpers');

const MUST_RUN = process.env.CI === 'true' || process.env.SAFETY_REQUIRE_BROWSER === '1';

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { /* reported below */ }

let env, browser, launchError;
test.before(async () => {
  env = await setup();
  try {
    if (!chromium) throw new Error('playwright-core is not installed (run npm install)');
    const args = ['--no-sandbox', '--disable-dev-shm-usage'];
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true, args } : { channel: 'chrome', headless: true, args });
  } catch (e) { launchError = e; }
});
test.after(async () => { if (browser) await browser.close(); await env.close(); });

test('browser smoke: sign in, open a case, enter a value, export the FHIR bundle', async t => {
  if (!browser) {
    if (MUST_RUN) assert.fail('No browser available but one is required here: ' + (launchError && launchError.message));
    return t.skip('no Chrome found (' + (launchError && launchError.message.split('\n')[0]) + ')');
  }

  // a registered patient to open (registration itself is covered by the API and page tests)
  const api = client(env.base); assert.equal((await api.login('nurse1')).status, 200);
  assert.equal((await api.post('/api/patients', { name: 'Smoke Patient', mrn: 'SMOKE-1', dob: '1980-06-15', sex: 'F' })).status, 201);

  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });
  page.setDefaultTimeout(10000);

  // 1. the app opens, signed out
  await page.goto(env.base + '/');
  await page.locator('[data-t=patients]').click();
  await page.locator('#lg_u').waitFor();
  assert.match(await page.locator('#who').innerText(), /Not signed in/);

  // 2. sign in as a real user (server session cookie)
  await page.fill('#lg_u', 'nurse1');
  await page.fill('#lg_p', PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#who', { hasText: 'nurse1 (nurse)' }).waitFor();

  // 3. open the patient's case: the banner shows the server's identity for them
  const row = page.locator('#ptList .item', { hasText: 'Smoke Patient' });
  await row.waitFor();
  await row.getByRole('button', { name: 'Open case' }).click();
  await page.locator('#pbanner', { hasText: 'SMOKE-1' }).waitFor();
  assert.match(await page.locator('#pbanner').innerText(), /Smoke Patient/);
  assert.ok(await page.locator('#case').evaluate(el => el.classList.contains('on')), 'the Case screen is showing');

  // 4. apply a set and enter a value (heart rate 88)
  await page.locator('#elementList .item', { hasText: 'Vitals' }).first().click();
  await page.locator('#new_hr').waitFor();
  await page.fill('#new_hr', '88');
  await page.locator('.rep-add:has(#new_hr)').getByRole('button', { name: 'Add' }).click();
  await page.locator('.rep-table td', { hasText: /^88$/ }).first().waitFor();

  // 5. export: build the bundle and download it
  await page.locator('[data-t=codes]').click();
  await page.getByRole('button', { name: 'Build bundle' }).click();
  await page.locator('#bj', { hasText: 'Bundle' }).waitFor();
  const bundle = JSON.parse(await page.locator('#bj').innerText());
  assert.equal(bundle.resourceType, 'Bundle');
  const types = bundle.entry.map(e => e.resource.resourceType);
  for (const need of ['Patient', 'Observation', 'Composition', 'Provenance']) assert.ok(types.includes(need), `bundle has ${need}: ${types.join()}`);
  const hr = bundle.entry.map(e => e.resource).find(r => r.resourceType === 'Observation' && r.code.text === 'Heart rate');
  assert.ok(hr, 'the Heart rate Observation is in the bundle');
  assert.equal(hr.valueQuantity.value, 88);
  assert.equal(hr.code.coding, undefined, 'the code was never verified, so it is text only');
  assert.match(await page.locator('#bchk').innerText(), /structural check: passed/);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  assert.equal(dl.suggestedFilename(), 'bundle.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(await dl.path(), 'utf8')), bundle, 'the downloaded file is the bundle that was built');

  // the server saw all of it: a real session, a patient view, no denial
  const audit = (await env.pool.query(`SELECT action, username FROM audit_log WHERE username = 'nurse1'`)).rows.map(r => r.action);
  assert.ok(audit.includes('login') && audit.includes('patient.search'), audit.join());
  assert.ok(!audit.includes('permission.denied'));

  assert.deepEqual(problems, [], 'no script errors in the browser');
  await ctx.close();
});
