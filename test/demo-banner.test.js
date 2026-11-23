'use strict';
// Row DM4a: the demo banner is always on screen and staged features say "planned". Reads the page file only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');

test('the banner says "Synthetic data, prototype", comes first in the body and stays at the top while scrolling', () => {
  const body = html.slice(html.indexOf('<body>') + 6);
  assert.match(body.trimStart(), /^<div class="ban"><b>Synthetic data, prototype\.<\/b> Not for clinical use\./);
  assert.equal((html.match(/class="ban"/g) || []).length, 1);
  assert.match(html, /\.ban\{[^}]*position:sticky;top:0/);
});

test('the terminology verification surfaces are labelled planned (tab and both verify buttons)', () => {
  assert.match(html, /data-t="codes">Codes &amp; FHIR<span class="planned"/);
  assert.match(html, /data-act="liveCheck">[^<]*<\/button><span class="planned"/);
  assert.match(html, /id="genVerify"[^>]*>[^<]*<\/button><span class="planned"/);
});
