'use strict';
/* 42b5: Store.saveSet refuses to change a stored read-only set. Demo (local) mode with a fake localStorage; made-up sets only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const mem = {};
globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
mem.storeMode = 'local';
require('./store.js');
const Store = globalThis.Store;
const toasts = []; Store.hooks.toast = (m) => toasts.push(m);
const S = Store._test.S;
const mk = (id, extra) => Object.assign({ setId: id, kind: 'care', version: 1, title: id, sections: [] }, extra || {});

test('42b5: a read-only stored set cannot be saved over, even with a new version', () => {
  S.sets.push(mk('zz.locked', { readOnly: true, tier: 'marketplace-verified' }));
  assert.equal(Store.setIsReadOnly('zz.locked'), true);
  assert.equal(Store.saveSet(mk('zz.locked', { title: 'changed', readOnly: false })), false);
  assert.equal(Store.saveSet(mk('zz.locked', { version: 2 })), false);
  const now = Store.userSets().find((x) => x.setId === 'zz.locked');
  assert.equal(now.title, 'zz.locked'); assert.equal(now.version, 1); assert.equal(now.readOnly, true);
  assert.equal(toasts.length, 2);
});

test('42b5: a refused save writes nothing to storage and keeps no old-version copy', () => {
  const before = mem.sets;
  Store.saveSet(mk('zz.locked', { version: 3 }));
  assert.equal(mem.sets, before);
  assert.equal(Store.setVersion('zz.locked', 3), null);
});

test('42b5: an ordinary set and a new set save as before', () => {
  S.sets.push(mk('zz.mine'));
  assert.equal(Store.setIsReadOnly('zz.mine'), false);
  assert.equal(Store.saveSet(mk('zz.mine', { version: 2, title: 'edited' })), true);
  assert.equal(Store.userSets().find((x) => x.setId === 'zz.mine').title, 'edited');
  assert.equal(Store.saveSet(mk('zz.new')), true);
  assert.equal(Store.setIsReadOnly('zz.unknown'), false);
});

test('42b5: only readOnly === true counts (a string or a missing value does not lock a set)', () => {
  S.sets.push(mk('zz.odd', { readOnly: 'true' }));
  assert.equal(Store.setIsReadOnly('zz.odd'), false);
});
