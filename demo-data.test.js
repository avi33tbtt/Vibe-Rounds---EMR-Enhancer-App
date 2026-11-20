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

// ---- D5a: longitudinal checks (on the real generated data) ----
const DAY = 86400000, MONTH = 30 * DAY;
const seriesOf = (d) => { const m = {}; for (const r of d.rows) { const k = r.id.replace(/-r\d+$/, ''); (m[k] = m[k] || []).push(r); } return m; };
const timesOf = (rows) => rows.filter((r) => r.timeKind === 'ok').map((r) => Date.parse(r.rowTime));

test('D5a: within every series the rows are in index order and recorded times never go backwards or past the anchor', () => {
  const f = fileOf(), d = demoOf(), A = Date.parse(f.anchor);
  for (const [k, rows] of Object.entries(seriesOf(d))) {
    const ix = rows.map((r) => r.index);
    assert.deepEqual(ix, [...ix].sort((a, b) => a - b), k + ': rows not in index order');
    const t = timesOf(rows);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] >= t[i - 1], k + ': time goes backwards at ' + i);
    assert.ok(t.every((x) => x <= A), k + ': a time is after the anchor');
  }
});
test('D5a: every encounter ends after it starts and not after the anchor; two stays of one patient never overlap', () => {
  const f = fileOf(), d = demoOf(), A = Date.parse(f.anchor), by = {};
  for (const e of d.encounters) {
    assert.ok(Date.parse(e.startAt) <= A, e.id + ' starts after the anchor');
    if (e.endAt) assert.ok(Date.parse(e.startAt) < Date.parse(e.endAt) && Date.parse(e.endAt) <= A, e.id + ' has a bad end');
    (by[e.patient] = by[e.patient] || []).push(e);
  }
  for (const list of Object.values(by)) {
    list.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].endAt && Date.parse(list[i - 1].endAt) <= Date.parse(list[i].startAt), list[i].id + ' overlaps the stay before it');
  }
});
test('D5a: D-05 and D-06 span their stated months (18 and 24, one month of slack) and their charts have no encounter', () => {
  const d = demoOf();
  for (const [id, months] of [['D-05', 18], ['D-06', 24]]) {
    const t = timesOf(d.rows.filter((r) => r.personaId === id));
    assert.ok(t.length >= 5, id + ': too few recorded visits');
    assert.ok(Math.max(...t) - Math.min(...t) >= (months - 1) * MONTH, id + ' spans less than about ' + months + ' months');
    assert.ok(d.cases.filter((c) => c.personaId === id).every((c) => c.encounter === null), id + ': a follow-up chart is linked to an encounter');
  }
});
test('D5a: D-07 has two closed stays of one patient about three weeks apart, and the gap equals demo-expected.json', () => {
  const d = demoOf(), e = JSON.parse(fs.readFileSync('./demo-expected.json', 'utf8')), s = d.encounters.filter((x) => x.personaId === 'D-07').sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  assert.equal(s.length, 2); assert.equal(s[0].patient, s[1].patient); assert.ok(s[0].endAt && s[1].endAt);
  const gap = (Date.parse(s[1].startAt) - Date.parse(s[0].endAt)) / DAY;
  assert.ok(gap >= 14 && gap <= 28, 'gap is ' + gap + ' days');
  assert.equal(Math.round(gap), e.events['D-07'].readmissionGapDays);
});
test('D5a: demo-expected.json counts equal counts made again here from the raw generated rows', () => {
  const d = demoOf(), e = JSON.parse(fs.readFileSync('./demo-expected.json', 'utf8')), T = e.totals, P = e.personas;
  assert.equal(T.patients, d.patients.length); assert.equal(T.encounters, d.encounters.length); assert.equal(T.cases, d.cases.length); assert.equal(T.rows, d.rows.length);
  assert.equal(T.activeRows, d.rows.filter((r) => r.status === 'active').length);
  assert.equal(T.enteredInErrorRows, d.rows.filter((r) => r.status === 'entered_in_error').length);
  assert.equal(T.rowsWithoutTime, d.rows.filter((r) => r.timeKind !== 'ok').length);
  assert.equal(T.amendedRows, d.rows.filter((r) => r.amend).length);
  assert.equal(T.signedNotes, d.notes.filter((n) => n.sign).length);
  assert.equal(Object.keys(P).length, 10);
  for (const [id, p] of Object.entries(P)) {
    const rows = d.rows.filter((r) => r.personaId === id), by = {};
    for (const r of rows) by[r.setId + '/' + r.groupId] = (by[r.setId + '/' + r.groupId] || 0) + 1;
    assert.deepEqual(p.rowsBySet, by, id + ': rowsBySet');
    assert.equal(p.patients, d.patients.filter((x) => x.personaId === id).length, id + ': patients');
    assert.equal(p.encounters, d.encounters.filter((x) => x.personaId === id).length, id + ': encounters');
    assert.equal(p.openEncounters, d.encounters.filter((x) => x.personaId === id && !x.endAt).length, id + ': open encounters');
    assert.equal(p.cases, d.cases.filter((x) => x.personaId === id).length, id + ': cases');
  }
  for (const k of ['patients', 'encounters', 'cases', 'enteredInErrorRows', 'rowsWithoutTime', 'amendedRows', 'signedNotes']) assert.equal(Object.values(P).reduce((a, p) => a + p[k], 0), T[k], 'persona ' + k + ' do not add up to the total');
});

