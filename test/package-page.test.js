'use strict';
// Task D9: Import tab section "Marketplace package" (modules/91-packages.js). Fake fetch, jsdom. Server data only: the server decides, the page shows the buttons.
// Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '91-packages.js'), 'utf8');
async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const sleep = () => new Promise(r => setTimeout(r, 20));
const ALL = ['import:write', 'sets:write'];
const P = (o = {}) => ({ id: 21, import_id: 1, key: 'set:a', kind: 'set', slug: 'a-set', body: { title: 'Alpha', definition: { title: 'Alpha' } }, blockers: [], ready: true, status: 'staged', row_version: 4, rejected_by: null, rejected_at: null, reject_reason: null, ...o });
const IMP = (o = {}) => ({ id: 1, bundle_hash: 'abcdef0123456789', summary: {}, blockers: [], concept_map: [{ concept: 'pulse-rate', owner: { set: 'a-set', field: 'hr_bpm' }, users: [], status: 'ok' }], staged_by: 'doc', staged_at: '2026-11-28T09:00:00Z',
  proposals: [P(), P({ id: 22, kind: 'pathway', slug: 'p-path', body: { title: 'Path' } }), P({ id: 23, ready: false, blockers: [{ path: '/x', code: 'type', message: 'Bad type.' }] }), P({ id: 24, status: 'accepted' }), P({ id: 25, status: 'rejected', rejected_by: 'doc', rejected_at: '2026-11-28T10:00:00Z', reject_reason: 'No' })], ...o });
const LIST = [{ id: 1, bundle_hash: 'abcdef0123456789', staged_by: 'doc', staged_at: '2026-11-28T09:00:00Z', staged_count: 3, accepted_count: 1, rejected_count: 1 }];
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { if (u === '/api/me') return res(401, {});
    const m = (opt && opt.method) || 'GET';
    calls.push({ u, m, b: opt && opt.body && JSON.parse(opt.body) });
    if (m === 'POST') return o.post ? o.post(u, calls[calls.length - 1].b) : res(200, {});
    if (u === '/api/import/packages') return res(200, { imports: o.list || LIST });
    if (/^\/api\/import\/packages\/\d+$/.test(u)) return res(200, { import: o.imp || IMP() });
    return res(404, {}); };
  return { calls, f };
}
const box = w => w.document.getElementById('packageBox').innerHTML;
const posts = s => s.calls.filter(c => c.m === 'POST');
const acts = (w, name) => [...w.document.querySelectorAll(`[data-act=${name}]`)].map(e => e.dataset.arg);
async function open(w, s, perms = ALL) { as(w, 'doc', perms); await w.eval('packagesLoad()'); await w.eval("pkgOpen('1')"); s.calls.length = 0; }

test('1. wiring: loaded before 90-wire.js, nothing inline, no storage; no fetch before a file is chosen; hidden without import:write', async () => {
  const l = localScripts();
  assert.ok(l.indexOf('modules/91-packages.js') > -1 && l.indexOf('modules/91-packages.js') < l.indexOf('modules/90-wire.js'), l.join(', '));
  assert.ok(!/\son(click|change|input)=/i.test(mod) && !/localStorage|sessionStorage/.test(mod));
  const s = server(), w = await page(s.f);
  assert.equal(s.calls.length, 0, 'no network at load');
  for (const a of ['pkgChoose', 'pkgPick', 'pkgReload', 'pkgOpen', 'pkgClose', 'pkgAccept', 'pkgReject']) assert.ok(new RegExp(a + ':').test(fs.readFileSync(path.join(__dirname, '..', 'modules', '90-wire.js'), 'utf8')), a);
  as(w, 'nurse', []); await w.eval('packagesLoad()'); assert.equal(box(w), ''); assert.equal(s.calls.length, 0);
});

test('2. a chosen file is posted once as the parsed object; a 409 with an import id opens the first copy', async () => {
  const s = server({ post: u => res(409, { error: 'already_staged', importId: 1 }) }), w = await page(s.f); as(w, 'doc', ALL);
  await w.eval(`pkgSend(${JSON.stringify(JSON.stringify({ format: 'ccis-package-bundle/1', artefacts: [] }))})`); await sleep();
  assert.equal(posts(s).length, 1); assert.deepEqual(posts(s)[0].b, { format: 'ccis-package-bundle/1', artefacts: [] }); assert.equal(posts(s)[0].u, '/api/import/packages');
  assert.ok(s.calls.some(c => c.u === '/api/import/packages/1'));
  await w.eval("pkgSend('[1]')"); await w.eval("pkgSend('nope')"); assert.equal(posts(s).length, 1, 'arrays and bad JSON are not sent');
});

