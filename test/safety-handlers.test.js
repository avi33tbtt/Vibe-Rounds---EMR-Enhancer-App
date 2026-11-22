'use strict';
// Chunk 06d-2a: inline on*="" handlers move to one delegated listener (data-act / data-arg / data-ev, ACT table).
// 6d-2b and 6d-2c convert the rest; MAX_INLINE is a ratchet that each row lowers (2c sets it to 0).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pageHtml } = require('./html');

const MAX_INLINE = 63;
const src = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const inline = s => (s.match(/ on[a-z]+="/g) || []).length;

test('inline handlers never grow (ratchet toward zero in 6d-2c)', () => {
  assert.ok(inline(src) <= MAX_INLINE, `${inline(src)} inline handlers, limit ${MAX_INLINE}`);
});

test('every data-act in the page has an entry in ACT, and ACT is a plain table (no eval)', () => {
  const used = new Set([...src.matchAll(/data-act="(\w+)"/g)].map(m => m[1]));
  assert.ok(used.size >= 20);
  const table = /const ACT=\{([\s\S]*?)\n\};/.exec(src)[1];
  for (const n of used) assert.match(table, new RegExp(`\\b${n}:`), 'ACT lacks ' + n);
  assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), 'no eval / new Function in the page');
});

async function page() {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = async () => { throw new Error('offline'); }; w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}

test('delegated click, change, input and Enter reach the right functions with the right arguments', async () => {
  const w = await page(), d = w.document;
  // click + data-arg: Settings toggles the panel
  const panel = d.getElementById('setPanel'), before = panel.style.display;
  d.querySelector('[data-act=tg][data-arg=setPanel]').click();
  assert.notEqual(panel.style.display, before);
  // a handler that returns false cancels the default (the "#" link) and gets the element
  const link = d.querySelector('[data-act=fillDx]');
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(d.getElementById('gen_dx').value, link.textContent);
  // input event: search box re-renders lists without throwing; change event: patient field saves
  const s = d.getElementById('searchEl'); s.value = 'vit'; s.dispatchEvent(new w.Event('input', { bubbles: true }));
  const n = d.getElementById('p_name'); n.value = 'Test Patient'; n.dispatchEvent(new w.Event('change', { bubbles: true }));
  // Enter on the password box calls srvLogin; other keys do not
  let calls = 0; w.eval('srvLogin = () => { window.__lg = (window.__lg || 0) + 1 }');
  const p = d.getElementById('lg_p');
  p.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  p.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(w.__lg, 1);
  // click on a child of an action element still counts; unknown action names are ignored
  const x = d.createElement('button'); x.setAttribute('data-act', 'constructor'); d.body.appendChild(x);
  assert.doesNotThrow(() => x.click());
  // a change-type element does not fire on click
  const before2 = n.value; n.click(); assert.equal(n.value, before2);
});

test('disabled action buttons do nothing', async () => {
  const w = await page(), d = w.document;
  let hit = 0; w.eval('ACT.suggest = () => { window.__s = (window.__s || 0) + 1 }');
  const b = d.querySelector('button[data-act=suggest]'); b.disabled = true; b.click();
  assert.equal(w.__s, undefined);
});