// ---- D5b1: merge and data-quality checks on the generated data (the projectCase and export half is D5b2, after F4) ----
const ISO_TEXT = /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?/g;
// Heuristic, on purpose narrow: dates and times are removed first, then a run of 7 or more digits (an MRN or phone), a "+" number, "(ddd)", ddd-ddd-dddd or an e-mail address is "real-looking".
const lookReal = (s) => { const t = String(s).replace(ISO_TEXT, ''); return /\d{7,}/.test(t) || /\+\d/.test(t) || /\(\d{3}\)/.test(t) || /\b\d{3}[ -]\d{3}[ -]?\d{4}\b/.test(t) || /\S@\S/.test(t); };
const textsOf = (d) => [
  ...d.patients.map((p) => p.name), ...d.cases.map((c) => c.narrative), ...d.merges.map((m) => m.reason), ...d.values.map((v) => v.value),
  ...d.notes.flatMap((n) => [n.text, n.amend && n.amend.text, n.amend && n.amend.reason]),
  ...d.rows.flatMap((r) => [...Object.values(r.row), r.amend && r.amend.value, r.amend && r.amend.reason, r.error && r.error.reason]),
].filter((x) => typeof x === 'string');

test('D5b1: the real-looking detector flags phones, long digit runs and e-mail, and leaves dates, times and ordinary numbers alone', () => {
  for (const bad of ['+977 9812345678', '9812345678', '555-123-4567', '(555) 123', '0123456', 'a@b.org']) assert.ok(lookReal(bad), bad + ' should be flagged');
  for (const ok of ['2026-11-01T08:00:00.000Z', '2026-11-01', '120', '7.4', '98 72 14', 'not a time', 'Demo Patient 05', '']) assert.ok(!lookReal(ok), ok + ' should pass');
});
test('D5b1: no demo name, value, note, narrative or reason looks like a real phone, id number or e-mail; every name is "Demo Patient NN"', () => {
  const d = demoOf(), hits = textsOf(d).filter(lookReal);
  assert.deepEqual(hits, [], 'real-looking text: ' + hits.slice(0, 5).join(' | '));
  for (const p of d.patients) assert.match(p.name, /^Demo Patient \d\d$/, p.id + ' name');
  assert.ok(fileOf().personas.every((p) => !/phone|nationalid/i.test(JSON.stringify(p))), 'a persona carries a phone or national id key');
});
test('D5b1: the merged pair (D-08) is one person: every row has one id, is counted once, and both records resolve to the kept one', () => {
  const d = demoOf(), e = expectedOf(d), into = {}, owner = {}, per = {};
  assert.equal(new Set(d.rows.map((r) => r.id)).size, d.rows.length, 'a row id repeats');
  for (const m of d.merges) { assert.ok(!into[m.from], m.from + ' is merged twice'); assert.notEqual(m.from, m.into); into[m.from] = m.into; }
  const keep = (id) => { for (let n = 0; into[id]; n++) { assert.ok(n < 5, 'merge loop at ' + id); id = into[id]; } return id; };
  for (const c of d.cases) owner[c.id] = c.patient;
  for (const r of d.rows) { assert.ok(owner[r.case], r.id + ': its chart is missing'); const k = keep(owner[r.case]); per[k] = (per[k] || 0) + 1; }
  assert.equal(Object.values(per).reduce((a, n) => a + n, 0), d.rows.length, 'a row was lost or counted twice');
  assert.equal(new Set(d.patients.map((p) => keep(p.id))).size, d.patients.length - d.merges.length, 'people after merge');
  const m = d.merges.find((x) => d.patients.find((p) => p.id === x.into).personaId === 'D-08'), ev = e.events['D-08'];
  assert.ok(m && ev.rowsOnDuplicate > 0 && ev.rowsOnKept > 0);
  assert.equal(per[m.into], ev.rowsOnDuplicate + ev.rowsOnKept, 'rows of both records land on the kept record');
  assert.equal(per[m.from], undefined, 'rows are still counted under the duplicate');
});
test('D5b1: rows without a usable time are flagged (none or bad), never given a date; error and amended rows say who and why', () => {
  const f = fileOf(), d = demoOf(), kinds = new Set();
  for (const r of d.rows) {
    kinds.add(r.timeKind);
    if (r.timeKind === 'ok') assert.ok(Number.isFinite(Date.parse(r.rowTime)), r.id + ': bad recorded time');
    else if (r.timeKind === 'none') assert.equal(r.rowTime, null, r.id);
    else { assert.equal(r.timeKind, 'bad', r.id); assert.equal(r.rowTime, 'not a time', r.id); assert.ok(Object.values(r.row).includes('not a time'), r.id + ': the bad time text is not in the row'); }
    if (r.status === 'entered_in_error') {
      assert.ok(r.error && r.error.by && r.error.reason.length >= 3 && r.error.reason.length <= 1000, r.id + ': error needs who and a reason of 3 to 1000 characters');
      if (f.actors) assert.ok(f.actors[r.error.by], r.id + ': error by an unknown actor');
    } else { assert.equal(r.status, 'active', r.id); assert.equal(r.error, null, r.id); }
    if (r.amend) assert.ok(r.amend.by && r.amend.field && r.amend.reason.length >= 3 && typeof r.amend.value === 'string', r.id + ': amend needs who, field, reason, value');
  }
  assert.ok(kinds.has('none') && kinds.has('bad'), 'the data should hold both a missing and an invalid time');
  const T = expectedOf(d).totals;
  assert.equal(T.activeRows + T.enteredInErrorRows, T.rows, 'every row is active or entered in error');
  assert.equal(T.rowsWithoutTime, d.rows.filter((r) => r.timeKind !== 'ok').length);
});
// ---- D5b2: projectCase checks on the generated data (F4). The export half waits for F7a and F7b and is covered by D7a. ----
const { projectCase } = require('./elements.js');
const asCaseRow = (r) => ({ id: r.id, set_id: r.setId, row: r.row, row_time: r.rowTime, status: r.status });
// Project every chart of one persona the way the export route will: one call per chart, final patient id after merges.
const projectPersona = (d, personaId) => {
  const into = {}; for (const m of d.merges) into[m.from] = m.into;
  const keep = (id) => { while (into[id]) id = into[id]; return id; };
  const out = [];
  for (const c of d.cases.filter((x) => x.personaId === personaId)) {
    const rows = d.rows.filter((r) => r.case === c.id).map(asCaseRow);
    out.push(...projectCase({ rows, sets: SETS, bindings: [], patientId: keep(c.patient), encounterId: c.encounter || null, caseId: c.id }));
  }
  return out;
};

