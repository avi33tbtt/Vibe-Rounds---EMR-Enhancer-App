'use strict';
// node --test elements.test.js
// F2: roleOf, elementKey, providesOf. Uses a made-up set (different field ids and units than any seed set).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { roleOf, elementKey, providesOf } = require('./elements.js');

const made = () => ({ setId: 'test.pond', version: 3, sections: [
  { title: 'A', fields: [
    { id: 'p_when', type: 'datetime', repeat: true, group: 'pd' },
    { id: 'p_day', type: 'date' },
    { id: 'p_depth', type: 'number', unit: 'cm', repeat: true, group: 'pd', fhir: { resource: 'Observation', valueType: 'valueQuantity' } },
    { id: 'p_fish', type: 'integer', unit: 'ml', group: 'pd', fhir: { resource: 'Observation', valueType: 'valueQuantity' } },
    { id: 'p_kind', type: 'select', options: ['x', 'y'], group: 'pd' },
    { id: 'p_memo', type: 'text', group: 'pd', fhir: { resource: 'Observation', valueType: 'valueString' } }] },
  { title: 'B', fields: [
    { id: 'p_flag', type: 'boolean' },
    { id: 'p_gap', type: 'duration_min' },
    { id: 'p_thr', type: 'number', unit: 'cm', meta: true },
    { id: 'p_temp', type: 'number', unitField: 'p_tunit', group: 'pd', fhir: { resource: 'Observation', valueType: 'valueQuantity' } }] }] });
const byId = (p, id) => p.find((x) => x.fieldId === id);

test('roleOf: one case per role a field type can give, and none for the rest', () => {
  assert.equal(roleOf({ type: 'datetime' }), 'time');
  assert.equal(roleOf({ type: 'date' }), 'time');
  assert.equal(roleOf({ type: 'number' }), 'quantity');
  assert.equal(roleOf({ type: 'integer' }), 'quantity');
  assert.equal(roleOf({ type: 'select' }), 'category');
  assert.equal(roleOf({ type: 'text' }), 'text');
  for (const t of ['boolean', 'duration_min', 'weird', undefined]) assert.equal(roleOf({ type: t }), null, String(t));
  assert.equal(roleOf(null), null);
  // status, actor and link are never derived from a plain field type
  for (const t of ['status', 'actor', 'link']) assert.equal(roleOf({ type: t }), null);
});

test('providesOf lists every field with a role, with group, resource and unit as typed', () => {
  const p = providesOf(made(), []);
  assert.deepEqual(p.map((x) => x.fieldId), ['p_when', 'p_day', 'p_depth', 'p_fish', 'p_kind', 'p_memo', 'p_temp']);
  assert.equal(byId(p, 'p_depth').role, 'quantity'); assert.equal(byId(p, 'p_depth').unit, 'cm');
  assert.equal(byId(p, 'p_depth').resource, 'Observation'); assert.equal(byId(p, 'p_depth').group, 'pd');
  assert.equal(byId(p, 'p_fish').unit, 'ml', 'unit kept exactly as typed, never converted');
  assert.equal(byId(p, 'p_day').group, null);
  assert.equal(byId(p, 'p_memo').role, 'text');
});

test('boolean, derived, meta fields are not elements', () => {
  const ids = providesOf(made(), []).map((x) => x.fieldId);
  for (const id of ['p_flag', 'p_gap', 'p_thr']) assert.ok(!ids.includes(id), id);
});

test('a field with no fhir block still gets a role, with resource null', () => {
  const p = providesOf(made(), []);
  assert.equal(byId(p, 'p_when').role, 'time'); assert.equal(byId(p, 'p_when').resource, null);
  assert.equal(byId(p, 'p_kind').resource, null);
  assert.equal(byId(p, 'p_kind').key, '- | category | - | -');
});

test('no bindings: no code anywhere, key ends with a dash', () => {
  const e = byId(providesOf(made(), []), 'p_depth');
  assert.equal(e.system, null); assert.equal(e.code, null);
  assert.equal(e.key, 'Observation.value | quantity | cm | -');
});

