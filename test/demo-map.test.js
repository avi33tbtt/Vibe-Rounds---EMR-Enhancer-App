'use strict';
// Row DM3b: mapEnvelope is pure. No database here: envelopes come from the real pure builder (envelope.js) with hand-made rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { buildEnvelope } = require('../envelope');
const { mapEnvelope } = require('../scripts/demo-map');

const C = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', f), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(C('manifest.schema.json'));
const validate = ajv.compile(C('context-envelope.schema.json'));

const FIELDS = [['bite_time', 'datetime'], ['bite_time_certainty', 'select'], ['arrival_time', 'datetime'], ['clotting_test_status', 'select'], ['clotting_test_start_time', 'datetime'],
  ['clotting_result_read_time', 'datetime'], ['clotting_result', 'select'], ['antivenom_status', 'select'], ['antivenom_start_time', 'datetime']];
const SET = { id: 1, slug: 'snake-envenomation-timing', version: 1, state: 'active', definition_json: { fields: FIELDS.map(([id, type]) => ({ id, type })) } };
const PW = { id: 1, slug: 'snake-envenomation-documentation', version: 1 };
let n = 0;
const row = (field_key, value_type, value_json, extra = {}) => ({ id: ++n, applied_set_id: 1, field_key, value_type, value_json, unit_display: null,
  effective_at: new Date(Date.UTC(2026, 10, 23, 8, n)), recorded_at: new Date(Date.UTC(2026, 10, 23, 9, n)), source_type: 'clinician', status: 'final', corrects_id: null, recorded_role: 'doctor', ...extra });
const build = rows => buildEnvelope({ caseRow: { id: 7 }, pins: { sets: [SET], pathways: [PW] }, observations: rows, exportedAt: new Date(Date.UTC(2026, 10, 23, 10)),
  producerVersion: '0.1.0', refSecret: 'x'.repeat(32) });
const t = '2026-11-23T08:00:00Z';
const byField = (env, f) => env.observations.find(o => o.concept.id.endsWith('.' + f));

test('names: element, pathway and the 9 concept ids use the CCIS spelling; versions become 0.1.0', () => {
  const env = build(FIELDS.map(([f, ty]) => ty === 'datetime' ? row(f, 'datetime', t) : row(f, 'select', f === 'clotting_result' ? 'Clotted' : f === 'bite_time_certainty' ? 'Exact' : f === 'clotting_test_status' ? 'Performed' : 'Given')));
  const m = mapEnvelope(env);
  assert.deepEqual(m.applied.elements, [{ id: 'snake.envenomation-timing', type: 'contextual-element', version: '0.1.0' }]);
  assert.deepEqual(m.applied.pathways, [{ id: 'snake.documentation-path', type: 'pathway', version: '0.1.0' }]);
  assert.equal(m.observations.length, 9);
  for (const o of m.observations) assert.match(o.concept.id, /^snake\.envenomation-timing\.[a-z-]+$/);
  assert.equal(validate(m), true, JSON.stringify(validate.errors));
});

test('select words become CCIS codes; Clotted and Unclotted share the demo result; negatives and unknown become states', () => {
  const m = mapEnvelope(build([
    row('bite_time_certainty', 'select', 'Estimated'), row('clotting_test_status', 'select', 'Not performed'),
    row('clotting_result', 'select', 'Unclotted'), row('antivenom_status', 'select', 'Not given'), row('clotting_result', 'unknown', null),
  ]));
  const bc = byField(m, 'bite-time-certainty');
  assert.equal(bc.kind, 'code');
  assert.deepEqual(bc.value, { system: 'ccis-demo', code: 'estimated' });
  assert.deepEqual(bc.concept.codes, [{ system: 'ccis-demo', systemVersion: '0.1.0', code: 'bite-time-certainty', verification: 'unverified' }]);
  const neg = byField(m, 'clotting-test-status');
  assert.equal(neg.state, 'explicitly-negative'); assert.equal('value' in neg, false);
  assert.equal(byField(m, 'antivenom-status').state, 'explicitly-negative');
  const res = m.observations.filter(o => o.concept.id.endsWith('.clotting-result'));
  assert.deepEqual(res[0].value, { system: 'ccis-demo', code: 'demo-result-a' });
  assert.equal(res[0].concept.codes[0].code, 'clotting-test-result');
  assert.equal(res[1].state, 'unknown'); assert.equal(res[1].kind, 'code'); assert.equal('value' in res[1], false);
  assert.equal(validate(m), true, JSON.stringify(validate.errors));
});

test('the input is never changed and the output is a separate copy', () => {
  const env = build([row('bite_time', 'datetime', t), row('antivenom_status', 'select', 'Given')]);
  const before = JSON.stringify(env);
  const m = mapEnvelope(env);
  assert.equal(JSON.stringify(env), before);
  m.observations[0].concept.id = 'changed';
  assert.equal(JSON.stringify(env), before);
});

test('anything unknown throws: select word, field, set, pathway', () => {
  assert.throws(() => mapEnvelope(build([row('antivenom_status', 'select', 'Maybe')])), /Cannot map value for "antivenom-status"/);
  assert.throws(() => mapEnvelope(build([row('antivenom_status', 'select', 'given')])), /Cannot map value/);          // case matters: no guessing
  const other = build([row('bite_time', 'datetime', t)]); other.observations[0].concept.id = 'snake-envenomation-timing.new-field';
  assert.throws(() => mapEnvelope(other), /Cannot map field "new-field"/);
  const set = build([row('bite_time', 'datetime', t)]); set.applied.elements[0].id = 'other-set';
  assert.throws(() => mapEnvelope(set), /Cannot map element "other-set"/);
  const pw = build([row('bite_time', 'datetime', t)]); pw.applied.pathways[0].id = 'other-path';
  assert.throws(() => mapEnvelope(pw), /Cannot map pathway "other-path"/);
  const v2 = build([row('bite_time', 'datetime', t)]); v2.applied.elements[0].version = '2.0.0';
  assert.throws(() => mapEnvelope(v2), /Cannot map version "2.0.0"/);
  const pv = build([row('bite_time', 'datetime', t)]); pv.applied.pathways[0].version = '3.0.0';
  assert.throws(() => mapEnvelope(pv), /Cannot map version "3.0.0"/);
  const foreign = build([row('bite_time', 'datetime', t)]); foreign.observations[0].concept.id = 'glucose.value';
  assert.throws(() => mapEnvelope(foreign), /Cannot map concept/);
});
