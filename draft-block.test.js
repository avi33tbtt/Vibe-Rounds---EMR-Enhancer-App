'use strict';
// 43b5 (browser half): a draft made from a request is never added to a real chart. No database needed.
// The three helpers are taken from enhancer.html as text and run in a vm, so this tests the code the page really holds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(__dirname + '/enhancer.html', 'utf8');
const lines = html.split('\n');
const take = (re) => { const l = lines.filter((x) => re.test(x)); assert.equal(l.length, 1, 'expected exactly one line for ' + re); return l[0]; };
const src = [take(/^const isReqDraft=/), take(/^const caseIsSynthetic=/), take(/^let APPLY_BLOCK=/), take(/^function draftBlock\(/)].join('\n');
function load(mode) {
  const ctx = vm.createContext({ Store: { mode } });
  vm.runInContext(src + '\nthis.t={isReqDraft,caseIsSynthetic,draftBlock,block:()=>APPLY_BLOCK};', ctx);
  return ctx.t;
}
const draft = (extra) => Object.assign({ setId: 'user.d', title: 'My draft', tier: 'local-draft', provenance: { requestText: 'a form', model: 'm', at: '2026-01-01T00:00:00Z' } }, extra);

test('43b5: a request draft is refused on a real chart, with a message that names it', () => {
  const t = load('server');
  assert.equal(t.draftBlock({ id: 'c1' }, draft()), true);
  assert.match(t.block(), /My draft/); assert.match(t.block(), /not been approved/);
});

test('43b5: the same draft is allowed on a demo chart, a synthetic chart and in Demo mode', () => {
  assert.equal(load('server').draftBlock({ id: 'c1', demo: true }, draft()), false);
  assert.equal(load('local').draftBlock({ id: 'c1' }, draft()), false);
  assert.equal(load('server').caseIsSynthetic({ id: 'c1', demo: false }), false);
});

test('43b5: an approved set (local-reviewed or marketplace-verified) is not blocked, and a set that did not come from a request is not blocked', () => {
  const t = load('server');
  assert.equal(t.draftBlock({ id: 'c1' }, draft({ tier: 'local-reviewed' })), false);
  assert.equal(t.draftBlock({ id: 'c1' }, draft({ tier: 'marketplace-verified' })), false);
  assert.equal(t.draftBlock({ id: 'c1' }, { setId: 'user.h', title: 'Hand made', tier: 'local-draft' }), false);
  assert.equal(t.draftBlock({ id: 'c1' }, null), false);
});

test('43b5: a draft with no tier at all is still blocked (never treated as approved)', () => {
  const t = load('server'), d = draft(); delete d.tier;
  assert.equal(t.draftBlock({ id: 'c1' }, d), true);
});

test('43b5: both ways of adding to a chart check the block first', () => {
  for (const name of ['applySet', 'applyPathway']) {
    const l = lines.find((x) => new RegExp('^(async )?function ' + name + '\\(').test(x));
    assert.ok(l, name + ' not found');
    assert.ok(/draftBlock\(c,/.test(l), name + ' does not call draftBlock');
  }
});
