'use strict';
// Row R9b: the pure timeline projection (timeline-projection.js). No database needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectTimeline, groupByDay, sameFieldNeighbours, ProjectionError, KINDS } = require('../timeline-projection');

const obs = (o = {}) => ({ kind: 'observation', sourceId: 1, caseId: 3, at: '2026-01-05T08:00:00Z', effectiveAt: '2026-01-05T08:00:00Z', recordedAt: '2026-01-06T09:00:00Z',
  status: 'final', by: 'doc', fieldKey: 'hba1c', valueType: 'number', value: 7.2, unit: '%', appliedSetId: 9, setSlug: 'hba1c_mon', correctsId: null, ...o });
const prob = (o = {}) => ({ kind: 'problem', sourceId: 1, caseId: null, at: '2026-01-05T08:00:00Z', effectiveAt: '2024-03-01', recordedAt: '2026-01-05T08:00:00Z', status: 'active', by: 'doc', label: 'Asthma', ...o });

test('effective time and recorded time stay separate; the input is not changed; each row keeps its source id, case and kind', () => {
  const input = [obs()]; const before = JSON.stringify(input);
  const { events } = projectTimeline(input);
  assert.equal(JSON.stringify(input), before, 'input untouched');
  const e = events[0];
  assert.equal(e.effectiveAt, '2026-01-05T08:00:00Z'); assert.equal(e.recordedAt, '2026-01-06T09:00:00Z');
  assert.equal(e.key, 'observation:1'); assert.equal(e.caseId, 3); assert.equal(e.kindLabel, 'Value'); assert.equal(e.day, '2026-01-05');
  const p = projectTimeline([prob()]).events[0];
  assert.equal(p.effectiveAt, '2024-03-01'); assert.equal(p.recordedAt, '2026-01-05T08:00:00Z'); assert.equal(p.caseId, null, 'no case stays null');
});

test('ordering: by time, then kind, then numeric source id; the same input in any order gives the same result', () => {
  const list = [obs({ sourceId: 10 }), obs({ sourceId: 2 }), prob({ sourceId: 5 }), obs({ sourceId: 7, at: '2025-12-31T23:00:00Z', effectiveAt: '2025-12-31T23:00:00Z' })];
  const a = projectTimeline(list).events.map(e => e.key);
  const b = projectTimeline([...list].reverse()).events.map(e => e.key);
  assert.deepEqual(a, ['observation:7', 'observation:2', 'observation:10', 'problem:5']);
  assert.deepEqual(a, b);
});

test('missing times stay null and are flagged; undated events go last and are grouped as undated; no time is invented', () => {
  const { events } = projectTimeline([obs({ sourceId: 1, at: null, effectiveAt: null }), obs({ sourceId: 2 }), prob({ sourceId: 3, effectiveAt: null, recordedAt: null })]);
  const undated = events.find(e => e.key === 'observation:1');
  assert.equal(undated.at, null); assert.equal(undated.timeMissing.at, true); assert.equal(undated.timeMissing.effective, true); assert.equal(undated.day, null);
  assert.equal(events[events.length - 1].key, 'observation:1');
  const noEff = events.find(e => e.key === 'problem:3');
  assert.equal(noEff.effectiveAt, null); assert.equal(noEff.timeMissing.recorded, true);
  const g = groupByDay(events);
  assert.equal(g[g.length - 1].day, 'undated'); assert.equal(g[g.length - 1].year, null);
  assert.deepEqual(g.map(x => x.day), ['2026-01-05', 'undated']);
});

test('statuses stay distinct: entered in error is its own flag; empty value is "no value", never 0; 0 is a real value', () => {
  const { events } = projectTimeline([obs({ sourceId: 1, status: 'entered_in_error' }), obs({ sourceId: 2, value: null }), obs({ sourceId: 3, value: 0 }), obs({ sourceId: 4, value: '' }), obs({ sourceId: 5, status: 'amended' })]);
  const by = k => events.find(e => e.key === 'observation:' + k);
  assert.equal(by(1).inError, true); assert.equal(by(5).inError, false); assert.equal(by(5).status, 'amended');
  assert.equal(by(2).hasValue, false); assert.equal(by(2).value, null);
  assert.equal(by(4).hasValue, false);
  assert.equal(by(3).hasValue, true); assert.equal(by(3).value, 0);
});

test('source identity: a repeated source row is kept once and counted; two different rows of one kind are never merged; same id in two kinds stays two rows', () => {
  const r = projectTimeline([obs({ sourceId: 1 }), obs({ sourceId: 1 }), obs({ sourceId: 2 }), prob({ sourceId: 1 })]);
  assert.equal(r.duplicates, 1); assert.deepEqual(r.events.map(e => e.key).sort(), ['observation:1', 'observation:2', 'problem:1']);
  const corr = projectTimeline([obs({ sourceId: 1 }), obs({ sourceId: 2, correctsId: 1 })]).events;
  assert.equal(corr.length, 2); assert.equal(corr.find(e => e.sourceId === 2).correctsId, 1);
});

test('bad input is refused, not guessed: unknown kind, missing source id, bad time, non-list, non-object', () => {
  assert.throws(() => projectTimeline([{ ...obs(), kind: 'order' }]), ProjectionError);
  assert.throws(() => projectTimeline([{ ...obs(), sourceId: undefined }]), ProjectionError);
  assert.throws(() => projectTimeline([obs({ at: 'yesterday' })]), ProjectionError);
  assert.throws(() => projectTimeline([obs({ recordedAt: '2026-13-45' })]), ProjectionError);
  assert.throws(() => projectTimeline('x'), ProjectionError);
  assert.throws(() => projectTimeline([null]), ProjectionError);
  assert.ok(KINDS.includes('observation') && !KINDS.includes('order') && !KINDS.includes('result'), 'no kinds without a source');
});

test('previous and next of the same field: same set and field only; entered-in-error rows are skipped; other fields and sets are ignored', () => {
  const day = d => ({ at: `2026-0${d}-01T00:00:00Z`, effectiveAt: `2026-0${d}-01T00:00:00Z` });
  const { events } = projectTimeline([obs({ sourceId: 1, ...day(1) }), obs({ sourceId: 2, ...day(2), status: 'entered_in_error' }), obs({ sourceId: 3, ...day(3) }),
    obs({ sourceId: 4, ...day(4), fieldKey: 'other' }), obs({ sourceId: 5, ...day(5), setSlug: 'glucose_ss', appliedSetId: 11 }), obs({ sourceId: 6, ...day(6) })]);
  assert.deepEqual(sameFieldNeighbours(events, 'observation:3'), { previous: 'observation:1', next: 'observation:6' });
  assert.deepEqual(sameFieldNeighbours(events, 'observation:1'), { previous: null, next: 'observation:3' });
  assert.deepEqual(sameFieldNeighbours(events, 'observation:2'), { previous: 'observation:1', next: 'observation:3' });   // the row in error still gets neighbours by time
  assert.deepEqual(sameFieldNeighbours(events, 'problem:99'), { previous: null, next: null });
});

test('the module is pure: no database, file, network, clock or random', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'timeline-projection.js'), 'utf8');
  assert.ok(!/require\(|Date\.now|new Date\(\)|Math\.random|process\.|fetch\(/.test(src));
});
