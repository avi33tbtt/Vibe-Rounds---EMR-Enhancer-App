'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { canElement, ELEMENT_BASE_ACTION, can, ROLES } = require('./permissions.js');
const { ACCESS_ACTIONS } = require('./views.js');

const user = (role) => ({ id: 'u1', role });
const el = (access) => ({ setId: 'made.up_set', access });
const everyone = { view: ROLES, enter: ROLES, amend: ROLES, approve: ROLES, configure: ROLES, export: ROLES };

test('every element action has a base action in the table', () => {
  assert.deepStrictEqual(Object.keys(ELEMENT_BASE_ACTION), ACCESS_ACTIONS);
  Object.values(ELEMENT_BASE_ACTION).forEach((a) => assert.doesNotThrow(() => can(user('admin'), a)));
});
test('viewer cannot gain enter, even when the element lists viewer', () => {
  assert.strictEqual(canElement(user('viewer'), el({ enter: ['viewer', 'nurse'] }), 'enter'), false);
});
test('nurse listed for enter and allowed by the base table can', () => {
  assert.strictEqual(canElement(user('nurse'), el({ enter: ['nurse', 'doctor'] }), 'enter'), true);
});
test('a role the element does not list cannot, even if the base table allows it', () => {
  assert.strictEqual(can(user('nurse'), 'row.add'), true);
  assert.strictEqual(canElement(user('nurse'), el({ enter: ['doctor'] }), 'enter'), false);
});
test('the element can narrow: listing a role for one action does not give it another', () => {
  assert.strictEqual(canElement(user('doctor'), el({ enter: ['doctor'] }), 'amend'), false);
});
test('no access block means deny', () => {
  assert.strictEqual(canElement(user('admin'), { setId: 'made.up_set' }, 'view'), false);
  assert.strictEqual(canElement(user('admin'), null, 'view'), false);
  assert.strictEqual(canElement(user('admin'), el(['view']), 'view'), false);
});
test('a missing action means no role has it', () => {
  assert.strictEqual(canElement(user('admin'), el({ view: ROLES }), 'configure'), false);
});
test('no user means deny', () => {
  assert.strictEqual(canElement(null, el(everyone), 'view'), false);
});
test('an unknown element action throws', () => {
  assert.throws(() => canElement(user('admin'), el(everyone), 'delete'), /Unknown element action/);
});
test('with everyone listed, the result equals the base table for every role and action', () => {
  for (const r of ROLES) for (const a of ACCESS_ACTIONS) {
    assert.strictEqual(canElement(user(r), el(everyone), a), can(user(r), ELEMENT_BASE_ACTION[a]), r + ' ' + a);
  }
});
test('export: informatician and admin only, even if a doctor is listed', () => {
  const e = el({ export: ['doctor', 'informatician', 'admin'] });
  assert.strictEqual(canElement(user('informatician'), e, 'export'), true);
  assert.strictEqual(canElement(user('admin'), e, 'export'), true);
  assert.strictEqual(canElement(user('doctor'), e, 'export'), false);
});
