'use strict';
// 44b4 (browser half): the checklist and the Approve / Request changes / Reject buttons on the review page. No database needed.
// The helpers are taken from enhancer.html as text and run in a vm with a tiny fake page and a fake Store, so this tests the code the page really holds.
// The server repeats every check (review-approve.test.js and review-decide.test.js); these tests only cover what the page does before and after the call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(__dirname + '/enhancer.html', 'utf8');
const lines = html.split('\n');
const take = (re) => { const l = lines.filter((x) => re.test(x)); assert.equal(l.length, 1, 'expected exactly one line for ' + re); return l[0]; };
const i0 = html.indexOf('const REV_ALL='), i1 = html.indexOf('async function reviewOpen(');
assert.ok(i0 > 0 && i1 > i0);
const src = [take(/^const esc=/), take(/^const LINT_PLAIN=/), take(/^const REV_LABEL=/)].join('\n') + '\n' + html.slice(i0, i1);

function make(opts = {}) {
  const el = {}, get = (id) => el[id] || (el[id] = { value: '', textContent: '', hidden: false, disabled: false });
  const calls = [], opened = [];
  const store = { mode: 'server', me: { id: 'me' }, can: (a) => a === 'content.review' && opts.can !== false, api: async (m, p, b) => { calls.push([m, p, b]); if (opts.fail) { const e = new Error(opts.fail); e.status = 409; throw e; } return opts.result || { finalized: true }; } };
  const buttons = [{ disabled: false }, { disabled: false }, { disabled: false }];
  const approve = { disabled: true };
  const ctx = vm.createContext({ $: get, Store: store, confirm: () => opts.confirm !== false, document: { querySelectorAll: () => buttons, querySelector: () => approve } });
  vm.runInContext(src + '\nreviewOpen=async function(id,note){opened.push([id,note])};\nthis.t={reviewChecks,reviewActHtml,reviewDecide,revApproveSync,setCur:(v)=>{revCur=v},getCur:()=>revCur};', Object.assign(ctx, { opened, reviewOpen: null }));
  return { t: ctx.t, get, calls, opened, buttons, approve };
}
const body = (extra) => Object.assign({ title: 'Fever chart', sections: [{ title: 'V', fields: [{ id: 'temp', label: 'Temperature', type: 'number', unit: 'C' }] }] }, extra);
const detail = (o) => Object.assign({
  request: { id: 'r1', setId: 'user.a', version: 1, status: 'submitted', contentHash: 'h', authorId: 'u1', authorName: 'Dr Made Up' },
  set: { setId: 'user.a', version: 1, kind: 'custom', body: body() }, hashMatches: true, lint: { errors: [], warnings: [] }, events: [] }, o);
const ticked = (c) => Object.fromEntries(c.manual.map((x) => [x.id, true]));
const { t } = make();

test('44b4: a clean version has two automatic items that pass and the manual items; nothing is ticked, so it is not ready', () => {
  const c = t.reviewChecks(detail(), 'me', {});
  assert.deepEqual(Array.from(c.auto, (a) => a.id + ':' + a.ok), ['schemaValid:true', 'codesVerified:true']);
  assert.deepEqual(Array.from(c.manual, (x) => x.id), ['readRequest', 'readFields', 'readText']);
  assert.equal(c.ready, false); assert.ok(c.missing.some((m) => /Tick each item/.test(m)));
  assert.equal(t.reviewChecks(detail(), 'me', ticked(c)).ready, true);
});

test('44b4: schemaValid fails on a lint error, on a hash that does not match, and when the check did not run', () => {
  const bad = (d) => t.reviewChecks(d, 'me', { readRequest: 1 }).auto[0];
  assert.equal(bad(detail({ lint: { errors: [{ code: 'bad_access', path: 'p', message: 'm' }], warnings: [] } })).ok, false);
  assert.equal(bad(detail({ hashMatches: false })).ok, false);
  assert.match(bad(detail({ hashMatches: false })).why, /hash/);
  assert.equal(bad(detail({ lint: undefined })).ok, false);
  assert.equal(bad(detail({ hashMatches: undefined })).ok, false);
});

test('44b4: codesVerified fails on an unverified_coding or no_verified_list warning (the verified_codes table check), not on other warnings', () => {
  const cv = (w) => t.reviewChecks(detail({ lint: { errors: [], warnings: w } }), 'me', {}).auto[1].ok;
  assert.equal(cv([{ code: 'unverified_coding', path: 'p' }]), false);
  assert.equal(cv([{ code: 'no_verified_list', path: 'p' }]), false);
  assert.equal(cv([{ code: 'empty_rationale', path: 'p' }]), true);
  assert.equal(cv([]), true);
});

