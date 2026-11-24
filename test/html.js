'use strict';
// Loads emr-enhancer.html for jsdom tests with every local <script src="..."> (sdc.js, modules/*.js) replaced by the real file's contents (no network, no race).
// pageSource() = the page file plus all local script files: use it for tests that scan the code, so code moved into modules/ is still checked (R0a).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const TAG = /<script src="((?:sdc\.js|modules\/[a-z0-9][a-z0-9-]*\.js))"><\/script>/g;
const rawPage = () => fs.readFileSync(path.join(root, 'emr-enhancer.html'), 'utf8');
function localScripts() { return [...rawPage().matchAll(TAG)].map(m => m[1]); }
function pageHtml() {
  const html = rawPage();
  if (!html.includes('<script src="sdc.js"></script>')) throw new Error('emr-enhancer.html no longer loads sdc.js');
  return html.replace(TAG, (_m, f) => '<script>' + fs.readFileSync(path.join(root, f), 'utf8') + '</script>');
}
function pageSource() {
  return rawPage() + '\n' + localScripts().map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
}
module.exports = { pageHtml, pageSource, localScripts };
