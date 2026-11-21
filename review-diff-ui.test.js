'use strict';
// 44b3 (browser half): the review page's "Changes since the previous version". No database needed.
// The pure helpers are taken from enhancer.html as text (from the esc line and the 44b2/44b3 helpers up to revShowList) and run in a vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(__dirname + '/enhancer.html', 'utf8');
const lines = html.split('\n');
const take = (re) => { const l = lines.filter((x) => re.test(x)); assert.equal(l.length, 1, 'expected exactly one line for ' + re); return l[0]; };
const i0 = html.indexOf('const REV_ALL='), i1 = html.indexOf('function revShowList()');
assert.ok(i0 > 0 && i1 > i0);
const src = [take(/^const esc=/), take(/^const LINT_PLAIN=/), take(/^const REV_LABEL=/)].join('\n') + '\n' + html.slice(i0, i1);
const ctx = vm.createContext({});
vm.runInContext(src + '\nthis.t={reviewDiffLines,reviewDiffHtml,reviewPageHtml};', ctx);
const t = ctx.t;

const base = () => ({
  title: 'Fever chart',
  sections: [{ title: 'Vitals', fields: [{ id: 'temp', label: 'Temperature', type: 'number', unit: 'C' }, { id: 'site', label: 'Site', type: 'select', options: ['Oral', 'Ear'] }] }],
  rules: [{ ruleId: 'r1', fieldRef: 'user.a/temp', op: '>', threshold: 40, unit: 'C', indicator: 'warning', summary: 'Made-up alert', enabled: false, provenance: { source: 'manual', verifiedBy: '' } }],
  access: { view: ['admin'], enter: ['admin'] },
  provenance: { requestText: 'a', model: 'm', at: 'x' } });
const L = (a, b) => Array.from(t.reviewDiffLines(a, b, 'user.a'));   // Array.from: the vm makes arrays from another realm

test('44b3: identical bodies give no lines, and the page says so', () => {
  assert.deepEqual(L(base(), base()), []);
  assert.match(t.reviewDiffHtml(base(), base(), 'user.a'), /No differences/);
});

test('44b3: key order and provenance changes are not differences', () => {
  const b = base(); b.provenance = { requestText: 'other', model: 'z', at: 'y' };
  b.sections[0].fields[0] = { unit: 'C', type: 'number', label: 'Temperature', id: 'temp' };
  assert.deepEqual(L(base(), b), []);
});

test('44b3: title, added field, removed field and changed field are described', () => {
  const b = base(); b.title = 'Fever chart 2';
  b.sections[0].fields[0].unit = 'F'; b.sections[0].fields[0].required = true;
  b.sections[0].fields.splice(1, 1); b.sections[0].fields.push({ id: 'pulse', label: 'Pulse', type: 'integer' });
  const o = L(base(), b);
  assert.ok(o.includes('Title: "Fever chart" → "Fever chart 2"'));
  assert.ok(o.some((x) => x.startsWith('Field changed: Temperature') && x.includes('unit: "C" → "F"') && x.includes('required: none → true')));
  assert.ok(o.includes('Field removed: Site'));
  assert.ok(o.includes('Field added: Pulse (integer) in Vitals'));
});

test('44b3: a field moved to another section is reported', () => {
  const b = base(); const f = b.sections[0].fields.pop(); b.sections.push({ title: 'Other', fields: [f] });
  const o = L(base(), b);
  assert.ok(o.some((x) => x.startsWith('Field changed: Site') && x.includes('section: "Vitals" → "Other"')));
  assert.ok(o.some((x) => x.startsWith('Section titles or order')));
});

test('44b3: a changed rule threshold shows the old and the new value as recorded, with the rule as a sentence', () => {
  const b = base(); b.rules[0].threshold = 41; b.rules[0].enabled = true;
  const o = L(base(), b);
  const l = o.find((x) => x.startsWith('Rule changed:'));
  assert.ok(l.includes('If the latest Temperature is above 41 C, show warning: Made-up alert'));
  assert.ok(l.includes('threshold: 40 → 41') && l.includes('enabled: false → true'));
  assert.ok(!l.includes('provenance'));
});

