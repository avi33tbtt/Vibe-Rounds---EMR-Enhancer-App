'use strict';
// Row R2f-4a: bindings with system "local" are verified against PUBLISHED local terms at submit time. Real PostgreSQL, real routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');
const { stateFrom, bindingsOf } = require('../term-verify');

let env, doctor, inf, admin, n = 0;
const REASON = 'Plain words, no external vocabulary.';

// Take a term to published through the real routes (doctor adds and submits, informatician approves, admin publishes).
async function publishTerm(code, display) {
  const a = await doctor.post('/api/local-terms', { code, display, category: 'finding' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const id = a.body.term.id;
  assert.equal((await doctor.post(`/api/local-terms/${id}/submit`)).status, 200);
  assert.equal((await inf.post(`/api/local-terms/${id}/approve`, { reason: REASON })).status, 200);
  assert.equal((await admin.post(`/api/local-terms/${id}/publish`)).status, 200);
  return a.body.term.version;
}
const def = bindings => ({ title: 'Verify me', fields: [{ id: 'a', label: 'A', type: 'text', bindings }] });
async function newSet(bindings) {
  const r = await doctor.post('/api/element-sets', { slug: 'tv-' + (++n), kind: 'custom', definition: def(bindings) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const submit = s => doctor.post(`/api/element-sets/${s.set.id}/versions/${s.version.version}/submit`, {});

test.before(async () => {
  env = await setup();
  doctor = client(env.base); inf = client(env.base); admin = client(env.base);
  for (const [c, u] of [[doctor, 'doctor1'], [inf, 'informatician1'], [admin, 'admin1']]) assert.equal((await c.login(u)).status, 200);
});
test.after(async () => { await env.close(); });

test('a local binding with a published code and the same display is verified; the set can be submitted', async () => {
  const v = await publishTerm('tv.one', 'Term one');
  const r = await submit(await newSet([{ system: 'local', code: 'tv.one', display: 'Term one' }]));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const withVersion = await submit(await newSet([{ system: 'local', code: 'tv.one', display: 'Term one', version: String(v) }]));
  assert.equal(withVersion.status, 200, JSON.stringify(withVersion.body));
});

test('a term that is not published, or only a draft, is unverified and blocks the submit', async () => {
  let r = await submit(await newSet([{ system: 'local', code: 'tv.nothere', display: 'Nothing' }]));
  assert.equal(r.status, 422); assert.ok(r.body.lint.findings.some(f => f.rule === 'unverified-code' && /not published/.test(f.message)));
  assert.equal((await doctor.post('/api/local-terms', { code: 'tv.draft', display: 'Draft term' })).status, 201);
  r = await submit(await newSet([{ system: 'local', code: 'tv.draft', display: 'Draft term' }]));
  assert.equal(r.status, 422); assert.ok(r.body.lint.findings.some(f => f.rule === 'unverified-code'));
});

test('a different display, a missing display, or a stale version is unverified', async () => {
  const v = await publishTerm('tv.two', 'Term two');
  for (const [b, re] of [
    [{ system: 'local', code: 'tv.two', display: 'Another words' }, /display does not match/],
    [{ system: 'local', code: 'tv.two' }, /no display/],
    [{ system: 'local', code: 'tv.two', display: 'Term two', version: String(v + 1) }, /version changed/]]) {
    const r = await submit(await newSet([b]));
    assert.equal(r.status, 422, JSON.stringify(b)); assert.ok(r.body.lint.findings.some(f => f.rule === 'unverified-code' && re.test(f.message)), JSON.stringify(r.body.lint.findings));
  }
});

test('a retired term no longer verifies', async () => {
  await publishTerm('tv.three', 'Term three');
  const id = (await doctor.get('/api/local-terms?q=tv.three')).body.terms[0].id;
  assert.equal((await admin.post(`/api/local-terms/${id}/retire`)).status, 200);
  const r = await submit(await newSet([{ system: 'local', code: 'tv.three', display: 'Term three' }]));
  assert.equal(r.status, 422);
});

test('other systems stay unverified on the server, even with a matching local code present', async () => {
  await publishTerm('tv.four', 'Term four');
  const r = await submit(await newSet([{ system: 'loinc', code: 'tv.four', display: 'Term four' }]));
  assert.equal(r.status, 422); assert.ok(r.body.lint.findings.some(f => f.rule === 'unverified-code'));
});

test('a new published version with a new display: the old display no longer verifies, the new one does', async () => {
  const v1 = await publishTerm('tv.five', 'Term five');
  const v2 = await publishTerm('tv.five', 'Term five, reworded');
  assert.equal(v2, v1 + 1);
  assert.equal((await submit(await newSet([{ system: 'local', code: 'tv.five', display: 'Term five' }]))).status, 422);
  assert.equal((await submit(await newSet([{ system: 'local', code: 'tv.five', display: 'Term five, reworded', version: String(v2) }]))).status, 200);
});

test('a binding version must be digits in text (for example "2"); the shape is checked when the set is saved', async () => {
  for (const version of [0, 2, 1.5, '0', '-1', '1.5', 'two', '', null]) {
    const r = await doctor.post('/api/element-sets', { slug: 'tv-bad' + (++n), kind: 'custom', definition: def([{ system: 'local', code: 'x', display: 'X', version }]) });
    assert.equal(r.status, 400, String(version));
  }
});

test('the pure helpers: unknown never passes', () => {
  const state = stateFrom(new Map([['a', { version: 2, display: 'A' }]]));
  assert.equal(state({ system: 'local', code: 'a', display: 'A', version: '2' }), 'verified');
  assert.equal(state({ system: 'local', code: 'a', display: ' A ' }), 'verified');   // trimmed on both sides
  for (const b of [null, {}, { system: 'snomed', code: 'a', display: 'A' }, { system: 'local', code: 'zz', display: 'A' }]) assert.notEqual(state(b), 'verified');
  assert.deepEqual(bindingsOf({ fields: [{ bindings: [{ code: 'x' }], coding: { code: 'y' } }, null] }).map(b => b.code), ['x', 'y']);
});
