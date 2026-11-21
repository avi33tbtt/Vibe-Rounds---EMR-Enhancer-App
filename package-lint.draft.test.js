'use strict';
/* 43a2: validateDraft, with made-up sets and ids only. */
const test = require('node:test');
const assert = require('node:assert');
const { validateDraft } = require('./package-lint.js');

const ctx = { requestText: 'Flag when the widget level is above 7.5', knownSetIds: ['x.alpha', 'x.beta'], fieldRefs: ['x.alpha/lvl', 'x.beta/other'], ownerSetId: 'x.alpha' };
const codes = (r) => r.errors.map((e) => e.code);
const goodSet = { diagnosis: { text: 'Made-up form' }, sections: [{ title: 'A', fields: [{ id: 'a', label: 'A', type: 'number', unit: 'mg' }] }] };
const goodRule = { fieldRef: 'x.alpha/lvl', op: '>', threshold: 7.5, indicator: 'amber', summary: 'Above the stated level' };

test('a clean set, pathway and rule pass', () => {
  assert.strictEqual(validateDraft(goodSet, 'set', ctx).ok, true);
  assert.strictEqual(validateDraft({ title: 'P', setIds: ['x.alpha', 'x.beta'] }, 'pathway', ctx).ok, true);
  assert.strictEqual(validateDraft(goodRule, 'rule', ctx).ok, true);
});
test('bad output kind and non-object draft', () => {
  assert.deepStrictEqual(codes(validateDraft(goodSet, 'order', ctx)), ['bad_output']);
  assert.deepStrictEqual(codes(validateDraft(null, 'set', ctx)), ['bad_draft']);
});
test('set: unknown field type, no sections', () => {
  assert.ok(codes(validateDraft({ sections: [{ fields: [{ type: 'magic' }] }] }, 'set', ctx)).includes('unknown_field_type'));
  assert.ok(codes(validateDraft({ sections: [] }, 'set', ctx)).includes('no_sections'));
});
test('pathway: unknown set id and empty list', () => {
  assert.ok(codes(validateDraft({ setIds: ['x.alpha', 'nope'] }, 'pathway', ctx)).includes('unknown_set_id'));
  assert.ok(codes(validateDraft({ setIds: [] }, 'pathway', ctx)).includes('no_members'));
});
test('rule: unknown field, field outside owner, bad operator', () => {
  assert.ok(codes(validateDraft({ ...goodRule, fieldRef: 'x.alpha/zzz' }, 'rule', ctx)).includes('unknown_field_ref'));
  assert.ok(codes(validateDraft({ ...goodRule, fieldRef: 'x.beta/other' }, 'rule', ctx)).includes('field_not_in_owner'));
  assert.ok(codes(validateDraft({ ...goodRule, op: 'contains' }, 'rule', ctx)).includes('bad_rule_op'));
});
test('rule: threshold must be a number that appears in the sentence', () => {
  assert.ok(codes(validateDraft({ ...goodRule, threshold: 9 }, 'rule', ctx)).includes('threshold_not_in_request'));
  assert.ok(codes(validateDraft({ ...goodRule, threshold: '7.5' }, 'rule', ctx)).includes('bad_rule_threshold'));
  assert.ok(codes(validateDraft({ ...goodRule, threshold: NaN }, 'rule', ctx)).includes('bad_rule_threshold'));
  assert.strictEqual(validateDraft({ ...goodRule, threshold: -7.5 }, 'rule', ctx).ok, true);
  assert.ok(codes(validateDraft(goodRule, 'rule', { ...ctx, requestText: 'above seven and a half' })).includes('threshold_not_in_request'));
});
test('dose-like text is refused anywhere in the draft', () => {
  const d = { ...goodRule, summary: 'Give 5 mg' };
  assert.ok(codes(validateDraft(d, 'rule', ctx)).includes('dose_like'));
  assert.ok(codes(validateDraft({ sections: [{ fields: [{ type: 'text', label: 'Take 10 units' }] }] }, 'set', ctx)).includes('dose_like'));
});
test('codes must be empty: coding, code, fhir.code, system', () => {
  const f = (x) => ({ sections: [{ fields: [Object.assign({ type: 'number', label: 'A' }, x)] }] });
  assert.ok(codes(validateDraft(f({ coding: { system: 'S', code: '1' } }), 'set', ctx)).includes('code_not_empty'));
  assert.ok(codes(validateDraft(f({ code: '123' }), 'set', ctx)).includes('code_not_empty'));
  assert.ok(codes(validateDraft(f({ fhir: { code: { system: 'S', code: '1' } } }), 'set', ctx)).includes('code_not_empty'));
  assert.strictEqual(validateDraft(f({ coding: {}, code: '' }), 'set', ctx).ok, true);
});
test('never throws on odd input', () => {
  assert.doesNotThrow(() => validateDraft({ sections: 'x' }, 'set', undefined));
  assert.doesNotThrow(() => validateDraft({}, 'rule', { knownSetIds: 5, fieldRefs: null }));
});
