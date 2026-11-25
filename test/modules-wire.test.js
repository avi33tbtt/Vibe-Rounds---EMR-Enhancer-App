'use strict';
// Row R0b-3: ACT and the delegated listener live in modules/90-wire.js; clicks still reach the right functions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, pageSource, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '90-wire.js'), 'utf8');

test('90-wire.js loads after 30-store.js and before the inline script; ACT and the listener are no longer inline', () => {
  const l = localScripts();
  assert.deepEqual(l, ['sdc.js', 'modules/00-boot.js', 'modules/10-escape.js', 'modules/20-session.js', 'modules/30-store.js', 'modules/40-patients.js', 'modules/50-cases.js', 'modules/52-complaints.js', 'modules/54-adaptive.js', 'modules/56-exam.js', 'modules/58-assessment.js', 'modules/59-mode.js', 'modules/60-library.js', 'modules/70-review.js', 'modules/75-terms.js', 'modules/77-problems.js', 'modules/78-allergies.js', 'modules/79-medications.js', 'modules/80-pins.js', 'modules/82-insights.js', 'modules/84-notes.js', 'modules/86-values.js', 'modules/90-wire.js']);
  const inline = raw.slice(raw.indexOf('<script>'));
  assert.ok(!/const ACT=\{/.test(inline) && !/document\.addEventListener\(type/.test(inline), 'still inline');
  assert.match(mod, /const ACT=\{/); assert.match(mod, /document\.addEventListener\(type/);
});

test('every ACT entry is an arrow function (so the module can load before the page functions exist)', () => {
  const table = /const ACT=\{([\s\S]*?)\n\};/.exec(mod)[1];
  const heads = [...table.matchAll(/^  ([A-Za-z0-9_]+):(\S{0,8})/gm)];
  assert.ok(heads.length >= 80, 'entries found: ' + heads.length);
  for (const [, name, start] of heads) assert.ok(/^(async)?\(/.test(start) || /^async/.test(start), name + ' is not an arrow: ' + start);
  assert.ok(pageSource().includes('const ACT={'), 'pageSource() still sees the table');
});

async function page() {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = async () => { throw new Error('offline'); }; w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}

test('a click on a data-act element runs the action, bubbling from a child; an unknown name does nothing; a disabled input is ignored', async () => {
  const w = await page(), d = w.document;
  const panel = d.getElementById('setPanel'), before = panel.style.display;
  d.querySelector('[data-act=tg][data-arg=setPanel]').click();
  assert.notEqual(panel.style.display, before, 'tg ran');
  const b = d.createElement('button'); b.setAttribute('data-act', 'tg'); b.setAttribute('data-arg', 'setPanel');
  const inner = d.createElement('span'); b.appendChild(inner); d.body.appendChild(b);
  const mid = panel.style.display; inner.click();
  assert.notEqual(panel.style.display, mid, 'click on a child reaches the action');
  const mid2 = panel.style.display;
  // jsdom never delivers .click() to a disabled button, so use a change event on an input (it does deliver those).
  const inp = d.createElement('input'); inp.setAttribute('data-act', 'tg'); inp.setAttribute('data-arg', 'setPanel'); inp.setAttribute('data-ev', 'change'); d.body.appendChild(inp);
  inp.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.notEqual(panel.style.display, mid2, 'a change event on an enabled input runs the action');
  const mid3 = panel.style.display; inp.disabled = true;
  inp.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(panel.style.display, mid3, 'disabled element is ignored');
  const bad = d.createElement('button'); bad.setAttribute('data-act', 'constructor'); d.body.appendChild(bad);
  bad.click();   // Object.hasOwn guard: inherited names are not actions
  assert.equal(panel.style.display, mid3);
});
