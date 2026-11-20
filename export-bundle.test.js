'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { deidentify, sha256 } = require('./export-bundle.js');

const row = (o) => Object.assign({ patientId: 'PAT-secret-1', encounterId: 'ENC-secret-1', caseId: 'CASE-secret-1', rowId: 'ROW-secret-1',
  resource: 'Observation', role: 'quantity', unit: 'widgets', codings: [], valueNumber: 7, valueText: null, time: '2026-03-02T12:00:00Z', status: 'active',
  source: { setId: 'x.made_up', setVersion: 1, fieldId: 'field-secret-1' } }, o);
const opts = { salt: 'salt-1', encounterStarts: { 'ENC-secret-1': '2026-03-01T12:00:00Z' } };

test('sha256 matches node:crypto (including non-ASCII and long input)', () => {
  for (const s of ['', 'abc', 'é漢字', 'x'.repeat(1000)]) assert.equal(sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
});

test('same input gives the same pseudonym; another salt gives another', () => {
  const a = deidentify([row()], opts), b = deidentify([row()], opts), c = deidentify([row()], { ...opts, salt: 'salt-2' });
  assert.deepEqual(a, b);
  assert.notEqual(a[0].pseudoPatient, c[0].pseudoPatient);
  assert.throws(() => deidentify([row()], { salt: '' }));
});

test('no original id string appears anywhere in the output', () => {
  const text = JSON.stringify(deidentify([row(), row({ rowId: 'ROW-secret-2' })], opts));
  for (const s of ['PAT-secret-1', 'ENC-secret-1', 'CASE-secret-1', 'ROW-secret-1', 'ROW-secret-2', 'x.made_up', 'field-secret-1']) assert.ok(!text.includes(s), s);
  assert.ok(!('patientId' in deidentify([row()], opts)[0]));
});

test('dates become days since the encounter start; a null time stays null; unknown start gives null', () => {
  const r = deidentify([row(), row({ time: null }), row({ encounterId: 'ENC-other' })], opts);
  assert.equal(r[0].daysSinceStart, 1);
  assert.equal(r[1].daysSinceStart, null);
  assert.equal(r[2].daysSinceStart, null);
  assert.ok(!JSON.stringify(r).includes('2026-03'));
});

test('a merged patient (caller passes the final id) has one pseudonym; a row with no patient is dropped', () => {
  const r = deidentify([row({ rowId: 'a' }), row({ rowId: 'b' }), row({ patientId: null })], opts);
  assert.equal(r.length, 2);
  assert.equal(new Set(r.map((x) => x.pseudoPatient)).size, 1);
  assert.notEqual(r[0].id, r[1].id);
});
