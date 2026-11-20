'use strict';
// node --test demo-data.test.js  (pure, no database). Task D2a: made-up personas only; the ids below are invented for the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { generateDemo, validatePersonas } = require('./demo-data.js');

const ANCHOR = '2026-11-01T08:00:00Z';
const made = () => [{
  id: 'D-91', title: 'made up',
  patient: { key: 'p1', name: 'Demo Patient 91', sex: 'female', ageYears: 40, syntheticKey: 'demo-91' },
  encounters: [{ key: 'e1', patient: 'p1', type: 'admission', start: '-48h', end: '-2h', ward: 'W', bed: 'B1' }],
  cases: [{ key: 'c1', patient: 'p1', encounter: 'e1', applied: ['made.up'], pathways: [], narrative: 'x' }],
  series: [{
    case: 'c1', setId: 'made.up', groupId: 'g', timeField: 'f_time', by: 'nurse',
    schedule: { start: '-24h', every: '4h', count: 6, jitter: '10m' },
    fields: { f_num: { gen: 'int', plausible: [10, 20] }, f_sel: { gen: 'cycle', options: ['a', 'b'] } },
    noTime: [1], badTime: [2], skip: [3], inError: [{ index: 4, by: 'doctor', reason: 'wrong patient' }],
    amend: [{ index: 0, by: 'doctor', field: 'f_num', gen: 'int', plausible: [10, 20], reason: 'typo' }],
  }],
  values: [{ case: 'c1', setId: 'made.up', fieldId: 'f_when', at: '-24h', gen: 'date', offset: '+90d' }],
  notes: [{ case: 'c1', at: '-12h', by: 'doctor', text: 'note', sign: true }],
  merge: null,
}, {
  id: 'D-92', title: 'duplicate',
  patient: { key: 'p1', name: 'Demo Patient 92', sex: 'male', ageYears: 30, syntheticKey: 'demo-92' },
  extraPatients: [{ key: 'p2', name: 'Demo Patient 92', sex: 'male', ageYears: 30, syntheticKey: 'demo-92b' }],
  encounters: [], cases: [], series: [], values: [], notes: [],
  merge: { from: 'p2', into: 'p1', by: 'admin', reason: 'duplicate registration' },
}];
const gen = (seed = 1, anchor = ANCHOR, personas = made()) => generateDemo({ seed, anchor, personas });

test('determinism: same seed and anchor give identical output; another seed differs', () => {
  assert.equal(JSON.stringify(gen()), JSON.stringify(gen()));
  assert.notEqual(JSON.stringify(gen(1)), JSON.stringify(gen(2)));
});
test('offsets are applied to the anchor, nothing is later than it, and moving the anchor moves everything', () => {
  const a = gen(), b = gen(1, '2026-11-02T08:00:00Z');
  assert.equal(a.encounters[0].startAt, '2026-10-30T08:00:00.000Z');
  assert.equal(a.encounters[0].endAt, '2026-11-01T06:00:00.000Z');
  assert.ok(a.rows.filter((r) => r.timeKind === 'ok').every((r) => Date.parse(r.rowTime) <= Date.parse(ANCHOR)));
  assert.equal(Date.parse(b.rows[0].rowTime) - Date.parse(a.rows[0].rowTime), 86400000);
});
test('a row with no time, a row with a bad time, and a skipped visit', () => {
  const r = gen().rows;
  assert.equal(r.find((x) => x.index === 1).rowTime, null); assert.equal(r.find((x) => x.index === 1).timeKind, 'none');
  assert.ok(!('f_time' in r.find((x) => x.index === 1).row));
  assert.equal(r.find((x) => x.index === 2).timeKind, 'bad');
  assert.equal(r.find((x) => x.index === 3), undefined); assert.equal(r.length, 5);
});
test('an entered-in-error row carries who and why; an amended row carries its new value and reason', () => {
  const r = gen().rows;
  assert.deepEqual(r.find((x) => x.index === 4).error, { by: 'doctor', reason: 'wrong patient' });
  assert.equal(r.find((x) => x.index === 4).status, 'entered_in_error'); assert.equal(r.find((x) => x.index === 0).status, 'active');
  const am = r.find((x) => x.index === 0).amend; assert.equal(am.reason, 'typo'); assert.ok(Number(am.value) >= 10 && Number(am.value) <= 20);
});
test('a merge link points at patients that exist; values and notes are carried', () => {
  const d = gen(), ids = new Set(d.patients.map((p) => p.id));
  assert.equal(d.merges.length, 1); assert.ok(ids.has(d.merges[0].from) && ids.has(d.merges[0].into));
  assert.equal(d.values[0].value, '2027-01-29');
  assert.equal(d.values[0].at, '2026-10-31T08:00:00.000Z'); assert.equal(d.notes[0].sign, true);
});
test('the persona check refuses banned keys, times after the anchor, broken links and skip + error on one row', () => {
  assert.deepEqual(validatePersonas(made()), []);
  const a = made(); a[0].series[0].fields.f_num.max = 5; assert.match(validatePersonas(a).join(), /banned key "max"/);
  const b = made(); b[0].encounters[0].start = '+1h'; assert.match(validatePersonas(b).join(), /after the anchor/);
  const c = made(); c[0].cases[0].encounter = 'nope'; assert.match(validatePersonas(c).join(), /does not resolve/);
  const d = made(); d[0].series[0].skip = [4]; assert.match(validatePersonas(d).join(), /both skipped and entered in error/);
  assert.throws(() => gen(1, ANCHOR, d), /Bad personas/);
});
test('the generator source names no set, field or option text (rule E1)', () => {
  const src = fs.readFileSync('./demo-data.js', 'utf8');
  assert.ok(!/care\.|intake|io_|hba1c|insulin|glucose/i.test(src));
});