test('44b3: rules added and removed are shown; a rule without an id is still compared', () => {
  const b = base(); b.rules = [{ ruleId: 'r2', fieldRef: 'user.a/temp', op: '<', threshold: 35, unit: 'C', indicator: 'info', summary: 'Low' }];
  const o = L(base(), b);
  assert.ok(o.some((x) => x.startsWith('Rule added:') && x.includes('is below 35 C')));
  assert.ok(o.some((x) => x.startsWith('Rule removed:') && x.includes('above 40 C')));
  const a2 = base(), b2 = base(); delete a2.rules[0].ruleId; delete b2.rules[0].ruleId; b2.rules[0].threshold = 39;
  assert.ok(L(a2, b2).some((x) => x.startsWith('Rule changed:') && x.includes('threshold: 40 → 39')));
});

test('44b3: pathway sets added, removed and re-ordered', () => {
  const a = { title: 'P', setIds: ['a', 'b'] };
  assert.deepEqual(L(a, { title: 'P', setIds: ['a', 'c'] }), ['Set added to the pathway: c', 'Set removed from the pathway: b']);
  assert.deepEqual(L(a, { title: 'P', setIds: ['b', 'a'] }), ['The order of the sets changed']);
});

test('44b3: other top-level keys such as the access block are compared', () => {
  const b = base(); b.access.enter = ['admin', 'doctor'];
  const o = L(base(), b);
  assert.equal(o.length, 1);
  assert.ok(o[0].startsWith('Changed access:') && o[0].includes('"doctor"'));
});

test('44b3: odd input does not throw', () => {
  for (const [a, b] of [[null, null], [undefined, base()], [{ sections: 'x', rules: 5 }, { sections: [null, { fields: 'x' }], rules: [null, 3] }], ['x', []]]) assert.doesNotThrow(() => L(a, b));
});

test('44b3: text from the bodies is escaped in the diff', () => {
  const X = '<img src=x onerror=alert(1)>';
  const b = base(); b.title = X; b.sections[0].fields[0].label = X;
  const h = t.reviewDiffHtml(base(), b, 'user.a');
  assert.ok(!h.includes('<img') && h.includes('&lt;img'));
});

test('44b3: the page shows the section only when given the previous version state (the 44b2 calls without it are unchanged)', () => {
  const d = { request: { id: 'r', setId: 'user.a', version: 2, status: 'submitted', contentHash: 'abcdef0123456789', authorId: 'u1' }, set: { kind: 'custom', body: base() }, hashMatches: true, lint: { errors: [], warnings: [] }, events: [] };
  assert.ok(!t.reviewPageHtml(d, 'me').includes('Changes since'));
  assert.match(t.reviewPageHtml(d, 'me', { none: true }), /Changes since the previous version<\/b>.*This is the first version/);
  assert.match(t.reviewPageHtml(d, 'me', { n: 1, error: 'gone' }), /Changes since the previous version \(v1\)<\/b>.*could not be loaded: gone/);
  const old = base(); old.rules[0].threshold = 38;
  const h = t.reviewPageHtml(d, 'me', { n: 1, body: old });
  assert.ok(h.includes('(v1)') && h.includes('threshold: 38 → 40'));
  assert.ok(h.indexOf('Changes since') < h.indexOf('The server&#39;s check') || h.indexOf('Changes since') < h.indexOf("server's check"));
  assert.ok(!/<button|Approve|Reject|Request changes/.test(h));
});

test('44b3: wiring: the loader fetches the previous version (version - 1) with a read, after the checks, and failure of that fetch does not break the page', () => {
  const a = html.indexOf('async function reviewOpen('), body = html.slice(a, html.indexOf("$('revOut').addEventListener", a));
  assert.match(body, /'\/element-sets\/'\+encodeURIComponent\(d\.request\.setId\)\+'\/versions\/'\+n/);
  assert.match(body, /const n=v-1/);
  assert.ok(body.indexOf("Store.can('content.review')") < body.indexOf("'/element-sets/'"));
  assert.match(body, /catch\(e2\)\{pv=\{n,error:/);
  assert.ok(!/'POST'|'PUT'|'PATCH'|'DELETE'/.test(body));
});

test('44b3: the page script still parses', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s));
});
