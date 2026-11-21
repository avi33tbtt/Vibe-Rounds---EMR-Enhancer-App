'use strict';
// 44b1 (browser half): Tools > Review, the queue list. No database needed.
// The helpers are taken from enhancer.html as text and run in a vm, so this tests the code the page really holds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(__dirname + '/enhancer.html', 'utf8');
const lines = html.split('\n');
const take = (re) => { const l = lines.filter((x) => re.test(x)); assert.equal(l.length, 1, 'expected exactly one line for ' + re); return l[0]; };
const src = [take(/^const esc=/), take(/^const REV_LABEL=/), take(/^function reviewQueueHtml\(/)].join('\n');
const ctx = vm.createContext({});
vm.runInContext(src + '\nthis.t={reviewQueueHtml,REV_LABEL};', ctx);
const t = ctx.t;
const row = (extra) => Object.assign({ id: 'r1', setId: 'user.a', version: 2, kind: 'custom', title: 'Fever chart', status: 'submitted', contentHash: 'abcdef0123456789abcdef', authorId: 'u1', authorName: 'Dr Made Up', reviewerId: null, submittedAt: '2026-11-21T08:00:00Z' }, extra);

test('44b1: an empty or missing queue says that nothing is waiting', () => {
  for (const L of [[], null, undefined, 'x']) assert.match(t.reviewQueueHtml(L, 'me'), /Nothing is waiting for review/);
});

test('44b1: a row shows title, kind, version, plain status, set id, author, a short hash', () => {
  const h = t.reviewQueueHtml([row()], 'me');
  for (const s of ['Fever chart', 'custom', 'v2', 'Waiting for a reviewer', 'user.a', 'Dr Made Up', 'abcdef012345']) assert.ok(h.includes(s), s);
  assert.ok(!h.includes('abcdef0123456'), 'the hash is shortened to 12 characters');
});

test('44b1: each of the three open statuses has a plain label; an unknown status is shown as it is', () => {
  assert.deepEqual(Object.keys(t.REV_LABEL).sort(), ['changes_requested', 'in_review', 'submitted']);
  assert.match(t.reviewQueueHtml([row({ status: 'in_review' })], 'me'), /In review/);
  assert.match(t.reviewQueueHtml([row({ status: 'changes_requested' })], 'me'), /Changes requested/);
  assert.match(t.reviewQueueHtml([row({ status: 'odd_status' })], 'me'), /odd_status/);
});

test('44b1: text from the server is escaped (title, set id, author)', () => {
  const h = t.reviewQueueHtml([row({ title: '<img src=x onerror=alert(1)>', setId: '"><b>x', authorName: '<script>bad()</script>' })], 'me');
  assert.ok(!h.includes('<img') && !h.includes('<script') && !h.includes('"><b>x'));
  assert.ok(h.includes('&lt;img'));
});

test('44b1: a missing title falls back to the set id, and a missing author or hash does not break the row', () => {
  const h = t.reviewQueueHtml([row({ title: '', authorName: '', contentHash: null, submittedAt: null })], 'me');
  assert.match(h, /<b>user\.a<\/b>/); assert.match(h, /Submitted by unknown/);
});

test('44b1: the viewer\'s own request is marked, and only theirs', () => {
  const h = t.reviewQueueHtml([row({ id: 'r1', authorId: 'me', title: 'Mine' }), row({ id: 'r2', authorId: 'other', title: 'Theirs' })], 'me');
  assert.equal((h.match(/Your own request/g) || []).length, 1);
  assert.ok(h.indexOf('Mine') < h.indexOf('Your own request') && h.indexOf('Your own request') < h.indexOf('Theirs'));
  assert.ok(!/Your own request/.test(t.reviewQueueHtml([row({ authorId: 'u1' })], undefined)), 'no own-request mark when the viewer is unknown');
});

test('44b1: the list holds no buttons: nothing here approves, sends back or rejects (44b4)', () => {
  assert.ok(!/<button|data-submit|approve|reject/i.test(t.reviewQueueHtml([row(), row({ id: 'r2' })], 'me')));
});

test('44b1: the page has the Review tool (hidden until the role is known), the panel, and the loader calls the queue route only for a reviewer in server mode', () => {
  assert.match(html, /<button type="button" id="revTool" hidden>Review<\/button>/);
  assert.match(html, /id="revPanel"[^>]*role="dialog"[^>]*hidden/);
  for (const id of ['revClose', 'revFilter', 'revRefresh', 'revOut']) assert.ok(html.includes('id="' + id + '"'), id);
  for (const v of ['submitted', 'in_review', 'changes_requested']) assert.ok(html.includes('<option value="' + v + '">'), v);
  assert.match(html, /#pkgPanel\[hidden\],#reqPanel\[hidden\],#revPanel\[hidden\]\{display:none\}/);
  assert.match(take(/^const rvMay=/), /Store\.mode==='server'&&!!Store\.me&&Store\.can\('content\.review'\)/);
  assert.match(html, /riTool\(\);anTool\(\);auTool\(\);usTool\(\);pwTool\(\);rvTool\(\);paintWho\(\);/);
  const i = html.indexOf('async function reviewQueueLoad()'), body = html.slice(i, html.indexOf('$(\'revTool\').addEventListener', i));
  assert.ok(body.indexOf("Store.mode!=='server'") < body.indexOf("Store.api('GET','/review-requests'"), 'the server-mode check comes before the request');
  assert.ok(body.indexOf("Store.can('content.review')") < body.indexOf("Store.api('GET','/review-requests'"), 'the role check comes before the request');
  assert.match(body, /\?status='\+encodeURIComponent\(f\)/);
  assert.ok(!/'POST'|'PUT'|'PATCH'|'DELETE'/.test(body), 'the loader only reads');
});

test('44b1: the page script still parses', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s));
});