test('3. list and open import render: counts, import and proposal blockers with codes, concept map', async () => {
  const s = server(), w = await page(s.f); as(w, 'doc', ALL); await w.eval('packagesLoad()');
  assert.match(box(w), /Package #1/); assert.match(box(w), /3 to review/);
  await w.eval("pkgOpen('1')"); const h = box(w);
  assert.match(h, /pulse-rate/); assert.match(h, /a-set \/ hr_bpm/); assert.match(h, /Bad type\./); assert.match(h, /Alpha/);
});

test('4. accept is offered only for a ready staged proposal with sets:write', async () => {
  const s = server(), w = await page(s.f); await open(w, s);
  assert.deepEqual(acts(w, 'pkgAccept').sort(), ['21', '22']);
  assert.deepEqual(acts(w, 'pkgReject').sort(), ['21', '22', '23']);
  assert.match(box(w), /Publish and review its sets first/);
  const s2 = server(), w2 = await page(s2.f); await open(w2, s2, ['import:write']);
  assert.deepEqual(acts(w2, 'pkgAccept'), []);
});

test('5. a set posts to /accept and a pathway to /accept-pathway, the body is exactly {rowVersion}, and the import reloads', async () => {
  const s = server(), w = await page(s.f); await open(w, s);
  await w.eval("pkgAccept('21')"); await sleep(); await w.eval("pkgAccept('22')"); await sleep();
  assert.deepEqual(posts(s).map(c => [c.u, c.b]), [['/api/import/package-proposals/21/accept', { rowVersion: 4 }], ['/api/import/package-proposals/22/accept-pathway', { rowVersion: 4 }]]);
  assert.ok(s.calls.some(c => c.m === 'GET' && c.u === '/api/import/packages/1'));
  await w.eval("pkgAccept('23')"); await w.eval("pkgAccept('24')"); assert.equal(posts(s).length, 2, 'blocked and accepted proposals are never posted');
});

test('6. a server refusal shows its message and the sets it names', async () => {
  const s = server({ post: () => res(409, { error: 'member_not_published', message: 'These sets are not published from this package yet: a-set.', sets: ['a-set'] }) }), w = await page(s.f); await open(w, s);
  await w.eval("pkgAccept('22')"); await sleep();
  assert.match(box(w), /not published from this package yet/); assert.match(box(w), /\(a-set\)/);
});

test('7. reject needs a reason; the body is {reason, rowVersion} only', async () => {
  const s = server(), w = await page(s.f); await open(w, s);
  await w.eval("pkgReject('21')"); assert.equal(posts(s).length, 0); assert.match(box(w), /A reason is required/);
  w.document.getElementById('pkg_r_21').value = 'Not needed'; await w.eval("pkgReject('21')"); await sleep();
  assert.deepEqual(posts(s).map(c => [c.u, c.b]), [['/api/import/package-proposals/21/reject', { reason: 'Not needed', rowVersion: 4 }]]);
});

test('8. hostile strings in slug, title, blockers, concepts and messages are escaped; no element or attribute is made from them', async () => {
  const bad = '<img src=x onerror=alert(1)>"><script>window.pwn=1</script>';
  const imp = IMP({ concept_map: [{ concept: bad, owner: { set: bad, field: bad }, users: [], status: bad }], blockers: [{ code: bad, message: bad }],
    proposals: [P({ slug: bad, body: { title: bad }, blockers: [{ code: bad, message: bad }], ready: false }), P({ id: 26, status: 'rejected', reject_reason: bad, rejected_by: bad })] });
  const s = server({ imp, post: () => res(409, { error: 'x', message: bad }) }), w = await page(s.f); await open(w, s);
  const h = w.document.getElementById('packageBox');
  assert.equal(h.querySelectorAll('img, script').length, 0); assert.equal(w.pwn, undefined); assert.ok(h.textContent.includes('<img src=x'));
  assert.ok(![...h.querySelectorAll('*')].some(e => [...e.attributes].some(a => /^on/i.test(a.name))));
});
