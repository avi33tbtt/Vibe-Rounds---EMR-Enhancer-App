'use strict';
// 43a2: pure tests, made-up data only. No database, no provider.
const test = require('node:test');
const assert = require('node:assert');
const { validatePathwayDraft, validateFeatureSet, ruleFieldsOf, validateRuleDraft, AiReject } = require('./llm.js');

const ids = new Set(['a.one', 'a.two', 'a.three']);
test('pathway: unknown and repeated ids are dropped, order kept', () => {
  const r = validatePathwayDraft({ title: 'My path', setIds: ['a.two', 'zzz', 'a.two', 'a.one'] }, ids);
  assert.deepStrictEqual(r, { title: 'My path', setIds: ['a.two', 'a.one'] });
});
test('pathway: no known id, no title or a dose-like title is rejected', () => {
  assert.throws(() => validatePathwayDraft({ title: 'x', setIds: ['zzz'] }, ids), AiReject);
  assert.throws(() => validatePathwayDraft({ title: '', setIds: ['a.one'] }, ids), AiReject);
  assert.throws(() => validatePathwayDraft({ title: 'Give 5 mg', setIds: ['a.one'] }, ids), AiReject);
  assert.throws(() => validatePathwayDraft('nope', ids), AiReject);
});
const raw = { diagnosis: { text: 'model text', snomed: { code: '123456', display: 'x' } },
  sections: [{ title: 'S', fields: [{ id: 'f_one', label: 'One', type: 'number', unit: 'u', coding: { system: 'loinc', code: '1234-5', display: 'd' } },
    { id: 'f_two', label: 'Two 5 mg', type: 'text' }] }] };
test('set: every code is removed, the title is the sentence, dose-like fields are dropped', () => {
  const r = validateFeatureSet(JSON.parse(JSON.stringify(raw)), 'A made up request sentence');
  assert.strictEqual(r.schema.diagnosis.text, 'A made up request sentence');
  assert.deepStrictEqual(r.schema.diagnosis.snomed, { code: '', display: '' });
  assert.ok(r.schema.sections[0].fields.every((f) => f.coding === undefined));
  assert.strictEqual(r.schema.sections[0].fields.length, 1);
  assert.ok(r.warnings.some((w) => /left empty on purpose/.test(w)));
  assert.ok(!r.warnings.some((w) => /^Codes are format-checked/.test(w)));
});
test('set: no usable fields is rejected', () => {
  assert.throws(() => validateFeatureSet({ sections: [] }, 'sentence here ok'), AiReject);
});
test('rule fields come from numeric and time fields only, as setId/fieldId', () => {
  const f = ruleFieldsOf('x.set', { sections: [{ fields: [{ id: 'n', label: 'N', type: 'number', unit: 'u' }, { id: 't', type: 'text' }, { id: 'd', label: 'D', type: 'datetime', repeat: true }, { id: 'bad id', type: 'number' }] }] });
  assert.deepStrictEqual(f.map((x) => x.ref), ['x.set/n', 'x.set/d']);
  assert.strictEqual(f[1].repeat, true);
  assert.deepStrictEqual(ruleFieldsOf('x', null), []);
});
test('rule: a threshold the sentence does not contain is rejected', () => {
  const fields = [{ ref: 'x.set/n', label: 'N', unit: 'u', type: 'number' }];
  const j = { fieldRef: 'x.set/n', op: '>', threshold: 9, indicator: 'info', summary: 'Review n' };
  assert.throws(() => validateRuleDraft(j, fields, 'alert when N is above 7'), AiReject);
  assert.strictEqual(validateRuleDraft(j, fields, 'alert when N is above 9').threshold, 9);
});