// ---- D2b: the real persona file ----
const vm = require('node:vm');
const sb = { window: {} };
vm.runInNewContext(fs.readFileSync('./element-sets.js', 'utf8'), sb);
const SETS = JSON.parse(JSON.stringify(sb.window.SEED_SETS));
const fileOf = () => JSON.parse(fs.readFileSync('./demo-personas.json', 'utf8'));
const fieldsOf = (setId) => { const s = SETS.find((x) => x.setId === setId); return s ? s.sections.flatMap((x) => x.fields) : null; };

test('demo-personas.json validates and generateDemo runs on it, the same way twice', () => {
  const f = fileOf();
  assert.deepEqual(validatePersonas(f.personas), []);
  const run = () => generateDemo({ seed: f.seed, anchor: f.anchor, personas: f.personas });
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
  assert.ok(f.personas.length >= 4 && run().rows.length > 0);
});
test('every set, group and field a persona names exists in the seed sets, in the right group', () => {
  for (const p of fileOf().personas) {
    for (const c of p.cases) for (const id of [...c.applied, ...c.pathways]) assert.ok(SETS.find((x) => x.setId === id), p.id + ': unknown set ' + id);
    for (const c of p.cases) for (const pw of c.pathways) for (const m of SETS.find((x) => x.setId === pw).members || []) assert.ok(c.applied.includes(m.setId), p.id + ': pathway member ' + m.setId + ' is not applied');
    for (const s of p.series) {
      const fl = fieldsOf(s.setId); assert.ok(fl, p.id + ': unknown set ' + s.setId);
      for (const id of [s.timeField, ...Object.keys(s.fields)]) { const f = fl.find((x) => x.id === id); assert.ok(f, p.id + ': no field ' + id); assert.equal(f.group, s.groupId, p.id + ': ' + id + ' is not in group ' + s.groupId); }
    }
    for (const v of p.values) { const f = (fieldsOf(v.setId) || []).find((x) => x.id === v.fieldId); assert.ok(f, p.id + ': no field ' + v.fieldId); assert.ok(!f.repeat, p.id + ': ' + v.fieldId + ' repeats'); }
  }
});
test('no persona writes a threshold, target or limit field, and generated numbers are only plausible-looking', () => {
  const f = fileOf(), d = generateDemo({ seed: f.seed, anchor: f.anchor, personas: f.personas });
  const ids = [...f.personas.flatMap((p) => p.series.flatMap((s) => Object.keys(s.fields))), ...f.personas.flatMap((p) => p.values.map((v) => v.fieldId))];
  assert.ok(ids.every((id) => !/thr|tgt|target|limit|goal|due/i.test(id)));
  assert.ok(d.rows.every((r) => Object.values(r.row).every((v) => typeof v === 'string')));
});
test('datetime values and a date-typed time field follow the anchor', () => {
  const f = fileOf(), d = generateDemo({ seed: f.seed, anchor: f.anchor, personas: f.personas });
  const val = (id) => d.values.find((v) => v.fieldId === id).value;
  assert.equal(Date.parse(val('arr')) - Date.parse(val('bite')), 3 * 3600000);
  assert.match(d.rows.find((r) => r.groupId === 'hba1c').row.a1c_date, /^\d{4}-\d{2}-\d{2}$/);
  const moved = generateDemo({ seed: f.seed, anchor: '2026-12-01T08:00:00Z', personas: f.personas });
  assert.equal(Date.parse(moved.values.find((v) => v.fieldId === 'bite').value) - Date.parse(val('bite')), 30 * 86400000);
});

