'use strict';
// node --test handover-print.test.js
// Chunk 37d3: print CSS for the Handover tab (A4, no navigation or controls, banner kept). Checked on the source text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('./enhancer.html', 'utf8');
const m = html.match(/\/\* chunk 37d3[\s\S]*?\n}\n(?=<\/style>)/);
test('print block exists and is inside @media print', () => { assert.ok(m, 'print block not found'); assert.match(m[0], /@media print\{/); });
const css = m ? m[0] : '';
test('A4 page', () => assert.match(css, /@page\{size:A4/));
test('hides navigation, header, chart bar and every interactive control', () => {
  ['header', '#shellnav', '#chartbar', '#ho .tj', 'button', 'input', 'select', 'textarea'].forEach((x) => assert.ok(css.includes(x), x));
  assert.match(css, /display:none!important/);
});
test('the "Not for clinical use" banner is never hidden and a footer repeats it', () => {
  const hidden = css.match(/:is\(([^)]*)\)\{display:none!important\}/g).join(' ');
  assert.ok(!/\.ban/.test(hidden), 'banner must not be in a display:none list');
  assert.match(css, /::after\{content:"Not for clinical use/);
  assert.match(css, /position:fixed/);
});
test('scoped to the Handover tab only, so other tabs print as before', () => {
  const rules = css.split('\n').filter((l) => /^body|^@page/.test(l));
  assert.ok(rules.length > 5);
  rules.filter((l) => l.startsWith('body')).forEach((l) => assert.ok(l.startsWith('body:has(#ho.on)'), l.slice(0, 50)));
});
