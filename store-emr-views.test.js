'use strict';
// node --test store-emr-views.test.js  (no database, no browser)
// Phase V, V7b: Store.emrViews() is the list of EMR view pathways that are switched on.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./store.js');
const Store = globalThis.Store;
const DEFAULT = ['pathway.emr.ward_board', 'pathway.emr.handover'];
const set = (mode, me) => { Store.mode = mode; Store.me = me; };

test('V7b: server mode returns the list /me carried, as a copy', () => {
  set('server', { id: 'u', role: 'nurse', emrViews: ['pathway.emr.handover'] });
  const a = Store.emrViews();
  assert.deepEqual(a, ['pathway.emr.handover']);
  a.push('x'); assert.deepEqual(Store.emrViews(), ['pathway.emr.handover'], 'changing the result does not change the store');
});
test('V7b: an empty list means every view pathway is off', () => {
  set('server', { id: 'u', emrViews: [] });
  assert.deepEqual(Store.emrViews(), []);
});
test('V7b: no list from the server (older server, no /me yet, or a bad value) gives the default list', () => {
  set('server', { id: 'u' }); assert.deepEqual(Store.emrViews(), DEFAULT);
  set('server', null); assert.deepEqual(Store.emrViews(), DEFAULT);
  set('server', { id: 'u', emrViews: 'nope' }); assert.deepEqual(Store.emrViews(), DEFAULT);
});
test('V7b: entries that are not text are dropped', () => {
  set('server', { id: 'u', emrViews: ['pathway.emr.handover', 5, null, { a: 1 }] });
  assert.deepEqual(Store.emrViews(), ['pathway.emr.handover']);
});
test('V7b: Demo mode always uses the default list', () => {
  set('local', { id: 'demo', name: 'Demo user', role: 'admin' }); assert.deepEqual(Store.emrViews(), DEFAULT);
  set('local', { id: 'demo', emrViews: ['pathway.emr.handover'] }); assert.deepEqual(Store.emrViews(), DEFAULT, 'Demo mode has no admin choice');
});
