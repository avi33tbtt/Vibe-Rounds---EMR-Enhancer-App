'use strict';
// R8a: pure helpers the screen uses to show an element's access and to hide controls. No database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeAccess, accessAllows, ACCESS_ACTIONS, ACCESS_BASE_ACTION } = require('./views.js');
const P = require('./permissions.js');

const full = { view: P.ROLES, enter: ['doctor', 'nurse'], amend: ['doctor'], approve: ['doctor'], configure: ['admin'], export: ['informatician', 'admin'] };

test('describeAccess reads a full block in plain words; a block naming every role reads "everyone"', () => {
  assert.equal(describeAccess(full, P.ROLES),
    'Seen by: everyone. Entered by: doctor, nurse. Corrected by: doctor. Approved by: doctor. Changed by: admin. Exported by: informatician, admin.');
});
test('describeAccess: a missing action reads "no one"; a chosen list of actions limits the line', () => {
  assert.equal(describeAccess({ view: ['viewer'] }, P.ROLES, ['view', 'enter']), 'Seen by: viewer. Entered by: no one.');
});
test('describeAccess: no block says the role rules apply', () => {
  assert.match(describeAccess(undefined, P.ROLES), /not set/);
  assert.match(describeAccess([], P.ROLES), /not set/);
});
test('the base action map equals the server\'s', () => {
  assert.deepEqual(ACCESS_BASE_ACTION, P.ELEMENT_BASE_ACTION);
});
test('accessAllows equals canElement for every role and action when canFn is the role table', () => {
  let n = 0;
  for (const access of [full, { enter: ['viewer', 'nurse'] }, { view: P.ROLES }, {}]) for (const role of P.ROLES) for (const action of ACCESS_ACTIONS) {
    const user = { id: 'u', role };
    assert.equal(accessAllows({ access }, role, action, (a) => P.can(user, a)), P.canElement(user, { access }, action), role + ' ' + action);
    n++;
  }
  assert.ok(n > 0);
});
test('accessAllows: no block returns true (the role rules decide elsewhere); an unknown action is false', () => {
  assert.equal(accessAllows({}, 'viewer', 'enter', () => false), true);
  assert.equal(accessAllows({ access: full }, 'doctor', 'delete', () => true), false);
});
test('accessAllows: without canFn only the element\'s list decides', () => {
  assert.equal(accessAllows({ access: full }, 'nurse', 'enter'), true);
  assert.equal(accessAllows({ access: full }, 'nurse', 'amend'), false);
});
