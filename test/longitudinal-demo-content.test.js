'use strict';
// Row R9d-1: the pure demo content for the longitudinal explorer. No database needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('../sets');
const { CONTEXTS, membership } = require('../context-map');
const C = require('../longitudinal-demo-content');

const series = C.buildSeries();
const slugsOf = k => CONTEXTS[k].setSlugs;

test('every set definition passes the server rules for stored sets (no numbers, known keys, no codes)', () => {
  for (const s of C.SETS) assert.deepEqual(validateDefinition(s.definition, s.slug, s.kind), [], s.slug);
  assert.deepEqual(C.SETS.map(s => s.slug), ['dm_ctx', 'hba1c_mon', 'ckd_ctx', 'htn_ctx']);
  const text = JSON.stringify(C.SETS) + JSON.stringify(C.PATHWAY);
  assert.equal(/"(codingPolicy|bindings|code|system)"/.test(text), false, 'no codes');
  assert.equal(/threshold|target|band|dose|goal/i.test(text), false, 'no thresholds, targets, bands or doses');
  assert.ok(text.includes('Synthetic'), 'the sets say they are synthetic');
  assert.match(C.SYNTHETIC_LABEL, /SYNTHETIC DEMO DATA - NOT FOR CLINICAL USE/);
});

test('slugs agree with context-map.js: each set and the pathway place their values in the right context', () => {
  const inMap = new Set(Object.values(CONTEXTS).flatMap(c => c.setSlugs));
  for (const s of C.SETS) assert.ok(inMap.has(s.slug), s.slug + ' is not listed in context-map.js');
  assert.ok(slugsOf('hypertension').includes('htn_ctx') && CONTEXTS.hypertension.pathwaySlugs.includes(C.PATHWAY.slug));
  for (const k of ['diabetes', 'ckd']) assert.ok(CONTEXTS[k].pathwaySlugs.includes(C.PATHWAY.slug), k);
  assert.deepEqual(C.PATHWAY.memberSlugs.slice().sort(), C.SETS.map(s => s.slug).sort());
  const want = { hba1c: 'diabetes', creat: 'ckd', egfr: 'ckd', uacr: 'ckd', sbp: 'hypertension', dbp: 'hypertension' };
  for (const p of series) {
    const m = membership({ kind: 'observation', sourceId: 1, caseId: 1, setSlug: p.setSlug, fieldKey: p.fieldKey }, { 1: [{ setSlug: p.setSlug, pathwaySlug: C.PATHWAY.slug, active: true }] });
    assert.deepEqual(m.contexts.map(c => c.key), [want[p.fieldKey]], p.key);
    assert.deepEqual(m.contexts[0].reasons, ['set:' + p.setSlug, 'pathway:' + C.PATHWAY.slug]);
  }
});

test('every point uses a field and a unit that its set defines', () => {
  const defs = Object.fromEntries(C.SETS.map(s => [s.slug, s.definition.fields]));
  for (const p of series) {
    const f = (defs[p.setSlug] || []).find(x => x.id === p.fieldKey);
    assert.ok(f, p.key + ' has no field'); assert.equal(f.unit, p.unit, p.key); assert.equal(f.type, 'number');
  }
});

test('the series is deterministic, spans 3 to 5 years, is in order and has only past dates', () => {
  assert.deepEqual(C.buildSeries(), series, 'two calls give equal data');
  assert.equal(new Set(series.map(p => p.key)).size, series.length, 'keys are unique');
  const first = Date.parse(series[0].effectiveAt), last = Date.parse(series[series.length - 1].effectiveAt);
  const years = (last - first) / (365.25 * 864e5);
  assert.ok(years >= 3 && years <= 5, 'years: ' + years);
  for (let i = 1; i < series.length; i++) assert.ok(series[i - 1].effectiveAt <= series[i].effectiveAt);
  assert.ok(last < Date.parse('2026-11-26T00:00:00Z'), 'no future dates');
  for (const p of series) assert.match(p.effectiveAt, /^\d{4}-\d{2}-\d{2}T09:00:00Z$/);
  assert.equal(C.VISITS.length, 16);
});

test('exactly one Unknown, one missing and one entered-in-error: three different states, never zero', () => {
  const unknown = series.filter(p => p.unknown);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].value, null, 'an Unknown has no value (not 0)');
  assert.equal(unknown[0].key, 'hba1c_mon.hba1c@2024-03-05');

  assert.equal(C.MISSING.length, 1);
  assert.equal(series.some(p => p.key === C.MISSING[0].key), false, 'a missing value has no point at all');
  assert.equal(series.some(p => p.setSlug === C.MISSING[0].setSlug && p.fieldKey === C.MISSING[0].fieldKey && p.effectiveAt === C.MISSING[0].effectiveAt), false);

  const err = series.filter(p => p.enteredInError);
  assert.equal(err.length, 1);
  const fix = series.filter(p => p.replaces);
  assert.equal(fix.length, 1); assert.equal(fix[0].replaces, err[0].key);
  assert.equal(fix[0].effectiveAt, err[0].effectiveAt); assert.equal(fix[0].fieldKey, err[0].fieldKey);
  assert.notEqual(fix[0].value, err[0].value, 'the correction is a new row with the right value');
  assert.equal(fix[0].enteredInError, false);

  for (const p of series) assert.ok(p.unknown || typeof p.value === 'number', p.key + ' has a number or is an explicit Unknown');
  assert.equal(series.filter(p => p.value === 0).length, 0, 'nothing is zero');
});

test('repeated measurements are really repeated, and the content stays small', () => {
  const per = {};
  for (const p of series) per[p.fieldKey] = (per[p.fieldKey] || 0) + 1;
  for (const k of ['hba1c', 'creat', 'egfr', 'sbp', 'dbp']) assert.ok(per[k] >= 15, k);
  assert.ok(per.uacr >= 6);
  assert.ok(series.length < 120);
});
