'use strict';
// Loads emr-enhancer.html for jsdom tests with <script src="sdc.js"> replaced by the real file's contents (no network, no race).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function pageHtml() {
  const tag = '<script src="sdc.js"></script>';
  const html = fs.readFileSync(path.join(root, 'emr-enhancer.html'), 'utf8');
  if (!html.includes(tag)) throw new Error('emr-enhancer.html no longer loads sdc.js');
  return html.replace(tag, () => '<script>' + fs.readFileSync(path.join(root, 'sdc.js'), 'utf8') + '</script>');
}
module.exports = { pageHtml };