// ---- D2c: personas D-05 to D-09 and demo-expected.json ----
const { expectedOf } = require('./demo-data.js');
const demoOf = () => { const f = fileOf(); return generateDemo({ seed: f.seed, anchor: f.anchor, personas: f.personas }); };
test('demo-expected.json is exactly what the personas produce (change a persona, review this diff)', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync('./demo-expected.json', 'utf8')), expectedOf(demoOf()));
});
test('D-05 and D-06 are long follow-ups with missed visits; D-07 is a readmission three weeks later', () => {
  const d = demoOf(), e = expectedOf(d), span = (id, g) => { const t = d.rows.filter((r) => r.personaId === id && r.groupId === g && r.timeKind === 'ok').map((r) => Date.parse(r.rowTime)); return (Math.max(...t) - Math.min(...t)) / 86400000; };
  assert.ok(span('D-05', 'hba1c') >= 17 * 30, 'D-05 spans about 18 months');
  assert.ok(span('D-06', 'vitals') >= 23 * 30, 'D-06 spans about 24 months');
  assert.equal(e.personas['D-06'].rowsBySet['care.vitals/vitals'], 7, 'nine planned, two missed');
  assert.equal(e.events['D-07'].readmissionGapDays, 21); assert.equal(e.personas['D-07'].encounters, 2); assert.equal(e.personas['D-07'].openEncounters, 0);
});
test('D-08 has two records and one merge, with rows on both; D-09 carries the data-quality cases', () => {
  const d = demoOf(), e = expectedOf(d);
  assert.equal(e.personas['D-08'].patients, 2); assert.equal(d.merges.length, 1);
  assert.equal(e.events['D-08'].mergedInto, 'demo-08'); assert.ok(e.events['D-08'].rowsOnDuplicate > 0 && e.events['D-08'].rowsOnKept > 0);
  const n = e.personas['D-09']; assert.ok(n.rowsWithoutTime >= 5 && n.enteredInErrorRows >= 3 && n.amendedRows >= 2 && n.signedNotes === 1);
  assert.ok(d.rows.filter((r) => r.personaId === 'D-09' && r.status === 'entered_in_error').every((r) => r.error.reason.length >= 3));
});
test('timestamps increase within each series; the two records of D-08 share a name but not a synthetic key', () => {
  const d = demoOf(), by = {};
  for (const r of d.rows) if (r.timeKind === 'ok' && !r.amend) (by[r.id.replace(/-r\d+$/, '')] = by[r.id.replace(/-r\d+$/, '')] || []).push(r.index);
  for (const g of Object.values(by)) assert.deepEqual(g, [...g].sort((a, b) => a - b));
  const two = d.patients.filter((p) => p.personaId === 'D-08'); assert.equal(two[0].name, two[1].name); assert.notEqual(two[0].syntheticKey, two[1].syntheticKey);
  assert.equal(new Set(d.patients.map((p) => p.syntheticKey)).size, d.patients.length);
});
