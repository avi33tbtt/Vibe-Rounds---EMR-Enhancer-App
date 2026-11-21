const { test } = require('node:test');
const assert = require('node:assert');
const EB = require('./export-bundle');

const rowsIn = [
  { patientId: 'pat-777', encounterId: 'enc-9', caseId: 'case-3', rowId: 'row-1', fieldId: 'zz_secret_field', setId: 'zz_secret_set',
    resource: 'Observation', role: 'quantity', unit: 'widgets', system: 'http://example.org/made-up', code: 'MU-1', valueNumber: 4, time: '2026-01-02T10:00:00Z', status: 'final' },
  { patientId: 'pat-777', encounterId: 'enc-9', caseId: 'case-3', rowId: 'row-2', fieldId: 'zz_other', setId: 'zz_secret_set',
    resource: 'Observation', role: 'quantity', unit: 'widgets', valueNumber: 6, time: '2026-01-02T12:00:00Z', status: 'final' },
];
const deid = () => EB.deidentify(rowsIn, { salt: 'test-salt-123', encounterStarts: { 'enc-9': '2026-01-02T00:00:00Z' } });

test('F7b: ids are stable on repeat export and requests are PUT by id', () => {
  const a = EB.buildExportBundle(deid()), b = EB.buildExportBundle(deid());
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.entry[0].request.url, 'Observation/' + a.entry[0].resource.id);
});

test('F7b: a code appears only when the row carries one', () => {
  const e = EB.buildExportBundle(deid()).entry;
  assert.ok(e[0].resource.code);
  assert.strictEqual(e[1].resource.code, undefined);
});

test('F7b: manifest and bundle hold no set id, field id or original id', () => {
  const s = JSON.stringify([EB.buildManifest(deid()), EB.buildExportBundle(deid())]);
  ['zz_secret_field', 'zz_secret_set', 'zz_other', 'pat-777', 'enc-9', 'case-3'].forEach(x => assert.ok(!s.includes(x), x));
  assert.strictEqual(EB.buildManifest(deid()).elements.reduce((n, e) => n + e.count, 0), 2);
});
