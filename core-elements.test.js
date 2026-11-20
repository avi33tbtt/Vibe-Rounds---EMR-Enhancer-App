'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const Core = require('./core-elements.js'), Elements = require('./elements.js');

test('core.registration is a read-only provides list, not a recording set', () => {
  assert.equal(Core.setId, 'core.registration');
  assert.equal(Core.recording, false);
  const p = Core.provides();
  assert.ok(p.length > 0);
  for (const e of p) {
    assert.ok(e.fieldId && e.role && e.resource && e.key, 'entry has fieldId, role, resource, key');
    assert.equal(e.system, null); assert.equal(e.code, null);   // the software never fills a code in
    assert.equal(e.unit, '-');
  }
  assert.deepEqual(p.map((e) => e.role), ['category', 'time']);
  assert.equal(p[0].key, 'Patient.value | category | - | -');
});

test('every entry is backed by a column registration really writes; no identifier is an element', () => {
  const src = fs.readFileSync(require('node:path').join(__dirname, 'patients.js'), 'utf8');
  const insert = src.split('\n').find((l) => l.includes('INSERT INTO patients (') && l.includes('date_of_birth'));
  assert.ok(insert, 'patients.js has the registration INSERT');
  for (const f of Core.fields) assert.ok(insert.includes(f.column), f.column + ' is written at registration');
  const ids = Core.fields.map((f) => (f.fieldId + ' ' + f.column).toLowerCase()).join(' ');
  for (const bad of ['mrn', 'name', 'phone', 'national']) assert.ok(!ids.includes(bad), bad + ' is an identifier, not an element');
});

test('entries have the same shape as providesOf and work with compatibility()', () => {
  const made = Elements.providesOf({ setId: 'x.made_up', sections: [{ fields: [{ id: 'a', type: 'select', fhir: { resource: 'Patient' } }] }] }, []);
  assert.deepEqual(Object.keys(Core.provides()[0]).filter((k) => k !== 'note').sort(), Object.keys(made[0]).sort());
  const r = Elements.compatibility([{ slot: 'sex', role: 'category', resource: 'Patient' }], Core.provides());
  assert.equal(r.slots[0].status, 'met');
});