test('44b4: the manual items depend on the version: a changes item from version 2, a rules item only with rules, a sets item for a pathway', () => {
  const ids = (d) => Array.from(t.reviewChecks(d, 'me', {}).manual, (x) => x.id);
  const d2 = detail(); d2.request.version = 2;
  assert.ok(ids(d2).includes('readChanges') && !ids(detail()).includes('readChanges'));
  const r = detail({ set: { kind: 'custom', body: body({ rules: [{ ruleId: 'r', fieldRef: 'a/b', op: '>', threshold: 1 }] }) } });
  assert.ok(ids(r).includes('readRules') && !ids(detail()).includes('readRules'));
  const p = detail({ set: { kind: 'pathway', body: { title: 'P', setIds: ['a'] } } });
  assert.ok(ids(p).includes('readSets') && !ids(p).includes('readFields'));
});

test('44b4: not ready when the request is not open or is the viewer\'s own, even with everything ticked', () => {
  for (const s of ['approved', 'rejected', 'withdrawn', 'changes_requested']) assert.equal(t.reviewChecks(detail({ request: Object.assign(detail().request, { status: s }) }), 'me', { readRequest: 1 }).open, false);
  const own = t.reviewChecks(detail(), 'u1', {}); assert.equal(own.own, true); assert.equal(own.ready, false);
  for (const s of ['submitted', 'in_review']) assert.equal(t.reviewChecks(detail({ request: Object.assign(detail().request, { status: s }) }), 'me', {}).open, true);
});

