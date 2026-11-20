const test = require('node:test');
const assert = require('node:assert');
const { seedSets, readSeedSets } = require('./seed.js');

/* Fake db: no rows exist yet, every query succeeds. Enough to exercise the validation in seedSets without a database. */
const fakeDb = () => ({ withTx: async (fn) => fn({ query: async () => ({ rows: [] }) }) });

/* Made-up set, not a seed set. */
const madeUp = (view) => ({ setId: 'test.badview', kind: 'care', version: 1, title: 'x', contexts: ['care'], requires: [], suggests: [], sections: [
  { title: 'Rows', fields: [{ id: 't_when', label: 'When', type: 'datetime', repeat: true, group: 'g' }] }], view });

test('a seed with a bad view stops seeding and names the set id', async () => {
  await assert.rejects(() => seedSets(fakeDb(), [madeUp({ type: 'flowsheet', timeField: 'missing_field' })]), /test\.badview/);
});

test('a seed with a banned view key is refused', async () => {
  await assert.rejects(() => seedSets(fakeDb(), [madeUp({ type: 'flowsheet', timeField: 't_when', threshold: 1 })]), /test\.badview/);
});

test('a seed with a good view still seeds', async () => {
  const r = await seedSets(fakeDb(), [madeUp({ type: 'flowsheet', timeField: 't_when' })]);
  assert.strictEqual(r.inserted, 1);
});

test('the real element-sets.js still seeds', async () => {
  const sets = readSeedSets();
  const r = await seedSets(fakeDb(), sets);
  assert.strictEqual(r.inserted, sets.length);
});
