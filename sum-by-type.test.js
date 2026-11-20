'use strict';
// node --test sum-by-type.test.js
// V4a: sumBy in views.js is a plain sum of entered rows per key; no target, no comparison.
// The I/O field names are passed in here, as the seed data does. views.js names no set or field.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sumBy } = require('./views.js');

const IO = { timeField: 'io_time', keyField: 'io_type', valueField: 'io_volume' };
const sumByType = (rows, from, to) => sumBy(rows, IO, from, to);

const T = (h) => '2026-11-19T' + String(h).padStart(2, '0') + ':00';
const at = (h) => new Date(T(h)).getTime();
const row = (h, type, vol, extra) => Object.assign({ io_time: T(h), io_type: type, io_volume: vol }, extra);

test('sums volumes per type inside the window', () => {
  const r = [row(8, 'Urine', '200'), row(9, 'Urine', 150), row(9, 'Intake oral', 300)];
  assert.deepEqual(JSON.parse(JSON.stringify(sumByType(r, at(0), at(23)))), { Urine: 350, 'Intake oral': 300 });
});
test('window edges are inclusive; rows outside are left out', () => {
  const r = [row(6, 'Drain', 10), row(8, 'Drain', 20), row(12, 'Drain', 30), row(13, 'Drain', 40)];
  assert.equal(sumByType(r, at(8), at(12)).Drain, 50);
});
test('entered-in-error rows are never counted', () => {
  const r = [row(8, 'Urine', 100, { __status: 'entered_in_error' }), row(8, 'Urine', 50)];
  assert.equal(sumByType(r, at(0), at(23)).Urine, 50);
});
test('rows with no valid time or number are skipped; blank type is grouped apart', () => {
  const r = [row(8, 'Stool', ''), row(8, 'Stool', 'abc'), { io_time: 'bad', io_type: 'Stool', io_volume: 5 }, row(8, '', 7)];
  const out = sumByType(r, at(0), at(23));
  assert.equal(out.Stool, undefined);
  assert.equal(out['(no type)'], 7);
});
test('empty or missing input gives an empty result', () => {
  assert.equal(Object.keys(sumByType([], 0, 1e15)).length, 0);
  assert.equal(Object.keys(sumByType(null, 0, 1e15)).length, 0);
  assert.equal(Object.keys(sumBy([row(8, 'Urine', 1)], null, 0, 1e15)).length, 0);
});
test('a different made-up set works with no code change: only the spec changes', () => {
  const spec = { timeField: 'when', keyField: 'kind', valueField: 'amt' };
  const r = [
    { when: T(8), kind: 'A', amt: '2.5' }, { when: T(9), kind: 'A', amt: 1 },
    { when: T(9), kind: 'B', amt: 4 }, { when: T(9), kind: 'B', amt: 9, __status: 'entered_in_error' },
    { when: T(20), kind: 'B', amt: 100 }, { io_time: T(9), io_type: 'Urine', io_volume: 999 }];
  assert.deepEqual(JSON.parse(JSON.stringify(sumBy(r, spec, at(0), at(12)))), { A: 3.5, B: 4 });
});