test('a binding for this set and field adds a code; other sets, other fields and empty codes do not', () => {
  const b = [
    { set_id: 'test.pond', field_id: 'p_depth', system: 'sysA', code: '123', display: 'x' },
    { set_id: 'other.set', field_id: 'p_fish', system: 'sysA', code: '999', display: 'x' },
    { set_id: 'test.pond', field_id: 'p_memo', system: 'sysA', code: '', display: 'x' },
    { set_id: 'test.pond', field_id: 'p_fish', system: '  ', code: '5', display: 'x' }];
  const p = providesOf(made(), b);
  assert.equal(byId(p, 'p_depth').system, 'sysA'); assert.equal(byId(p, 'p_depth').code, '123');
  assert.equal(byId(p, 'p_depth').key, 'Observation.value | quantity | cm | sysA:123');
  for (const id of ['p_fish', 'p_memo', 'p_kind']) { assert.equal(byId(p, id).code, null, id); assert.ok(byId(p, id).key.endsWith('| -'), id); }
});

test('several codings on one field are all in the key', () => {
  const b = [{ set_id: 'test.pond', field_id: 'p_depth', system: 'A', code: '1' }, { set_id: 'test.pond', field_id: 'p_depth', system: 'local', code: 'z' }];
  const e = byId(providesOf(made(), b), 'p_depth');
  assert.equal(e.key, 'Observation.value | quantity | cm | A:1,local:z');
  assert.equal(e.system, 'A');
});

test('a unit chosen per row is flagged, not guessed', () => {
  const e = byId(providesOf(made(), []), 'p_temp');
  assert.equal(e.unitField, 'p_tunit'); assert.equal(e.unit, '-');
  assert.equal(byId(providesOf(made(), []), 'p_depth').unitField, undefined);
});

test('elementKey takes a single binding, a list, or nothing; returns null with no role', () => {
  const f = { id: 'z', type: 'number', unit: 'mL', fhir: { resource: 'Observation', valueType: 'valueQuantity' } };
  assert.equal(elementKey({}, f), 'Observation.value | quantity | mL | -');
  assert.equal(elementKey({}, f, { system: 'S', code: 'C' }), 'Observation.value | quantity | mL | S:C');
  assert.equal(elementKey({}, f, [{ system: 'S', code: 'C' }, { system: 'T', code: 'D' }]), 'Observation.value | quantity | mL | S:C,T:D');
  assert.equal(elementKey({}, { id: 'q', type: 'boolean' }), null);
});

test('bad input gives an empty list, never an error', () => {
  assert.deepEqual(providesOf(null, null), []);
  assert.deepEqual(providesOf({ setId: 'x' }, undefined), []);
  assert.deepEqual(providesOf({ setId: 'x', sections: [{ fields: [null, {}] }] }, []), []);
});

test('elements.js names no seed set id or field id (rule E9)', () => {
  const sandbox = { window: {} };
  require('node:vm').runInNewContext(fs.readFileSync('./element-sets.js', 'utf8'), sandbox);
  const src = fs.readFileSync('./elements.js', 'utf8');
  const names = new Set();
  for (const s of sandbox.window.SEED_SETS) { names.add(s.setId); for (const sec of s.sections || []) for (const f of sec.fields) if (f.id.length >= 4) names.add(f.id); }
  // 'slot' is also a seed field id, but here it is the key of a requirement ({slot, role, ...}, plan 7.1), not a field.
  const SHAPE_WORDS = new Set(['slot']);
  for (const n of names) if (!SHAPE_WORDS.has(n)) assert.ok(!new RegExp('["\'.]' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']?\\b').test(src), 'elements.js mentions ' + n);
});

test('it runs over the real seed sets without error and every key has four parts', () => {
  const sandbox = { window: {} };
  require('node:vm').runInNewContext(fs.readFileSync('./element-sets.js', 'utf8'), sandbox);
  let n = 0;
  for (const s of sandbox.window.SEED_SETS) for (const e of providesOf(s, [])) { n++; assert.equal(e.key.split(' | ').length, 4, e.key); }
  assert.ok(n > 40);
});

