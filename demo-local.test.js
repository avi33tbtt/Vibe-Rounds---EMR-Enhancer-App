'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDemo } = require('./demo-data.js');
const { toLocalCases } = require('./demo-local.js');

const p = require('./demo-personas.json');
const exp = require('./demo-expected.json');
const make = () => generateDemo({ seed: 1, anchor: '2026-11-01T08:00:00Z', personas: Array.isArray(p) ? p : (p.personas || p) });
const data = make();
const local = toLocalCases(data);
const allRows = local.flatMap((c) => Object.values(c.values).flat());

const find = (o, names) => { for (const n of names) { if (typeof o[n] === 'number') return o[n]; if (o.totals && typeof o.totals[n] === 'number') return o.totals[n]; } return undefined; };

test('Demo mode cases and rows equal the generated data', () => {
  assert.equal(local.length, data.cases.length);
  assert.equal(allRows.length, data.rows.length);
  assert.equal(allRows.filter((r) => r.__status === 'entered_in_error').length, data.rows.filter((r) => r.errorReason).length);
  assert.equal(allRows.filter((r) => !r.__at).length, data.rows.filter((r) => !r.rowTime).length);
});

test('Demo mode counts equal demo-expected.json (keys it does not name are reported, not guessed)', (t) => {
  const checks = [['cases', local.length, ['cases']], ['rows', allRows.length, ['rows']], ['inError', allRows.filter((r) => r.__status === 'entered_in_error').length, ['inError', 'errors', 'enteredInError']]];
  for (const [label, got, names] of checks) {
    const want = find(exp, names);
    if (want === undefined) t.diagnostic(`demo-expected.json has no key for ${label} (tried ${names.join(', ')}); top-level keys: ${Object.keys(exp).join(', ')}`);
    else assert.equal(got, want, label);
  }
});

test('every case carries the demo marker and a synthetic MRN pattern; ids are unique', () => {
  assert.ok(local.every((c) => c.demo === true && /^DEMO-\d\d[A-Z]?$/.test(c.patient.mrn)));
  assert.equal(new Set(local.map((c) => c.id)).size, local.length);
  assert.equal(new Set(allRows.map((r) => r.__id)).size, allRows.length);
});

test('same input gives identical output', () => {
  assert.deepEqual(toLocalCases(data), toLocalCases(make()));
});
