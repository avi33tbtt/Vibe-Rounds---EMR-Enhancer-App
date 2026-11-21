'use strict';
/* 42c1: the Import package file screen. Pulls pkgLintShow out of enhancer.html and runs it with the real package-lint.js and views.js. Made-up packages only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const PackageLint = require('./package-lint.js');
const html = fs.readFileSync('./enhancer.html', 'utf8');
const a = html.indexOf('function pkgLintShow('), b = html.indexOf('/* end pkgLintShow */');
assert.ok(a > 0 && b > a, 'pkgLintShow not found in enhancer.html');
const code = html.slice(a, b);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function run(text, codes, mode) {
  const out = { innerHTML: '' };
  const sb = { $: () => out, esc, window: { PackageLint }, PackageLint, ROLE_LIST: ['admin', 'doctor', 'nurse', 'informatician', 'viewer'], Store: { codes: () => codes || {}, mode }, JSON };   // host JSON, so parsed objects share this realm's Object.prototype (canonicalJson checks it)
  vm.createContext(sb); vm.runInContext(code, sb);
  const r = sb.pkgLintShow(text, 'f.json');
  return { html: out.innerHTML, r };
}
const good = () => ({ manifest: { id: 'care.zz_form', version: '1.0.0', targetApp: 'emr', kind: 'set' },
  content: { setId: 'zz.t', kind: 'care', version: 1, access: { view: ['doctor'], enter: ['doctor'] }, sections: [{ id: 's1', fields: [{ id: 't', type: 'datetime' }, { id: 'v', type: 'number' }] }], view: { type: 'flowsheet', timeField: 't' } } });

test('42c1: text that is not JSON says so and returns null', () => {
  const x = run('{nope');
  assert.equal(x.r, null); assert.match(x.html, /not a JSON file/);
});

test('42c1: a good package shows no errors and no import-blocking message', () => {
  const x = run(JSON.stringify(good()));
  assert.deepEqual(x.r.errors, []);
  assert.match(x.html, /No errors/); assert.doesNotMatch(x.html, /cannot be imported/);
  assert.match(x.html, /care\.zz_form/); assert.match(x.html, /version 1\.0\.0/);
});

test('42c1: errors are listed with code, path and message, and the file is marked not importable', () => {
  const p = good(); p.manifest.version = '1';
  const x = run(JSON.stringify(p));
  assert.match(x.html, /1 error: this file cannot be imported/); assert.match(x.html, /bad_semver/); assert.match(x.html, /manifest\.version/);
});

test('42c1: warnings are listed and say they do not block', () => {
  const p = good(); p.content.sections[0].fields[1].coding = { system: 'snomed', code: '1' };
  const x = run(JSON.stringify(p), {});
  assert.match(x.html, /unverified_coding/); assert.match(x.html, /does not block/);
  assert.match(run(JSON.stringify(p), { 'snomed|1': 'x' }).html, /No errors/);
  assert.doesNotMatch(run(JSON.stringify(p), { 'snomed|1': 'x' }).html, /unverified_coding/);
});

test('42c1: text from the file is escaped, and odd JSON (null, a list) does not throw', () => {
  const p = good(); p.content.sections[0].fields[0].id = '<img src=x>'; p.content.sections[0].fields[0].type = 'nope';
  assert.doesNotMatch(run(JSON.stringify(p)).html, /<img/);
  for (const t of ['null', '[]', '5', '"x"']) assert.doesNotThrow(() => run(t), t);
});

test('42c2: the Install button shows only in Demo mode and only when there are no errors', () => {
  const ok = JSON.stringify(good()), bad = good(); bad.manifest.version = '1';
  assert.match(run(ok, {}, 'local').html, /id="pkgInstall"/);
  assert.doesNotMatch(run(ok, {}, 'server').html, /pkgInstall/);
  assert.match(run(ok, {}, 'server').html, /server mode/);
  assert.doesNotMatch(run(JSON.stringify(bad), {}, 'local').html, /pkgInstall/);
});