// ---- F3a: compatibility(), slot matching ----
const { compatibility } = require('./elements.js');
const lake = () => ({ setId: 'test.lake', sections: [{ title: 'L', fields: [
  { id: 'l_when', type: 'datetime', repeat: true, group: 'lk' },
  { id: 'l_vol', type: 'number', unit: 'L', repeat: true, group: 'lk', fhir: { resource: 'Observation', valueType: 'valueQuantity' } },
  { id: 'l_ph', type: 'number', repeat: true, group: 'lk', fhir: { resource: 'Observation', valueType: 'valueQuantity' } },
  { id: 'l_warm', type: 'number', unitField: 'l_u', repeat: true, group: 'lk', fhir: { resource: 'Observation', valueType: 'valueQuantity' } },
  { id: 'l_solo', type: 'datetime' },
  { id: 'l_name', type: 'text' }] }] });
const prov = () => providesOf(lake(), []);
const slotOf = (r, n) => r.slots.find((x) => x.slot === n);

test('met: resource, role and unit string all match, with a basis on every match', () => {
  const r = compatibility([{ slot: 'v', resource: 'Observation', role: 'quantity', unit: 'L' }], prov());
  assert.equal(r.slots[0].status, 'met');
  assert.deepEqual(r.slots[0].matched, [{ fieldId: 'l_vol', basis: 'matched on: Observation, quantity, L' }]);
});

test('unmet: wrong role, wrong resource, or a field with no fhir block (a wrong unit is partly)', () => {
  assert.equal(compatibility([{ slot: 'a', role: 'category' }], prov()).slots[0].status, 'unmet');
  assert.equal(compatibility([{ slot: 'a', resource: 'Condition', role: 'quantity', unit: 'any' }], prov()).slots[0].status, 'unmet');
  assert.equal(compatibility([{ slot: 'a', resource: 'Observation', role: 'quantity', unit: 'mL' }], prov()).slots[0].status, 'partly', 'role matches, unit differs (F3b)');
  assert.equal(compatibility([{ slot: 'a', resource: 'Observation', role: 'time' }], prov()).slots[0].status, 'unmet', 'l_when has no fhir block: resource null');
  assert.deepEqual(compatibility([{ slot: 'a', role: 'quantity', unit: 'mL' }], prov()).slots[0].matched, []);
});

test('no conversion: units match as exact strings', () => {
  assert.equal(compatibility([{ slot: 'a', role: 'quantity', unit: 'l' }], prov()).slots[0].status, 'partly');
  assert.equal(compatibility([{ slot: 'a', role: 'quantity', unit: 'L' }], prov()).slots[0].status, 'met');
});

test('unit "any" (or no unit) matches every unit, including unitless and per-row units', () => {
  const r = compatibility([{ slot: 'a', resource: 'Observation', role: 'quantity', unit: 'any' }], prov());
  assert.deepEqual(r.slots[0].matched.map((m) => m.fieldId), ['l_vol', 'l_ph', 'l_warm']);
  assert.deepEqual(r.slots[0].matched.map((m) => m.basis), [
    'matched on: Observation, quantity, L', 'matched on: Observation, quantity, no unit', 'matched on: Observation, quantity, unit varies by row']);
  assert.equal(compatibility([{ slot: 'a', role: 'quantity' }], prov()).slots[0].matched.length, 3);
});

test('a unit named by the slot never matches a per-row unit, and "-" matches only unitless', () => {
  assert.ok(!compatibility([{ slot: 'a', role: 'quantity', unit: 'L' }], prov()).slots[0].matched.some((m) => m.fieldId === 'l_warm'));
  assert.deepEqual(compatibility([{ slot: 'a', role: 'quantity', unit: '-' }], prov()).slots[0].matched.map((m) => m.fieldId), ['l_ph']);
});

