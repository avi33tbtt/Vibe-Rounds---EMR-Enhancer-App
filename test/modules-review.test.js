'use strict';
// Row R0d-2: set versions (8d-2) and the reviewer queue (8d-1) live in modules/70-review.js and behave as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '70-review.js'), 'utf8');
const NAMES = ['verLoad', 'verFindings', 'renderVers', 'verSubmit', 'renderReviewNav', 'reviewLoad', 'renderReview', 'reviewDecide'];
const CONSTS = ['VER', 'VER_LBL', 'VER_NOTE', 'verTier', 'REV', 'revT'];

test('70-review.js loads after 60-library.js and before the inline script; none of it is inline any more', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/70-review.js'), l.indexOf('modules/60-library.js') + 1, l.join(', '));
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
  assert.ok(!/<script[^>]*>[^<]*Reviewer queue \(8d-1\)/.test(inline) && !/Reviewer queue \(8d-1\)/.test(inline), 'section comment moved too');
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });

test('verTier maps approved, published and retired to the reviewed badge and the rest to draft', async () => {
  const w = await page();
  const r = JSON.parse(w.eval(`JSON.stringify(['draft','in_review','rejected','reviewed','published','retired'].map(verTier))`));
  assert.deepEqual(r, ['local draft', 'local draft', 'local draft', 'local reviewed', 'local reviewed', 'local reviewed']);
});

test('verLoad without sets:read loads nothing and asks the server nothing', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'v', role: 'viewer', perms: ['cases:read'] }`);
  calls.length = 0;
  await w.eval('verLoad()');
  assert.deepEqual(calls, []);
  assert.equal(w.eval('VER.loaded'), false);
});

test('verLoad lists every version of every set; verSubmit sends nothing but the request and shows lint findings', async () => {
  const calls = [];
  const w = await page(async (u, o) => {
    calls.push((o && o.method || 'GET') + ' ' + u + (o && o.body ? ' ' + o.body : ''));
    if (u === '/api/element-sets') return res(200, { sets: [{ id: 1, slug: 's1', title: 'S1' }] });
    if (u === '/api/element-sets/1') return res(200, { versions: [{ version: 1, status: 'draft' }, { version: 2, status: 'published' }] });
    if (u === '/api/element-sets/1/versions/1/submit') return res(200, { review: { lint: { findings: [{ severity: 'warn', rule: 'r1', path: 'p', message: '<b>x</b>' }] } } });
    return res(404, {});
  });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['sets:read', 'sets:submit'] }`);
  await w.eval('verLoad()');
  assert.equal(w.eval('VER.items.length'), 2);
  await w.eval(`verSubmit('1:1')`);
  const sub = calls.find(c => c.includes('/submit'));
  assert.equal(sub, 'POST /api/element-sets/1/versions/1/submit {}');
  assert.equal(w.eval(`VER.lint['1:1'].length`), 1);
  const html = w.eval(`verFindings(VER.lint['1:1'])`);
  assert.ok(!html.includes('<b>x</b>'), 'finding text is escaped');
});

test('verSubmit ignores a malformed key and does nothing without sets:submit (no confirm, no request)', async () => {
  const calls = []; let asked = 0;
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.confirm = () => { asked++; return true; };
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['sets:read'] }`);
  calls.length = 0;
  await w.eval(`verSubmit('1:1')`); await w.eval(`verSubmit('x')`);
  assert.equal(asked, 0); assert.deepEqual(calls, []);
});

test('renderReviewNav hides the Review tab without sets:review; reviewLoad asks the server nothing then', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'n', role: 'nurse', perms: ['cases:read'] }`);
  w.eval('renderReviewNav()');
  assert.equal(w.document.getElementById('navReview').style.display, 'none');
  calls.length = 0;
  await w.eval('reviewLoad()');
  assert.deepEqual(calls, []);
  w.eval(`Srv.user = { username: 'i', role: 'informatician', perms: ['sets:review'] }`);
  w.eval('renderReviewNav()');
  assert.equal(w.document.getElementById('navReview').style.display, '');
});

test('reviewLoad reads the queue and each version review; renderReview blocks reviewing your own version', async () => {
  const calls = [];
  const w = await page(async (u) => {
    calls.push(u);
    if (u === '/api/review-queue') return res(200, { queue: [{ set_id: 1, version: 3, slug: 's', title: 'T', created_by: 'me', submitted_by: 'x', submitted_at: '2026-11-25T10:00:00Z', lint: { findings: [] } }] });
    if (u === '/api/element-sets/1/versions/3/review') return res(200, { reviews: [], approvalsNeeded: 1 });
    return res(404, {});
  });
  w.eval(`Srv.user = { username: 'me', role: 'informatician', perms: ['sets:review'] }`);
  await w.eval('reviewLoad()');
  assert.deepEqual(calls.slice(-2), ['/api/review-queue', '/api/element-sets/1/versions/3/review']);
  assert.match(w.document.getElementById('reviewBox').innerHTML, /cannot review it/);
  assert.ok(!/data-act="reviewApprove"/.test(w.document.getElementById('reviewBox').innerHTML), 'no Approve button on your own version');
});

test('reviewDecide needs a reason (no request, no confirm) and ignores a malformed key', async () => {
  const calls = []; let asked = 0;
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.confirm = () => { asked++; return true; };
  w.eval(`Srv.user = { username: 'i', role: 'informatician', perms: ['sets:review'] }`);
  w.eval(`REV.items = [{ set_id: 1, version: 3, slug: 's', title: 'T', created_by: 'a', submitted_by: 'b', submitted_at: '', reviews: [], needed: 1 }]; renderReview()`);
  calls.length = 0;
  await w.eval(`reviewDecide('approve', '1:3')`); await w.eval(`reviewDecide('approve', 'bad')`);
  assert.equal(asked, 0); assert.deepEqual(calls, []);
  assert.equal(w.eval(`REV.err['1:3']`), 'A reason is required.');
});
