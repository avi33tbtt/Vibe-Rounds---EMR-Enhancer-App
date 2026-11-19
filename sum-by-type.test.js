'use strict';
// node --test sum-by-type.test.js
// Chunk 37c1: sumByType in enhancer.html is a plain sum of entered rows; no target, no comparison.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('./enhancer.html', 'utf8');
const grab = (re) => { const m = html.match(re); assert.ok(m, 'not found: ' + re); return m[0]; };
const code = grab(/const fnum=.*\n/) + grab(/function sumByType\(.*\n/);
const ctx = {}; vm.createContext(ctx); vm.runInContext(code + ';this.sumByType=sumByType;', ctx);
const sumByType = ctx.sumByType;

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
});