test('sameRowAs: the time slot must come from the same repeat group as the value slot', () => {
  const r = compatibility([
    { slot: 'value', resource: 'Observation', role: 'quantity', unit: 'L' },
    { slot: 'when', role: 'time', sameRowAs: 'value' }], prov());
  assert.equal(slotOf(r, 'when').status, 'met');
  assert.deepEqual(slotOf(r, 'when').matched.map((m) => m.fieldId), ['l_when'], 'l_solo is in no group, so it is not the same row');
  assert.match(slotOf(r, 'when').matched[0].basis, /same row as value/);
  const r2 = compatibility([
    { slot: 'value', role: 'quantity', unit: 'mL' },
    { slot: 'when', role: 'time', sameRowAs: 'value' }], prov());
  assert.equal(slotOf(r2, 'value').status, 'partly');
  assert.equal(slotOf(r2, 'when').status, 'unmet', 'no value field met the slot, so no same row');
  assert.equal(compatibility([{ slot: 'when', role: 'time', sameRowAs: 'nope' }], prov()).slots[0].status, 'unmet');
});

test('bad input gives empty or unmet results, never an error; order of slots is kept', () => {
  assert.deepEqual(compatibility(null, null), { slots: [], unusedFields: [] });
  assert.equal(compatibility([null, { slot: 'x' }], prov()).slots.length, 2);
  assert.ok(compatibility([null, { slot: 'x' }], prov()).slots.every((s) => s.status === 'unmet'));
  const r = compatibility([{ slot: 'b', role: 'text' }, { slot: 'a', role: 'time' }], prov());
  assert.deepEqual(r.slots.map((s) => s.slot), ['b', 'a']);
});

// ---- F3b: partly, manual binding, unused fields ----
const coded = (b) => providesOf(lake(), b || []);
const bind = (field, system, code) => ({ set_id: 'test.lake', field_id: field, system, code });

test('partly: role matches but the unit differs, and the report says so', () => {
  const r = compatibility([{ slot: 'v', resource: 'Observation', role: 'quantity', unit: 'mL' }], prov());
  assert.equal(r.slots[0].status, 'partly');
  assert.deepEqual(r.slots[0].matched, []);
  const p = r.slots[0].partial.find((x) => x.fieldId === 'l_vol');
  assert.deepEqual(p.differs, ['unit differs (slot mL, field L)']);
  assert.match(p.basis, /^role matches; unit differs/);
  assert.ok(r.slots[0].partial.some((x) => x.fieldId === 'l_warm' && /unit varies by row/.test(x.differs[0])));
});

test('partly: code system differs, or the field has no code; met when it carries the system', () => {
  const slot = { slot: 'v', role: 'quantity', unit: 'L', codeSystem: 'sysB' };
  const none = compatibility([slot], prov()).slots[0];
  assert.equal(none.status, 'partly');
  assert.deepEqual(none.partial[0].differs, ['code system differs (slot needs sysB, field has none)']);
  const other = compatibility([slot], coded([bind('l_vol', 'sysA', '1')])).slots[0];
  assert.deepEqual(other.partial[0].differs, ['code system differs (slot needs sysB, field has sysA)']);
  const ok = compatibility([slot], coded([bind('l_vol', 'sysA', '1'), bind('l_vol', 'sysB', '2')])).slots[0];
  assert.equal(ok.status, 'met');
  assert.equal(ok.matched[0].basis, 'matched on: quantity, L, code system sysB');
  assert.equal(compatibility([{ slot: 'v', role: 'quantity', unit: 'L', codeSystem: 'any' }], prov()).slots[0].status, 'met');
});

test('partly names both differences when unit and code both differ; a wrong role is unmet, not partly', () => {
  const r = compatibility([{ slot: 'v', role: 'quantity', unit: 'mL', codeSystem: 'sysB' }], prov()).slots[0];
  assert.equal(r.status, 'partly');
  assert.equal(r.partial.find((x) => x.fieldId === 'l_vol').differs.length, 2);
  assert.equal(compatibility([{ slot: 'v', role: 'category', unit: 'mL' }], prov()).slots[0].status, 'unmet');
  assert.equal(compatibility([{ slot: 'v', resource: 'Condition', role: 'quantity', unit: 'mL' }], prov()).slots[0].status, 'unmet');
});

