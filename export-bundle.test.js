'use strict';
// node --test export-bundle.test.js  (no database). F7a: deidentify() on made-up rows.
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const X = require('./export-bundle.js');

const SALT = 'made-up-salt-1';
const P1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', E1 = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee', C1 = 'cccccccc-1111-4111-8111-cccccccccccc';
const row = (o) => ({ patientId: P1, encounterId: E1, caseId: C1, rowId: 'rrrrrrrr-0001-4111-8111-rrrrrrrrrrrr', resource: 'Observation', role: 'quantity', unit: 'widgets',
  system: null, code: null, valueNumber: 7, valueText: null, time: '2026-03-02T12:00:00Z', status: 'active', source: { setId: 'made.set', setVersion: 1, fieldId: 'made_field' }, ...o });
const starts = { [E1]: '2026-03-01T00:00:00Z' };

test('the HMAC matches Node crypto, for a short and a long key and an empty and a long message', () => {
  for (const [k, m] of [['k', ''], [SALT, 'patient|' + P1], ['x'.repeat(100), 'y'.repeat(200)]]) {
    assert.equal(X._hmacHex(k, m), crypto.createHmac('sha256', k).update(m).digest('hex'));
  }
});
test('same input and salt give the same pseudonyms; another salt gives different ones', () => {
  const a = X.deidentify([row()], { salt: SALT, encounterStarts: starts })[0], b = X.deidentify([row()], { salt: SALT, encounterStarts: starts })[0];
  assert.deepEqual(a, b);
  const c = X.deidentify([row()], { salt: 'another-salt-2', encounterStarts: starts })[0];
  for (const k of ['patientId', 'encounterId', 'caseId', 'rowId']) assert.notEqual(a[k], c[k], k);
});
test('no original id, set id, field id or timestamp string appears in the output', () => {
  const out = JSON.stringify(X.deidentify([row()], { salt: SALT, encounterStarts: starts }));
  for (const s of [P1, E1, C1, 'rrrrrrrr-0001', 'made.set', 'made_field', '2026-03-02', '2026-03-01']) assert.ok(!out.includes(s), s);
});
test('days since the encounter start; null time stays null; a time with no known start is withheld, not guessed', () => {
  const o = X.deidentify([row(), row({ time: null }), row({ encounterId: 'unknown-enc' }), row({ time: 'not a date' })], { salt: SALT, encounterStarts: starts });
  assert.equal(o[0].daysFromStart, 1.5); assert.equal(o[1].daysFromStart, null); assert.equal(o[2].daysFromStart, null); assert.equal(o[3].daysFromStart, null);
  assert.equal(X.deidentify([row()], { salt: SALT, encounterStarts: new Map([[E1, '2026-03-01T00:00:00Z']]) })[0].daysFromStart, 1.5);
});
test('a merged patient (caller passes the final id) appears once; two patients stay two', () => {
  const o = X.deidentify([row(), row({ rowId: 'r2' }), row({ rowId: 'r3', patientId: 'other-patient' })], { salt: SALT, encounterStarts: starts });
  assert.equal(new Set(o.map((r) => r.patientId)).size, 2); assert.equal(o[0].patientId, o[1].patientId);
});
test('only the fixed keys are copied: name, mrn, phone, national id and source never come through', () => {
  const o = X.deidentify([row({ name: 'Made Up', mrn: 'MRN123', phone: '555', nationalId: 'N9', source: { setId: 'x' } })], { salt: SALT, encounterStarts: starts })[0];
  assert.deepEqual(Object.keys(o), X.KEYS);
  assert.ok(!JSON.stringify(o).match(/Made Up|MRN123|555|N9/));
});
test('values of text, actor and link rows are withheld unless keepFreeText is set; other values stay as recorded', () => {
  const rows = [row({ role: 'text', valueText: 'Mrs Made Up' }), row({ role: 'actor', valueText: 'AB' }), row({ role: 'link', valueText: 'x' }), row({ role: 'category', valueText: 'female' })];
  const o = X.deidentify(rows, { salt: SALT, encounterStarts: starts });
  assert.deepEqual(o.map((r) => r.valueText), [null, null, null, 'female']);
  assert.equal(X.deidentify(rows, { salt: SALT, encounterStarts: starts, keepFreeText: true })[0].valueText, 'Mrs Made Up');
});
test('a missing or short salt throws; the input rows are not changed; a null id stays null', () => {
  assert.throws(() => X.deidentify([row()], {}), /salt/); assert.throws(() => X.deidentify([row()], { salt: 'short' }), /salt/);
  const r = row(), copy = JSON.parse(JSON.stringify(r)); X.deidentify([r], { salt: SALT, encounterStarts: starts }); assert.deepEqual(r, copy);
  assert.equal(X.deidentify([row({ patientId: null })], { salt: SALT })[0].patientId, null);
});
