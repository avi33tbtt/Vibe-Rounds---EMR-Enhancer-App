'use strict';
// node --test set-fork-ui.test.js  (no database). 42b7, browser half.
// (1) Store.saveSet in server mode sends forkedFrom {setId, version} for a NEW fork only, and never a hash.
// (2) enhancer.html: forkSet exists, uses forkEntry and contentHashOf, saves through Store.saveSet, and the button is shown only for read-only sets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function makeStore() {
  const calls = [];
  const fetch = async (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : undefined;
    calls.push({ method: (o && o.method) || 'GET', url, body });
    const json = /\/csrf$/.test(url) ? { token: 't' } : { version: body && body.expectedVersion ? body.expectedVersion + 1 : 1 };
    return { ok: true, status: 200, json: async () => json };
  };
  const ctx = vm.createContext({ fetch, setTimeout, clearTimeout, setInterval, clearInterval, console });
  vm.runInContext(fs.readFileSync(require.resolve('./store.js'), 'utf8'), ctx);
  const Store = vm.runInContext('Store', ctx);
  Store.ready = true;
  return { Store, calls };
}
const sets = (calls) => calls.filter((c) => c.method === 'POST' && /\/api\/element-sets$/.test(c.url));
const fork = (v) => ({ setId: 'local.copy', kind: 'custom', version: v, title: 'Copy', tier: 'local-draft', readOnly: false, source: 'local', forkedFrom: { setId: 'mk.orig', version: 1, contentHash: 'sha256:client-side' } });

test('42b7: a new fork is sent with forkedFrom {setId, version} and no hash', async () => {
  const { Store, calls } = makeStore();
  assert.equal(Store.mode, 'server');
  assert.equal(Store.saveSet(fork(1)), true);
  await Store.flush();
  const p = sets(calls);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body.forkedFrom, { setId: 'mk.orig', version: 1 });
  assert.equal(p[0].body.expectedVersion, undefined);
});

test('42b7: the next version of the fork carries expectedVersion and no forkedFrom', async () => {
  const { Store, calls } = makeStore();
  Store.saveSet(fork(1)); await Store.flush();
  Store.saveSet(fork(2)); await Store.flush();
  const p = sets(calls);
  assert.equal(p.length, 2);
  assert.equal(p[1].body.forkedFrom, undefined);
  assert.equal(p[1].body.expectedVersion, 1);
});

test('42b7: a plain new set sends no forkedFrom, and a malformed forkedFrom is not sent', async () => {
  const { Store, calls } = makeStore();
  Store.saveSet({ setId: 'user.a', kind: 'custom', version: 1, title: 'A' });
  Store.saveSet(Object.assign(fork(1), { setId: 'local.bad', forkedFrom: { setId: 'no spaces allowed', version: 1 } }));
  await Store.flush();
  sets(calls).forEach((c) => assert.equal(c.body.forkedFrom, undefined));
});

test('42b7: enhancer.html has the fork path and shows the button only for read-only sets', () => {
  const html = fs.readFileSync(require.resolve('./enhancer.html'), 'utf8');
  const m = /async function forkSet\(id\)\{[\s\S]*?\n(?=function asSet)/.exec(html);
  assert.ok(m, 'forkSet not found');
  assert.match(m[0], /PackageLint\.forkEntry\(/);
  assert.match(m[0], /PackageLint\.contentHashOf\(/);
  assert.match(m[0], /Store\.saveSet\(c\)/);
  assert.doesNotMatch(m[0], /Store\.saveSet\(s\)/, 'the original must never be saved');
  assert.match(html, /\$\{s\.readOnly\?`<button[^`]*forkSet\(/);
});