test('manual binding is honoured with basis "bound by hand", even when nothing matched', () => {
  const req = [{ slot: 'v', role: 'quantity', unit: 'mL' }];
  const r = compatibility(req, prov(), [{ slot: 'v', fieldId: 'l_vol' }]).slots[0];
  assert.equal(r.status, 'met');
  assert.deepEqual(r.matched, [{ fieldId: 'l_vol', basis: 'bound by hand' }]);
  assert.ok(!r.partial.length, 'a slot that is met reports no partials');
  // bound by hand to a field of another role
  const t = compatibility(req, prov(), [{ slot: 'v', fieldId: 'l_name' }]).slots[0];
  assert.equal(t.status, 'met'); assert.equal(t.matched[0].basis, 'bound by hand');
});

test('manual binding: ignored for an unknown field or slot, listed once, and put before automatic matches', () => {
  const req = [{ slot: 'v', role: 'quantity', unit: 'any' }];
  assert.equal(compatibility([{ slot: 'v', role: 'quantity', unit: 'mL' }], prov(), [{ slot: 'v', fieldId: 'nope' }]).slots[0].status, 'partly');
  assert.equal(compatibility([{ slot: 'v', role: 'category' }], prov(), [{ slot: 'other', fieldId: 'l_vol' }]).slots[0].status, 'unmet');
  const r = compatibility(req, prov(), [{ slot: 'v', fieldId: 'l_ph' }, { slot: 'v', fieldId: 'l_ph' }]).slots[0];
  assert.deepEqual(r.matched.map((m) => m.fieldId), ['l_ph', 'l_vol', 'l_warm']);
  assert.equal(r.matched[0].basis, 'bound by hand'); assert.match(r.matched[1].basis, /^matched on:/);
});

test('a manual binding on the value slot lets a sameRowAs slot be met', () => {
  const req = [{ slot: 'value', role: 'quantity', unit: 'mL' }, { slot: 'when', role: 'time', sameRowAs: 'value' }];
  assert.equal(compatibility(req, prov()).slots[1].status, 'unmet');
  const r = compatibility(req, prov(), [{ slot: 'value', fieldId: 'l_vol' }]);
  assert.equal(r.slots[1].status, 'met'); assert.deepEqual(r.slots[1].matched.map((m) => m.fieldId), ['l_when']);
});

test('unusedFields: provided fields that no slot met or was bound to', () => {
  const r = compatibility([{ slot: 'v', resource: 'Observation', role: 'quantity', unit: 'L' }, { slot: 'n', role: 'text' }], prov());
  assert.deepEqual(r.unusedFields.map((u) => u.fieldId), ['l_when', 'l_ph', 'l_warm', 'l_solo']);
  assert.ok(r.unusedFields.every((u) => typeof u.key === 'string'));
  assert.equal(compatibility([], prov()).unusedFields.length, prov().length);
  const b = compatibility([{ slot: 'v', role: 'category' }], prov(), [{ slot: 'v', fieldId: 'l_ph' }]);
  assert.ok(!b.unusedFields.some((u) => u.fieldId === 'l_ph'));
  // a near miss is not a match, so it stays in the unused list
  assert.ok(compatibility([{ slot: 'v', role: 'quantity', unit: 'mL' }], prov()).unusedFields.some((u) => u.fieldId === 'l_vol'));
});

test('compatibility never mentions a seed set id or field id (rule E9)', () => {
  const sandbox = { window: {} };
  require('node:vm').runInNewContext(fs.readFileSync('./element-sets.js', 'utf8'), sandbox);
  const src = fs.readFileSync('./elements.js', 'utf8');
  const part = src.slice(src.indexOf('/* F3a/F3b'), src.indexOf('var api='));
  assert.ok(part.length > 1000, 'found the compatibility code');
  const names = new Set();
  for (const s of sandbox.window.SEED_SETS) { names.add(s.setId); for (const sec of s.sections || []) for (const f of sec.fields) if (f.id.length >= 4) names.add(f.id); }
  names.delete('slot'); // key of a requirement ({slot, role, ...}), not a field
  for (const n of names) assert.ok(!new RegExp('["\'.]' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']?\\b').test(part), 'compatibility mentions ' + n);
});