test('D5b2: D-08 appears once in projectCase: every element row is on the kept record, none repeats, none comes from an error row', () => {
  const d = demoOf(), e = expectedOf(d).events['D-08'];
  const m = d.merges.find((x) => d.patients.find((p) => p.id === x.into).personaId === 'D-08');
  const out = projectPersona(d, 'D-08'), mine = new Set(d.rows.filter((r) => r.personaId === 'D-08').map((r) => r.id));
  assert.ok(out.length > 0, 'D-08 produced no element rows: its sets may have no fhir block');
  assert.ok(out.every((x) => x.patientId === m.into), 'an element row is not on the kept record');
  assert.ok(!out.some((x) => x.patientId === m.from), 'an element row is on the duplicate record');
  assert.equal(new Set(out.map((x) => x.rowId + '|' + x.source.fieldId)).size, out.length, 'a row field is counted twice');
  assert.ok(out.every((x) => mine.has(x.rowId)), 'an element row has no source row');
  const errIds = new Set(d.rows.filter((r) => r.status === 'entered_in_error').map((r) => r.id));
  assert.ok(!out.some((x) => errIds.has(x.rowId)), 'an entered-in-error row was projected');
  const used = new Set(out.map((x) => x.rowId)).size;
  assert.ok(used <= e.rowsOnDuplicate + e.rowsOnKept, 'more source rows than D-08 has');
});
test('D5b2: D-09 error rows are skipped; rows with no time keep no time and a bad time is never turned into a date; counts equal demo-expected.json', () => {
  const d = demoOf(), n = JSON.parse(fs.readFileSync('./demo-expected.json', 'utf8')).personas['D-09'];
  const rows = d.rows.filter((r) => r.personaId === 'D-09'), out = projectPersona(d, 'D-09'), byRow = {};
  for (const x of out) (byRow[x.rowId] = byRow[x.rowId] || []).push(x);
  const errors = rows.filter((r) => r.status === 'entered_in_error'), noTime = rows.filter((r) => r.timeKind !== 'ok');
  assert.equal(errors.length, n.enteredInErrorRows, 'error rows');
  assert.equal(noTime.length, n.rowsWithoutTime, 'rows without a usable time');
  assert.ok(errors.every((r) => !byRow[r.id]), 'an entered-in-error row was projected');
  assert.ok(out.every((x) => x.status === 'active'));
  for (const r of noTime.filter((x) => x.status === 'active' && byRow[x.id])) for (const x of byRow[r.id]) {
    if (r.timeKind === 'none') assert.equal(x.time, null, r.id + ': a missing time was given a value');
    else assert.ok(!Number.isFinite(Date.parse(x.time)), r.id + ': a bad time became a date');
  }
  assert.ok(rows.some((r) => r.timeKind === 'none' && r.status === 'active' && byRow[r.id]), 'no projected D-09 row lacks a time: the check above proved nothing');
});
test('D5b2: projecting the same generated data twice gives identical element rows (pure, writes nothing)', () => {
  const d = demoOf();
  assert.equal(JSON.stringify(projectPersona(d, 'D-09')), JSON.stringify(projectPersona(d, 'D-09')));
});
test.todo('D5b2 export half (needs F7a and F7b, covered by D7a): D-08 appears once in the export bundle and its manifest counts equal demo-expected.json');
