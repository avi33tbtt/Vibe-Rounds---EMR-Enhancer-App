'use strict';
// Row R9d-3: the back-dated series, the entered-in-error marker, and the archive-only reset of scripts/seed-longitudinal.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, PW } = require('./helpers');
const { seedLongitudinal, PATIENT, CASE_TITLE } = require('../scripts/seed-longitudinal');
const content = require('../longitudinal-demo-content');

let env;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });
const q = async (sql, args) => (await env.pool.query(sql, args)).rows;
const series = content.buildSeries();
const VISIT_DATES = content.VISITS.map(v => v.slice(0, 10));

test('the series is recorded back-dated: every effective time is a past visit date, recorded_at is the seed time', async () => {
  const a = await seedLongitudinal({ base: env.base, password: PW });
  assert.equal(a.observationCount, series.length);
  const obs = await q('SELECT field_key, effective_at, recorded_at, status FROM observations WHERE case_id = $1', [a.caseId]);
  assert.equal(obs.length, series.length);
  assert.ok(obs.every(o => +o.effective_at < +o.recorded_at));
  const days = new Set(obs.map(o => o.effective_at.toISOString().slice(0, 10)));
  assert.deepEqual([...days].sort(), VISIT_DATES.filter(d => series.some(p => p.effectiveAt.startsWith(d))).sort());
  assert.ok(+new Date(content.VISITS[content.VISITS.length - 1]) - +new Date(content.VISITS[0]) > 3.5 * 365 * 864e5);   // about four years
});

test('Unknown, missing and entered in error stay distinct', async () => {
  const [c] = await q('SELECT id FROM clinical_cases WHERE title = $1', [CASE_TITLE]);
  const at = x => `${x.fieldKey}`;
  const unk = await q(`SELECT field_key, effective_at, value_json FROM observations WHERE case_id = $1 AND value_type = 'unknown'`, [c.id]);
  assert.equal(unk.length, 1);
  assert.equal(unk[0].field_key, content.UNKNOWN_AT.fieldKey);
  assert.equal(unk[0].value_json, null);
  const miss = await q(`SELECT 1 FROM observations WHERE case_id = $1 AND field_key = $2 AND effective_at = $3::timestamptz`, [c.id, content.MISSING.map(at)[0], content.MISSING[0].effectiveAt]);
  assert.equal(miss.length, 0);                                    // no row at all, not zero and not Unknown
  const err = await q(`SELECT value_json, error_by, error_at, error_reason FROM observations WHERE case_id = $1 AND status = 'entered_in_error'`, [c.id]);
  assert.equal(err.length, 1);
  assert.equal(Number(err[0].value_json), content.ERROR_AT.wrongValue);   // the row and its wrong value are kept
  assert.ok(err[0].error_by && err[0].error_at && err[0].error_reason);
  const same = await q(`SELECT status, value_json FROM observations WHERE case_id = $1 AND field_key = $2 AND effective_at = $3::timestamptz ORDER BY id`, [c.id, content.ERROR_AT.fieldKey, content.VISITS[content.ERROR_AT.visit]]);
  assert.deepEqual(same.map(r => r.status), ['entered_in_error', 'final']);   // the right value is a separate new row
});

test('running again changes nothing', async () => {
  const snap = async () => JSON.stringify(await q('SELECT count(*) o, max(id) m FROM observations'));
  const before = await snap();
  const b = await seedLongitudinal({ base: env.base, password: PW });
  assert.equal(b.created, false);
  assert.equal(await snap(), before);
});

test('reset archives the old case with its values (nothing deleted) and makes one fresh active case', async () => {
  const [old] = await q(`SELECT id FROM clinical_cases WHERE title = $1 AND status = 'active'`, [CASE_TITLE]);
  const r = await seedLongitudinal({ base: env.base, password: PW, reset: true });
  assert.equal(r.created, true);
  assert.notEqual(r.caseId, old.id);
  const cases = await q(`SELECT id, status FROM clinical_cases WHERE title = $1 ORDER BY id`, [CASE_TITLE]);
  assert.deepEqual(cases.map(c => c.status), ['archived', 'active']);
  assert.equal((await q('SELECT count(*)::int n FROM observations WHERE case_id = $1', [old.id]))[0].n, series.length);   // old values still there
  assert.equal((await q('SELECT count(*)::int n FROM observations WHERE case_id = $1', [r.caseId]))[0].n, series.length);
  assert.equal((await q('SELECT count(*)::int n FROM patients WHERE mrn = $1', [PATIENT.mrn]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int n FROM element_sets'))[0].n, content.SETS.length);   // content reused, not duplicated
});

test('ordinary records are untouched by a reset', async () => {
  const p = (await q(`INSERT INTO patients(name, mrn, dob, sex, created_by) VALUES ('Ordinary, Pat','ORD-1','1980-01-01','U',(SELECT id FROM users WHERE username='doctor1')) RETURNING id`))[0].id;
  const c = (await q(`INSERT INTO clinical_cases(patient_id, title, created_by) VALUES ($1,'Ordinary case',(SELECT id FROM users WHERE username='doctor1')) RETURNING id`, [p]))[0].id;
  await seedLongitudinal({ base: env.base, password: PW, reset: true });
  assert.deepEqual((await q('SELECT status FROM clinical_cases WHERE id = $1', [c])).map(x => x.status), ['active']);
});
