'use strict';
// 44b2 (browser half): Tools > Review, the review page for one request. No database needed.
// The helpers are taken from enhancer.html as text and run in a vm, so this tests the code the page really holds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(__dirname + '/enhancer.html', 'utf8');
const lines = html.split('\n');
const take = (re) => { const l = lines.filter((x) => re.test(x)); assert.equal(l.length, 1, 'expected exactly one line for ' + re); return l[0]; };
const src = [/^const esc=/, /^const LINT_PLAIN=/, /^const REV_LABEL=/, /^const REV_ALL=/, /^const REV_OPTXT=/, /^const revDate=/, /^function reviewFieldsHtml\(/, /^function reviewRuleText\(/, /^function reviewRulesHtml\(/, /^function reviewPageHtml\(/].map(take).join('\n');
// reviewPageHtml is two lines (the return statement continues); take the whole function by its start and its closing line
const i0 = html.indexOf('function reviewPageHtml('), i1 = html.indexOf('function revShowList()');
const pageFn = html.slice(i0, i1);
const ctx = vm.createContext({});
vm.runInContext(src.replace(take(/^function reviewPageHtml\(/), '') + '\n' + pageFn + '\nthis.t={reviewPageHtml,reviewFieldsHtml,reviewRulesHtml,reviewRuleText};', ctx);
const t = ctx.t;

const body = (extra) => Object.assign({
  title: 'Fever chart',
  sections: [{ title: 'Vitals', fields: [{ id: 'temp', label: 'Temperature', type: 'number', unit: 'C', required: true, rationale: 'Made-up reason' }, { id: 'site', label: 'Site', type: 'select', options: ['Oral', 'Ear'] }] }],
  rules: [{ ruleId: 'r1', fieldRef: 'user.a/temp', op: '>', threshold: 40, unit: 'C', indicator: 'warning', summary: 'Made-up alert', enabled: false, provenance: { source: 'ai-drafted', verifiedBy: '', verifiedAt: '' } }],
  provenance: { requestText: 'a fever chart', model: 'mock-1', at: '2026-11-21T08:00:00Z' } }, extra);
const detail = (o) => Object.assign({
  request: { id: 'r1', setId: 'user.a', version: 2, status: 'submitted', contentHash: 'abcdef0123456789abcdef', authorId: 'u1', authorName: 'Dr Made Up', reviewerId: null, submittedAt: '2026-11-21T08:00:00Z', decidedAt: null, comment: null, checklist: null },
  set: { setId: 'user.a', version: 2, kind: 'custom', body: body(), source: 'user', tier: 'local-draft', contentHash: 'abcdef0123456789abcdef' },
  hashMatches: true, lint: { errors: [], warnings: [] }, events: [{ at: '2026-11-21T08:00:00Z', userId: 'u1', userName: 'Dr Made Up', event: 'submitted', detail: {} }] }, o);

test('44b2: the page shows title, kind, version, status, set id, author and a short hash', () => {
  const h = t.reviewPageHtml(detail(), 'me');
  for (const s of ['Fever chart', 'custom', 'v2', 'Waiting for a reviewer', 'user.a', 'Dr Made Up', 'abcdef012345', 'matches the stored version']) assert.ok(h.includes(s), s);
  assert.ok(!h.includes('abcdef0123456'));
});

test('44b2: the request text and the AI provenance (model, time) are shown, with "not checked" wording', () => {
  const h = t.reviewPageHtml(detail(), 'me');
  for (const s of ['a fever chart', 'Drafted by mock-1 (AI)', 'Nobody has checked it']) assert.ok(h.includes(s), s);
  const none = t.reviewPageHtml(detail({ set: Object.assign(detail().set, { body: body({ provenance: undefined }) }) }), 'me');
  assert.match(none, /No request text is recorded/);
});

test('44b2: fields are listed in plain words with type, unit, required, choices and "no code" when there is none', () => {
  const h = t.reviewPageHtml(detail(), 'me');
  for (const s of ['Vitals', 'Temperature · number · unit C · required', 'Site · select · choices: Oral, Ear', 'no code', 'Made-up reason']) assert.ok(h.includes(s), s);
  assert.match(t.reviewFieldsHtml({ sections: [{ title: 'S', fields: [{ id: 'x', label: 'X', type: 'text', coding: { system: 'local', code: 'L1' } }] }] }), /code local L1/);
  assert.match(t.reviewFieldsHtml({}), /No fields/);
});

test('44b2: a rule is written as a sentence using the field label, with its approval state and no judgement', () => {
  const h = t.reviewPageHtml(detail(), 'me');
  assert.ok(h.includes('If the latest Temperature is above 40 C, show warning: Made-up alert'));
  assert.ok(h.includes('AI-drafted · not approved: it does not run'));
  assert.match(h, /shown exactly as recorded/);
  assert.match(t.reviewRulesHtml(body({ rules: [{ fieldRef: 'user.a/temp', op: 'minutes_since_gt', threshold: 60, indicator: 'info', summary: 'Old', enabled: true, provenance: { verifiedBy: 'Dr Made Up' } }] }), 'user.a'), /more than 60 min old.*approved by Dr Made Up/);
  assert.match(t.reviewRulesHtml({}, 'x'), /No alert rules/);
});

test('44b2: a pathway lists its sets and shows no fields or rules', () => {
  const h = t.reviewPageHtml(detail({ set: { setId: 'user.p', version: 1, kind: 'pathway', body: { title: 'Path', setIds: ['core.vitals', 'user.a'] }, tier: 'local-draft' } }), 'me');
  assert.ok(h.includes('Sets in this pathway') && h.includes('core.vitals') && h.includes('user.a'));
  assert.ok(!h.includes('>Fields<') && !h.includes('Alert rules'));
});

test('44b2: the server lint result is shown (errors and warnings, plain text where known); none says it only checks the format', () => {
  const ok = t.reviewPageHtml(detail(), 'me');
  assert.match(ok, /No errors/); assert.match(ok, /only checks the format/);
  const bad = t.reviewPageHtml(detail({ lint: { errors: [{ code: 'bad_access', path: 'content.access', message: 'm' }], warnings: [{ code: 'zzz_unknown', path: 'p', message: 'Raw warning text' }] } }), 'me');
  assert.match(bad, /Must be fixed \(1\)/); assert.match(bad, /Warnings \(1\)/); assert.match(bad, /Raw warning text/); assert.match(bad, /bad_access, content\.access/);
  assert.ok(!/only checks the format/.test(bad));
});

test('44b2: a hash that no longer matches is called out, and the viewer\'s own request is marked', () => {
  assert.match(t.reviewPageHtml(detail({ hashMatches: false }), 'me'), /does not match the stored version: do not approve it/);
  assert.match(t.reviewPageHtml(detail(), 'u1'), /Your own request: you cannot review it/);
  assert.ok(!/Your own request/.test(t.reviewPageHtml(detail(), 'me')));
});

test('44b2: history and any reviewer comment are shown', () => {
  const d = detail(); d.request.comment = 'Please fix the unit';
  const h = t.reviewPageHtml(d, 'me');
  assert.ok(h.includes('Please fix the unit') && h.includes('Dr Made Up · submitted'));
});

test('44b2: server text is escaped everywhere', () => {
  const X = '<img src=x onerror=alert(1)>';
  const d = detail({ lint: { errors: [{ code: 'q', path: X, message: X }], warnings: [] }, events: [{ at: null, userName: X, event: X }] });
  d.request.authorName = X; d.request.comment = X; d.request.setId = X;
  d.set.body = body({ title: X, provenance: { requestText: X, model: X, at: null }, sections: [{ title: X, fields: [{ id: 'a', label: X, type: X, unit: X, options: [X], rationale: X, coding: { system: X, code: X } }] }], rules: [{ fieldRef: X, op: X, threshold: X, indicator: X, summary: X, provenance: { verifiedBy: X }, enabled: true }] });
  assert.ok(!t.reviewPageHtml(d, 'me').includes('<img'));
  assert.ok(t.reviewPageHtml(d, 'me').includes('&lt;img'));
});

test('44b2: a missing or odd response does not break the page', () => {
  for (const d of [null, undefined, {}, { request: {} }, 'x']) assert.match(t.reviewPageHtml(d, 'me'), /Nothing to show/);
  assert.doesNotThrow(() => t.reviewPageHtml({ request: { setId: 'a', version: 1, status: 'weird' }, set: { body: null } }, 'me'));
});

test('44b2: the page holds no decision buttons and no diff (44b3, 44b4)', () => {
  assert.ok(!/<button|data-decide|Approve|Reject|Request changes/.test(t.reviewPageHtml(detail(), 'me')));
});

test('44b2: wiring: each queue row has an Open link, the detail view and Back exist, and the loader only reads after the checks', () => {
  assert.match(html, /<a href="#" role="button" data-open="'\+esc\(x\.id\)\+'">Open to read<\/a>/);
  for (const id of ['revList', 'revDetail', 'revBack', 'revDetailOut']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /id="revDetail" hidden/);
  const a = html.indexOf('async function reviewOpen('), body = html.slice(a, html.indexOf("$('revOut').addEventListener", a));
  assert.ok(body.indexOf("Store.mode!=='server'") < body.indexOf("Store.api('GET','/review-requests/'"), 'server-mode check first');
  assert.ok(body.indexOf("Store.can('content.review')") < body.indexOf("Store.api('GET','/review-requests/'"), 'role check first');
  assert.match(body, /encodeURIComponent\(id\)/);
  assert.ok(!/'POST'|'PUT'|'PATCH'|'DELETE'/.test(body), 'the page only reads');
  assert.match(html, /revShowList\(\);reviewQueueLoad\(\)\}\);/);
});

test('44b2: the page script still parses', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s));
});
