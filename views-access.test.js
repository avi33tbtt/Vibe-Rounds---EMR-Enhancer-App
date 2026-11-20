'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateAccess, ACCESS_ACTIONS } = require('./views.js');
const { ROLES } = require('./permissions.js');

const madeUp = (access) => ({ setId: 'made.up_set', sections: [{ fields: [{ id: 'x1', type: 'text' }] }], access });
const errs = (access) => validateAccess(madeUp(access), ROLES).errors;

test('a valid access block passes', () => {
  assert.deepStrictEqual(errs({ view: ['viewer', 'nurse'], enter: ['nurse', 'doctor'], amend: ['doctor'], approve: ['doctor'], configure: ['admin'], export: ['informatician', 'admin'] }), []);
});
test('an omitted action passes (default deny)', () => {
  assert.deepStrictEqual(errs({ view: ['viewer'] }), []);
});
test('the six action names are the closed list', () => {
  assert.deepStrictEqual(ACCESS_ACTIONS, ['view', 'enter', 'amend', 'approve', 'configure', 'export']);
});
test('no access block is an error', () => {
  assert.strictEqual(validateAccess({ setId: 'made.up_set' }, ROLES).errors.length, 1);
  assert.match(errs(undefined)[0], /no access block/);
});
test('access that is not an object is an error', () => {
  assert.match(errs(['view'])[0], /must be an object/);
  assert.match(errs('all')[0], /must be an object/);
});
test('an unknown action name is an error', () => {
  const e = errs({ view: ['viewer'], delete: ['admin'] });
  assert.strictEqual(e.length, 1);
  assert.match(e[0], /unknown action "delete"/);
});
test('a value that is not a list, or an empty list, is an error', () => {
  assert.match(errs({ view: 'viewer' })[0], /non-empty list/);
  assert.match(errs({ view: [] })[0], /non-empty list/);
});
test('an unknown role is an error', () => {
  assert.match(errs({ view: ['viewer', 'porter'] })[0], /unknown role "porter"/);
});
test('an entry that is not text is an error', () => {
  assert.match(errs({ view: [7] })[0], /not text/);
});
test('a duplicate role is an error', () => {
  assert.match(errs({ enter: ['nurse', 'nurse'] })[0], /more than once/);
});
