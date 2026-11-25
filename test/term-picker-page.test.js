'use strict';
// Row R2f-5b: local term picker in the Create-screen binding rows. Real page in jsdom, mocked server; no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { pageHtml, pageSource } = require('./html');

const res = (status, body) => ({ status, json: async () => body });
const T = (o = {}) => ({ id: 7, code: 'demo.fever', version: 2, display: 'Fever', category: 'finding', definition: null, status: 'published', created_at: '2026-11-25T10:00:00Z', created_by: 'doc', ...o });

async function page(terms = [T()], calls = []) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = async (u) => { calls.push(String(u)); return String(u).startsWith('/api/local-terms') ? res(200, { terms }) : res(401, {}); }; w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const as = (w, perms) => w.eval(`Srv.user = ${JSON.stringify({ username: 'doc', role: 'x', perms })}`);
const click = (w, el) => el.dispatchEvent(new w.Event('click', { bubbles: true }));
// One field with one local binding row.
function localRow(w, sys = 'local') {
  const d = w.document; w.eval('resetCreate()');
  const blk = d.querySelector('#c_fields .fblock');
  blk.querySelector('.f-id').value = 'fever'; blk.querySelector('.f-label').value = 'Fever';
  if (!blk.querySelector('.bind')) w.eval("addBindRow(document.querySelector('#c_fields .fblock'))");
  const row = blk.querySelector('.bind'), s = row.querySelector('.f-sys');
  s.value = sys; s.dispatchEvent(new w.Event('change', { bubbles: true }));
  return { blk, row };
}
const save = w => { const d = w.document; d.getElementById('c_id').value = 'pick_test'; d.getElementById('c_title').value = 'Pick test'; w.eval('saveElement()'); return JSON.parse(JSON.stringify(w.eval("REGISTRY.find(s=>s.id==='pick_test').fields[0]"))); };
const choose = async (w, row, id = '7') => { as(w, ['terms:read']); click(w, row.querySelector('.f-tp')); await new Promise(r => setTimeout(r, 30)); click(w, [...w.document.querySelectorAll('.tpick [data-act=termChoose]')].find(b => b.dataset.arg === id)); };

test('Pick term shows only on a local row; the module and wiring have no inline handlers or browser storage', async () => {
  const w = await page(); const { row } = localRow(w);
  assert.equal(row.querySelector('.f-tp').style.display, '');
  const s = row.querySelector('.f-sys'); s.value = 'snomed'; s.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(row.querySelector('.f-tp').style.display, 'none');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', '75-terms.js'), 'utf8');
  assert.ok(!/\son(click|change|input)=/i.test(src) && !/localStorage|sessionStorage/.test(src));
  assert.ok(/termPick:/.test(pageSource()));
});

test('the list asks the server for PUBLISHED terms only and never offers another status; hostile text is escaped', async () => {
  const calls = []; const w = await page([T(), T({ id: 8, code: 'demo.x', display: 'Draft one', status: 'draft' }), T({ id: 9, code: 'demo.y', display: '<img src=x onerror=alert(1)>' })], calls);
  const { row } = localRow(w); as(w, ['terms:read']);
  click(w, row.querySelector('.f-tp')); await new Promise(r => setTimeout(r, 30));
  assert.ok(calls.some(u => u.includes('/api/local-terms?status=published')), calls.join());
  const box = w.document.querySelector('.tpick');
  assert.ok(box.textContent.includes('Fever') && !box.textContent.includes('Draft one'));
  assert.equal(box.querySelector('img'), null); assert.ok(box.innerHTML.includes('&lt;img'));
});

test('no request without terms:read or when the row is not local; the second click closes the list', async () => {
  const calls = []; const w = await page([T()], calls);
  const { row } = localRow(w); as(w, ['cases:read']);
  click(w, row.querySelector('.f-tp')); await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(calls.filter(u => u.startsWith('/api/local-terms')), []);
  as(w, ['terms:read']); click(w, row.querySelector('.f-tp')); await new Promise(r => setTimeout(r, 30));
  assert.ok(w.document.querySelector('.tpick')); click(w, row.querySelector('.f-tp'));
  assert.equal(w.document.querySelector('.tpick'), null);
});

test('Use fills code, display and the saved binding carries the string version; it stays unverified and is not exported as FHIR Coding', async () => {
  const w = await page(); const { row } = localRow(w); await choose(w, row);
  assert.equal(row.querySelector('.f-code').value, 'demo.fever'); assert.equal(row.querySelector('.f-disp').value, 'Fever');
  assert.equal(w.document.querySelector('.tpick'), null);
  const f = save(w), b = f.bindings[0];
  assert.deepEqual({ system: b.system, code: b.code, display: b.display, version: b.version }, { system: 'local', code: 'demo.fever', display: 'Fever', version: '2' });
  assert.equal(w.eval("exportCodings(REGISTRY.find(s=>s.id==='pick_test').fields[0]).length"), 0);
});

test('editing the code or display after a pick, or changing the system, drops the version (it is never sent for a different term)', async () => {
  for (const edit of ['code', 'disp', 'system']) {
    const w = await page(); const { row } = localRow(w); await choose(w, row);
    if (edit === 'code') row.querySelector('.f-code').value = 'demo.other';
    if (edit === 'disp') row.querySelector('.f-disp').value = 'Fever (edited)';
    if (edit === 'system') { const s = row.querySelector('.f-sys'); s.value = 'snomed'; s.dispatchEvent(new w.Event('change', { bubbles: true })); }
    assert.equal(save(w).bindings[0].version, undefined, edit);
  }
});

test('a hand-typed local code is still allowed and carries no version; signing out closes an open list', async () => {
  const w = await page(); const { row } = localRow(w);
  row.querySelector('.f-code').value = 'demo.typed'; row.querySelector('.f-disp').value = 'Typed';
  const b = save(w).bindings[0]; assert.equal(b.code, 'demo.typed'); assert.equal(b.version, undefined);
  const w2 = await page(); const r2 = localRow(w2).row; as(w2, ['terms:read']);
  click(w2, r2.querySelector('.f-tp')); await new Promise(r => setTimeout(r, 30));
  assert.ok(w2.document.querySelector('.tpick')); w2.eval('Srv.user=null; renderTermsNav()');
  assert.equal(w2.document.querySelector('.tpick'), null);
});