test('44b4: the action block: checklist with ticks, comment box, three buttons; Approve is disabled until ready', () => {
  const h = t.reviewActHtml(detail(), 'me', {});
  for (const s of ['Checklist', '(automatic)', 'data-chk="readRequest"', 'id="revComment"', 'data-decide="approve" disabled', 'data-decide="request-changes">', 'data-decide="reject">', 'Approve is off until']) assert.ok(h.includes(s), s);
  const c = t.reviewChecks(detail(), 'me', {}), ok = t.reviewActHtml(detail(), 'me', ticked(c));
  assert.ok(!ok.includes('data-decide="approve" disabled') && ok.includes('data-decide="approve">') && ok.includes('checked'));
  assert.match(t.reviewActHtml(detail({ lint: { errors: [{ code: 'x', path: 'p', message: 'm' }], warnings: [] } }), 'me', ticked(c)), /✗ The server's format check|✗ The server&#39;s format check/);
});

test('44b4: your own request and a decided request get no buttons', () => {
  assert.ok(!/<button/.test(t.reviewActHtml(detail(), 'u1', {})) && /cannot review your own request/.test(t.reviewActHtml(detail(), 'u1', {})));
  const h = t.reviewActHtml(detail({ request: Object.assign(detail().request, { status: 'approved' }) }), 'me', {});
  assert.ok(!/<button/.test(h) && /Approved\. It can no longer be decided|approved\. It can no longer be decided/.test(h));
});

test('44b4: text from the server is escaped in the block', () => {
  const X = '<img src=x onerror=alert(1)>';
  const d = detail({ lint: { errors: [], warnings: [] } }); d.request.status = X;
  assert.ok(!t.reviewActHtml(d, 'me', {}).includes('<img'));
});

test('44b4: ticking a box turns Approve on only when everything is done (sync)', () => {
  const m = make(); m.t.setCur({ d: detail(), chk: {} }); m.t.revApproveSync();
  assert.equal(m.approve.disabled, true); assert.match(m.get('revWhy').textContent, /Approve is off until/);
  m.t.getCur().chk = ticked(m.t.reviewChecks(detail(), 'me', {})); m.t.revApproveSync();
  assert.equal(m.approve.disabled, false); assert.equal(m.get('revWhy').textContent, '');
});

test('44b4: request changes and reject need a comment and send nothing without one', async () => {
  for (const kind of ['request-changes', 'reject']) {
    const m = make(); m.t.setCur({ d: detail(), chk: {} }); m.get('revComment').value = '   ';
    await m.t.reviewDecide(kind);
    assert.equal(m.calls.length, 0); assert.match(m.get('revActMsg').textContent, /comment is required/);
  }
});

test('44b4: a comment over 2000 characters is refused before any request', async () => {
  const m = make(); m.t.setCur({ d: detail(), chk: {} }); m.get('revComment').value = 'x'.repeat(2001);
  await m.t.reviewDecide('reject'); assert.equal(m.calls.length, 0);
});

test('44b4: Approve is refused until the checklist is done, then asks to confirm, then sends the comment (or an empty body) and reloads the request', async () => {
  const m = make(); m.t.setCur({ d: detail(), chk: {} });
  await m.t.reviewDecide('approve'); assert.equal(m.calls.length, 0); assert.match(m.get('revActMsg').textContent, /checklist/);
  m.t.getCur().chk = ticked(m.t.reviewChecks(detail(), 'me', {}));
  const no = make({ confirm: false }); no.t.setCur({ d: detail(), chk: ticked(no.t.reviewChecks(detail(), 'me', {})) }); await no.t.reviewDecide('approve'); assert.equal(no.calls.length, 0, 'cancelling the confirm sends nothing');
  await m.t.reviewDecide('approve');
  assert.deepEqual(JSON.parse(JSON.stringify(m.calls)), [['POST', '/review-requests/r1/approve', {}]]);
  assert.equal(m.opened.length, 1); assert.equal(m.opened[0][0], 'r1'); assert.match(m.opened[0][1], /frozen as reviewed.*not regulatory approval/);
  const c = make(); c.t.setCur({ d: detail(), chk: ticked(c.t.reviewChecks(detail(), 'me', {})) }); c.get('revComment').value = ' Looks fine ';
  await c.t.reviewDecide('approve'); assert.deepEqual(JSON.parse(JSON.stringify(c.calls[0][2])), { comment: 'Looks fine' });
});

test('44b4: request changes and reject POST to their routes with the trimmed comment and say what happens next', async () => {
  for (const [kind, re] of [['request-changes', /save a new version/], ['reject', /^Rejected/]]) {
    const m = make(); m.t.setCur({ d: detail(), chk: {} }); m.get('revComment').value = ' Fix the unit ';
    await m.t.reviewDecide(kind);
    assert.deepEqual(JSON.parse(JSON.stringify(m.calls)), [['POST', '/review-requests/r1/' + kind, { comment: 'Fix the unit' }]]);
    assert.match(m.opened[0][1], re);
  }
});

test('44b4: a first approval of two says how many are recorded and that a different reviewer must approve next', async () => {
  const m = make({ result: { finalized: false, approvals: 1, required: 2 } }); m.t.setCur({ d: detail(), chk: ticked(make().t.reviewChecks(detail(), 'me', {})) });
  await m.t.reviewDecide('approve'); assert.match(m.opened[0][1], /1 of 2.*different reviewer/);
});

test('44b4: a refused call shows the server\'s message, does not reload, and turns the buttons back on', async () => {
  const m = make({ fail: 'You cannot review your own request' }); m.t.setCur({ d: detail(), chk: {} }); m.get('revComment').value = 'no';
  await m.t.reviewDecide('reject');
  assert.match(m.get('revActMsg').textContent, /Not saved: You cannot review your own request/);
  assert.equal(m.opened.length, 0); assert.ok(m.buttons.every((b) => b.disabled === false));
});

test('44b4: without the server or the role nothing is sent', async () => {
  const m = make({ can: false }); m.t.setCur({ d: detail(), chk: {} }); m.get('revComment').value = 'x';
  await m.t.reviewDecide('reject'); assert.equal(m.calls.length, 0);
});

test('44b4: wiring: reviewOpen draws the block after the page, keeps the checklist only in the page, and the handlers are delegated', () => {
  const a = html.indexOf('async function reviewOpen('), body = html.slice(a, html.indexOf("$('revOut').addEventListener", a));
  assert.ok(body.indexOf('reviewPageHtml(') < body.indexOf('reviewActHtml('));
  assert.match(body, /revCur=\{d,chk:\{\}\}/);
  assert.ok(!/'POST'/.test(body), 'reviewOpen only reads');
  assert.match(html, /\$\('revDetailOut'\)\.addEventListener\('change'/);
  assert.match(html, /closest\('\[data-decide\]'\)/);
  const dec = html.slice(html.indexOf('async function reviewDecide('), a);
  assert.ok(dec.indexOf("Store.can('content.review')") < dec.indexOf("Store.api('POST'"));
  assert.ok(!/checklist/.test(dec.slice(dec.indexOf("Store.api('POST'"), dec.indexOf("Store.api('POST'") + 200)), 'the ticks are not sent');
  assert.match(html, /function revShowList\(\)\{revCur=null;/);
});

test('44b4: the page script still parses', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s));
});
