'use strict';
// Task R6e: Questionnaire -> element set draft (questionnaire-import.js). Pure: no database, no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { questionnaireToDefinition: imp, ImportError, LIMITS } = require('../questionnaire-import');
const { validateDefinition, KINDS } = require('../sets');

const Q = () => ({ resourceType: 'Questionnaire', name: 'Pain Review', title: 'Pain review', description: 'A short pain review', url: 'http://example.org/q/pain', version: '3', publisher: 'Example Clinic',
  item: [
    { linkId: 'p1', text: 'Pain score', type: 'integer', required: true, code: [{ system: 'http://loinc.org', code: '72514-3', display: 'Pain severity' }] },
    { linkId: 'g1', text: 'Details', type: 'group', item: [
      { linkId: 'g1.a', text: 'Weight', type: 'decimal', extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/questionnaire-unit', valueCoding: { code: 'kg' } }] },
      { linkId: 'g1.b', text: 'Type', type: 'choice', answerOption: [{ valueCoding: { system: 'http://snomed.info/sct', code: '1', display: 'Sharp' } }, { valueString: 'Dull' }] },
      { linkId: 'g1.c', text: 'Worse at night', type: 'boolean', enableWhen: [{ question: 'p1', operator: '>', answerInteger: 3 }] },
      { linkId: 'g1.d', text: 'Notes', type: 'text', repeats: true } ] },
    { linkId: 'd1', text: 'Read this first', type: 'display' },
    { linkId: 'x1', text: 'A file', type: 'attachment' } ] });

test('the result is an accepted draft body: valid definition, kind custom, slug from the name, nothing else', () => {
  const r = imp(Q());
  assert.equal(r.slug, 'pain_review'); assert.equal(r.kind, 'custom'); assert.ok(KINDS.includes(r.kind));
  assert.deepEqual(validateDefinition(r.definition, r.slug, r.kind), []);
  assert.deepEqual(Object.keys(r).sort(), ['counts', 'definition', 'dropped', 'kind', 'slug', 'warnings']);
  assert.equal(r.definition.title, 'Pain review'); assert.equal(r.definition.desc, 'A short pain review');
  assert.deepEqual(r.definition.sdc, { url: 'http://example.org/q/pain', version: '3', publisher: 'Example Clinic', modified: false });
});

test('fields: types, required, unit, group path and options come across; display items and unknown types are skipped with a warning', () => {
  const { definition: d, warnings } = imp(Q());
  assert.deepEqual(d.fields.map(f => f.type), ['integer', 'number', 'select', 'boolean', 'text']);
  assert.equal(d.fields[0].required, true); assert.equal(d.fields[1].unit, 'kg'); assert.deepEqual(d.fields[2].options, ['Sharp', 'Dull']);
  assert.deepEqual(d.fields[1].path, [{ linkId: 'g1', text: 'Details' }]); assert.equal(d.fields[1].label, 'Details › Weight');
  assert.ok(warnings.some(w => /x1.*attachment.*skipped/.test(w))); assert.ok(warnings.some(w => /g1\.c.*conditional/.test(w))); assert.ok(warnings.some(w => /g1\.d.*multi-answer/.test(w)));
});

test('NO codes come across: no bindings, no codings anywhere in the draft; they are counted and reported', () => {
  const r = imp(Q());
  assert.equal(r.definition.fields.some(f => f.bindings || f.optCodings || f.otherCodes || f.coding), false);
  const s = JSON.stringify(r.definition); assert.ok(!/72514-3|loinc\.org|snomed\.info/.test(s));
  assert.equal(r.counts.codesDropped, 1); assert.equal(r.counts.optionCodesDropped, 1);
  assert.ok(r.dropped.some(d => /1 item code\(s\) not imported/.test(d))); assert.ok(r.dropped.some(d => /answer-option code/.test(d)));
});

test('the original Questionnaire and its extensions are not kept; no numbers, nulls or unlisted keys are written', () => {
  const r = imp(Q()); const s = JSON.stringify(r.definition);
  assert.ok(!/resourceType|questionnaire-unit|enableWhen|"original"/.test(s));
  assert.equal(r.definition.sdc.original, undefined);
  const scan = v => { if (v === null || typeof v === 'number') assert.fail('number or null in the definition'); if (v && typeof v === 'object') Object.values(v).forEach(scan); };
  scan(r.definition);
});

test('the same Questionnaire always gives the same draft; the input is not changed; no clock is read', () => {
  const q = Q(), before = JSON.stringify(q);
  assert.deepEqual(imp(q), imp(JSON.parse(before))); assert.equal(JSON.stringify(q), before);
});

test('too much is refused, never cut: long title, item text, option, too many options, too many fields, too deep', () => {
  const t = (mut) => { const q = Q(); mut(q); return () => imp(q); };
  assert.throws(t(q => { q.title = 'x'.repeat(LIMITS.title + 1); }), ImportError);
  assert.throws(t(q => { q.item[0].text = 'x'.repeat(LIMITS.fieldText + 1); }), /not cut/);
  assert.throws(t(q => { q.item[1].item[1].answerOption.push({ valueString: 'y'.repeat(LIMITS.option + 1) }); }), ImportError);
  assert.throws(t(q => { q.item[1].item[1].answerOption = Array.from({ length: LIMITS.options + 1 }, (_, i) => ({ valueString: 'o' + i })); }), /options/);
  assert.throws(t(q => { q.item = Array.from({ length: LIMITS.fields + 1 }, (_, i) => ({ linkId: 'i' + i, text: 't', type: 'string' })); }), /fields/);
  let deep = { linkId: 'leaf', text: 'x', type: 'string' }; for (let i = 0; i < 12; i++) deep = { linkId: 'g' + i, type: 'group', item: [deep] };
  assert.throws(() => imp({ resourceType: 'Questionnaire', title: 't', item: [deep] }), /nested/);
});

test('a long description or url is not kept but reported; characters that cannot be stored are removed and counted', () => {
  const q = Q(); q.description = 'd'.repeat(LIMITS.desc + 1); q.item[0].text = 'Pain\u0000 score';
  const r = imp(q);
  assert.equal(r.definition.desc, undefined); assert.ok(r.dropped.some(d => /description is longer/.test(d)));
  assert.equal(r.definition.fields[0].text, 'Pain score'); assert.equal(r.counts.charactersRemoved >= 1, true); assert.deepEqual(validateDefinition(r.definition, r.slug, r.kind), []);
});

test('bad input is refused: not a Questionnaire, no usable items, bad slug; a good slug override is kept', () => {
  assert.throws(() => imp(null), ImportError); assert.throws(() => imp({ resourceType: 'Patient' }), ImportError);
  assert.throws(() => imp({ resourceType: 'Questionnaire', title: 't', item: [{ linkId: 'd', type: 'display', text: 'x' }] }), /no items/);
  assert.throws(() => imp(Q(), { slug: 'Bad Slug' }), /set id/);
  assert.equal(imp(Q(), { slug: 'my_pain' }).slug, 'my_pain');
  assert.equal(imp({ resourceType: 'Questionnaire', item: [{ linkId: 'a', text: 'A', type: 'string' }] }).slug, 'imported_questionnaire');
});

test('hostile text is carried as plain text only (the page escapes it); it never becomes a key, code or number', () => {
  const q = Q(); q.item[0].text = '<img src=x onerror=alert(1)>'; q.item[1].item[1].answerOption[1].valueString = '"; DROP TABLE x;--';
  const r = imp(q); assert.equal(r.definition.fields[0].text, '<img src=x onerror=alert(1)>');
  assert.deepEqual(Object.keys(r.definition.fields[0]).sort(), ['id', 'label', 'linkId', 'required', 'sdcType', 'text', 'type']);
});

test('the module is pure: no database, file, network, clock or random', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'questionnaire-import.js'), 'utf8');
  assert.ok(!/Date\.now|new Date\(|Math\.random|process\.|fetch\(|randomUUID|require\('(fs|http|https|net|child_process|pg)'\)/.test(src));
});
