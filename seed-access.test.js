'use strict';
// node --test seed-access.test.js  (no database)
// R5: every seed set carries an access block that reproduces today's role rules, and seed.js refuses a set without one.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./permissions.js');
const { validateAccess } = require('./views.js');
const { readSeedSets, seedSets } = require('./seed.js');

const sets = readSeedSets();
const user = (role) => ({ id: 'u1', role });
const fakeDb = () => ({ withTx: async (fn) => fn({ query: async () => ({ rows: [] }) }) });   // no stored rows: every set is new

test('every seed set has a valid access block', () => {
  assert.ok(sets.length > 0);
  for (const s of sets) assert.deepStrictEqual(validateAccess(s, P.ROLES).errors, [], s.setId);
});
test('for every seed set and role, canElement equals the old rules for view, enter and amend', () => {
  let n = 0;
  for (const s of sets) for (const role of P.ROLES) {
    assert.equal(P.canElement(user(role), s, 'view'), P.can(user(role), 'case.read'), s.setId + ' view ' + role);
    assert.equal(P.canElement(user(role), s, 'enter'), P.canAddRow(user(role), s.kind), s.setId + ' enter ' + role);
    assert.equal(P.canElement(user(role), s, 'amend'), P.canAmendRow(user(role), { entered_by: 'u1' }, s.kind), s.setId + ' amend ' + role);
    n += 3;
  }
  console.log('seed access cases:', n);
});
test('the EMR view pathways are switched on and off by an admin only', () => {
  const views = sets.filter((s) => /^pathway\.emr\./.test(s.setId));
  assert.ok(views.length >= 2);
  for (const s of views) for (const role of P.ROLES) assert.equal(P.canElement(user(role), s, 'configure'), role === 'admin', s.setId + ' ' + role);
});
test('seedSets accepts every seed set', async () => {
  assert.equal((await seedSets(fakeDb(), sets)).inserted, sets.length);
});
test('seedSets refuses a set with no access block, and one with a bad block', async () => {
  const made = { setId: 'made.no_access', kind: 'care', sections: [] };
  await assert.rejects(seedSets(fakeDb(), [made]), /bad access block/);
  await assert.rejects(seedSets(fakeDb(), [{ ...made, access: { enter: ['porter'] } }]), /unknown role/);
});
