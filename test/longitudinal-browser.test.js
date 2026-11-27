'use strict';
// Row R9k: acceptance of the longitudinal explorer in a real browser (Chrome via playwright-core), against the real server and PostgreSQL.
//   sign in -> open a patient's case -> Longitudinal tab -> banner -> all history across two cases -> context switch keeps the date ->
//   details drawer -> trend chart -> nothing of another patient is ever visible.
// Needs Google Chrome (set CHROME_PATH for another binary). Without a browser the test is skipped on your machine and FAILS when
// CI=true or SAFETY_REQUIRE_BROWSER=1, like safety-browser.test.js. SYNTHETIC DEMO DATA only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, PW, reviewers, approveVersion } = require('./helpers');

const MUST_RUN = process.env.CI === 'true' || process.env.SAFETY_REQUIRE_BROWSER === '1';
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { /* reported below */ }

let env, R, admin, browser, launchError, seq = 0;
test.before(async () => {
  env = await setup(); R = await reviewers(env.base);
  admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200);
  try {
    if (!chromium) throw new Error('playwright-core is not installed (run npm install)');
    const args = ['--no-sandbox', '--disable-dev-shm-usage'];
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true, args } : { channel: 'chrome', headless: true, args });
  } catch (e) { launchError = e; }
});
test.after(async () => { if (browser) await browser.close(); await env.close(); });

const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const sets = {};
async function publishedSet(slug, field) {
  if (sets[slug]) return sets[slug];
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: { title: slug, fields: [{ id: field, label: field, type: 'number', unit: 'u' }] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return (sets[slug] = made.body.set.id);
}
// One case with the diabetes and CKD sets pinned and the given values: [slug, field, value, daysAgo].
async function mkCase(n, pid, title, vals) {
  const k = (await n.post(`/api/patients/${pid}/cases`, { title })).body.case.id, pin = {};
  for (const [slug, field] of [['dm_ctx', 'hba1c'], ['ckd_ctx', 'creat']]) {
    const a = await n.post(`/api/cases/${k}/applied-sets`, { setId: await publishedSet(slug, field), version: 1 });
    assert.equal(a.status, 201, JSON.stringify(a.body)); pin[slug] = a.body.appliedSet.id;
  }
  for (const [slug, field, value, days] of vals) {
    const r = await n.post(`/api/cases/${k}/observations`, { observations: [{ appliedSetId: pin[slug], fieldKey: field, value, unit: 'u', effectiveAt: ago(days), sourceType: 'clinician' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  return k;
}

test('browser acceptance: Longitudinal tab, banner, two cases of one patient, context switch keeps the date, drawer, trend, no other patient', async t => {
  if (!browser) {
    if (MUST_RUN) assert.fail('No browser available but one is required here: ' + (launchError && launchError.message));
    return t.skip('no Chrome found (' + (launchError && launchError.message.split('\n')[0]) + ')');
  }
  const n = client(env.base); assert.equal((await n.login('nurse1')).status, 200);
  const mk = async name => (await n.post('/api/patients', { name, mrn: 'LGB-' + (++seq), dob: '1960-01-01', sex: 'F' })).body.patient.id;
  const A = await mk('Longitudinal Browser A'), B = await mk('Longitudinal Browser B');
  await mkCase(n, A, 'A first case', [['dm_ctx', 'hba1c', 7.4, 400], ['dm_ctx', 'hba1c', 7.9, 200], ['ckd_ctx', 'creat', 2.2, 100]]);
  await mkCase(n, A, 'A second case', [['dm_ctx', 'hba1c', 8.3, 20]]);
  await mkCase(n, B, 'B case', [['dm_ctx', 'hba1c', 9.99, 50], ['ckd_ctx', 'creat', 6.66, 40]]);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });
  page.setDefaultTimeout(10000);

  await page.goto(env.base + '/');
  await page.locator('[data-t=patients]').click();
  await page.fill('#lg_u', 'nurse1'); await page.fill('#lg_p', PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#who', { hasText: 'nurse1 (nurse)' }).waitFor();
  const row = page.locator('#ptList .item', { hasText: 'Longitudinal Browser A' });
  await row.waitFor();
  await row.getByRole('button', { name: 'Open case' }).first().click();
  await page.locator('#pbanner', { hasText: 'LGB-' }).waitFor();

  // 1. the tab, the banner, everything of THIS patient from both cases, nothing of the other patient
  await page.locator('#navLongitudinal').click();
  const box = page.locator('#longitudinalBox');
  await box.getByText('SYNTHETIC DEMO DATA — NOT FOR CLINICAL USE').waitFor();
  await box.locator('.cd').first().waitFor();
  const all = await box.innerText();
  for (const v of ['7.4', '7.9', '8.3', '2.2']) assert.ok(all.includes(v), 'shows ' + v);
  assert.ok(!all.includes('9.99') && !all.includes('6.66'), 'another patient\'s values are never visible');
  assert.equal(await box.locator('.cd').count(), 4, 'one line per source row, both cases');
  assert.match(all, /Effective .* · recorded /);

  // 2. context switch: diabetes only hides the CKD value; the selected date survives
  await box.getByRole('button', { name: 'Select date' }).first().click();
  const picked = (await box.locator('#lg_date b').innerText()).trim();
  assert.match(picked, /^\d{4}-\d{2}-\d{2}$/);
  await box.getByRole('button', { name: /^Diabetes/ }).click();
  await box.locator('#lg_date', { hasText: picked }).waitFor();
  await page.waitForFunction(() => !document.getElementById('longitudinalBox').innerText.includes('2.2'));
  assert.equal(await box.locator('.cd').count(), 3);
  await box.getByRole('button', { name: /^Chronic kidney disease/ }).click();
  await page.waitForFunction(() => document.getElementById('longitudinalBox').innerText.includes('Combined view'));
  assert.equal(await box.locator('.cd').count(), 4, 'combined view: each row once');
  await box.getByRole('button', { name: /^All history/ }).click();
  await box.locator('#lg_date', { hasText: picked }).waitFor();

  // 3. detail drawer: facts and derived labels apart, source link, no causal claim
  await box.locator('.cd', { hasText: '7.9' }).getByRole('button', { name: 'Details' }).click();
  const drawer = page.locator('#lg_drawer'); await drawer.waitFor();
  const d = await drawer.innerText();
  assert.match(d, /From the record/); assert.match(d, /Worked out by this page/);
  assert.match(d, /Previous: 7\.4/); assert.match(d, /Next: 8\.3/);
  assert.match(d, /nothing here says one caused another/);
  await drawer.getByRole('button', { name: 'Close' }).click();
  await page.waitForFunction(() => !document.getElementById('lg_drawer'));

  // 4. trend chart: hba1c has three plottable points; clicking one opens its detail
  await page.selectOption('#lg_trend', 'hba1c|u');
  await page.locator('#lg_chart').waitFor();
  assert.equal(await page.locator('#lg_chart circle').count(), 3);
  await page.locator('#lg_chart circle').nth(1).click();
  await page.locator('#lg_drawer').waitFor();
  assert.match(await page.locator('#lg_drawer').innerText(), /7\.9/);

  // 5. the server saw it: audited views, and no denial
  const audit = (await env.pool.query(`SELECT action FROM audit_log WHERE username = 'nurse1'`)).rows.map(r => r.action);
  assert.ok(audit.includes('patient.longitudinal_view'), audit.join());
  assert.ok(!audit.includes('permission.denied'));
  assert.deepEqual(problems, [], 'no script errors in the browser');
  await ctx.close();
});
