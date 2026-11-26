'use strict';
// Task B5a-2: GET /api/cases/:id/context returns the CCIS context envelope built by envelope.js (pure builder tests: envelope.test.js).
// Every response is validated against the vendored CCIS schema in contracts/. The permission matrix row is in safety-routes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');
const { createApp } = require('../app');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { caseRef } = require('../envelope');

const C = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', f), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(C('manifest.schema.json'));
const validate = ajv.compile(C('context-envelope.schema.json'));
const ok = e => assert.equal(validate(e), true, JSON.stringify(validate.errors, null, 1));

const SECRET = 'test-secret-test-secret-test-secret-1234';
const NOW = new Date('2026-11-23T08:00:00.000Z');
const NAME = 'Zelda Hargrove', MRN = 'CTX-90817', DOB = '1971-03-09', NARR = 'Narrative sentence about the snakebite at the paddy field.';
const FREE = 'Zelda Hargrove said her sister Quentin brought her in', REF = 'Ward round with Dr Hargrove', REASON = 'mistyped for Zelda';

let env, R, admin, seq = 0, pn = 0;
test.before(async () => { env = await setup({ contextSecret: SECRET, contextNow: () => NOW }); R = await reviewers(env.base); admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200); });
test.after(async () => { await env.close(); });
const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const ctx = (c, caseId, qs = '') => c.get(`/api/cases/${caseId}/context${qs}`);

const DEF = { title: 'Ctx set', fields: [
  { id: 'hr', label: 'Heart rate', type: 'number', unit: 'bpm' },
  { id: 'rr', label: 'Resp rate', type: 'integer', unit: '/min' },
  { id: 'count', label: 'Count', type: 'number' },
  { id: 'alert', label: 'Alert', type: 'boolean' },
  { id: 'avpu', label: 'AVPU', type: 'select', options: ['Alert', 'Voice', 'Pain'] },
  { id: 'comment', label: 'Comment', type: 'text' },
] };
async function publishedSet(def = DEF) {
  const slug = 'ctx-set-' + (++seq);
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: def });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return { id: made.body.set.id, slug };
}
// One case with everything the envelope must handle. Returns ids and the observation ids by name.
async function fixture() {
  const d = await as('doctor1');
  const set = await publishedSet();
  const p = await d.post('/api/patients', { name: NAME + ' ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[(pn++) % 26], mrn: MRN + '-' + (++seq), dob: DOB, sex: 'F' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const k = await d.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Hargrove case title' });
  const caseId = k.body.case.id;
  assert.equal((await d.post(`/api/cases/${caseId}/narrative`, { body: NARR })).status, 201);
  const a = (await d.post(`/api/cases/${caseId}/applied-sets`, { setId: set.id, version: 1 })).body.appliedSet;
  const rec = async (...obs) => { const r = await d.post(`/api/cases/${caseId}/observations`, { observations: obs.map(o => ({ appliedSetId: a.id, effectiveAt: ago(30), sourceType: 'clinician', ...o })) }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.observations || r.body.ids; };
  await rec({ fieldKey: 'hr', value: 88, sourceRef: REF }, { fieldKey: 'rr', value: 18 }, { fieldKey: 'count', value: 3 }, { fieldKey: 'alert', value: false },
    { fieldKey: 'avpu', unknown: true }, { fieldKey: 'comment', value: FREE });
  await rec({ fieldKey: 'hr', value: 90, sourceType: 'ai_proposed' }, { fieldKey: 'rr', value: 20, sourceType: 'derived' }, { fieldKey: 'hr', value: 777, sourceRef: REF });
  const rows = (await env.pool.query('SELECT id, field_key, value_json FROM observations WHERE case_id = $1 ORDER BY id', [caseId])).rows;
  const wrong = rows.find(r => r.field_key === 'hr' && Number(r.value_json) === 777);
  assert.equal((await d.post(`/api/observations/${wrong.id}/entered-in-error`, { reason: REASON })).status, 200);
  const first = rows.find(r => r.field_key === 'hr' && Number(r.value_json) === 88);
  assert.equal((await d.post(`/api/observations/${first.id}/correct`, { value: 86, sourceType: 'clinician', reason: 'Re-measured for ' + NAME })).status, 201);
  return { d, caseId, set, patientId: p.body.patient.id, appliedId: a.id };
}

const bySuffix = (e, key) => e.observations.filter(o => o.concept.id.endsWith('.' + key));
const withheldCount = (pool, extra = '') => pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'context.export'` + extra).then(r => r.rows[0].n);

test('route: a schema-valid envelope with exact pins, typed values, both times, source class and provenance', async () => {
  const f = await fixture();
  const r = await ctx(f.d, f.caseId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = r.body; ok(e);
  assert.deepEqual(Object.keys(e), ['envelope', 'inclusions', 'case', 'applied', 'observations', 'events', 'x-emr']);
  assert.deepEqual([e.envelope.version, e.envelope.exportedAt, e.envelope.producer.system], ['0.1.0', NOW.toISOString(), 'emr-enhancer']);
  assert.deepEqual(e.applied.elements, [{ id: f.set.slug, type: 'contextual-element', version: '1.0.0' }]);
  const hr = bySuffix(e, 'hr').find(x => x.value === 86);
  assert.deepEqual([hr.kind, hr.unit, hr.status, hr.sourceClass], ['quantity', 'bpm', 'corrected', 'clinician-entered']);
  assert.deepEqual(hr.concept.codes, [], 'no published set can hold a code yet, so a concept exports as having none');
  const orig = bySuffix(e, 'hr').find(x => x.value === 88);
  assert.equal(hr.correctionOf, orig.id, 'the original is kept and linked'); assert.equal(orig.provenance.corrected, true);
  assert.deepEqual(hr.provenance, { roleClass: 'doctor', origin: `emr-enhancer/${f.set.slug}@1.0.0`, verified: false, corrected: false });
  assert.match(hr.effective.value, /Z$/); assert.equal(hr.effective.zone, 'stated'); assert.equal(hr.recorded.zone, 'stated');
  assert.equal(bySuffix(e, 'count').length, 0, 'a number without a unit is withheld, not called a quantity');
  const rr = bySuffix(e, 'rr'); assert.deepEqual(rr.map(x => [x.kind, x.value]), [['integer', 18]], 'the derived rr row is withheld');
  const alert = bySuffix(e, 'alert')[0]; assert.equal(alert.value, false); assert.equal('state' in alert, false, 'false stays false');
  const u = bySuffix(e, 'avpu')[0]; assert.equal(u.state, 'unknown'); assert.equal('value' in u, false, 'unknown stays unknown, not blank or zero');
  const ai = bySuffix(e, 'hr').find(x => x.value === 90); assert.deepEqual([ai.status, ai.sourceClass], ['preliminary', 'ai-proposed']);
  assert.equal(new Set(e.observations.map(o => o.id)).size, e.observations.length, 'ids are unique');
  assert.deepEqual(e.events, []);
  assert.deepEqual(e['x-emr'].withheld, { narrativeObservations: 1, enteredInErrorObservations: 1, unitlessNumbers: 1, derivedObservations: 1, correctionTargetsWithheld: 0, events: e['x-emr'].withheld.events });
  assert.ok(e['x-emr'].withheld.events > 0, 'system events are left out with a declared count');
});

test('route: identity, narrative, free text, usernames and case numbers are provably absent', async () => {
  const f = await fixture();
  const r = await ctx(f.d, f.caseId);
  const text = JSON.stringify(r.body);
  for (const s of [NAME, 'Zelda', 'Hargrove', MRN, DOB, '1971', NARR, 'snakebite', FREE, 'sister', REF, REASON, 'Re-measured', 'doctor1', 'nurse1', 'admin1', 'Hargrove case title', 'CASE-'])
    assert.ok(!text.includes(s), `the envelope must not contain "${s}"`);
  assert.match(r.body.case.ref, /^cx_[0-9a-f]{32}$/);
  assert.equal(r.body.case.ref, caseRef(SECRET, f.caseId), 'the pseudonym is the keyed reference of this case');
  assert.notEqual(r.body.case.ref, caseRef(SECRET, f.caseId + 1), 'another case, another reference');
  assert.notEqual(r.body.case.ref, caseRef('another-secret-another-secret-another-1', f.caseId), 'the reference depends on the server secret');
  assert.deepEqual(r.body.inclusions, { identity: false, narrative: false, enteredInError: false });
  assert.equal(bySuffix(r.body, 'comment').length, 0);
  assert.equal(text.includes('777'), false, 'the entered-in-error value is not exported');
});

test('route: no parameters are accepted (no purpose, no include); unknown case is 404', async () => {
  const f = await fixture();
  for (const qs of ['?purpose=analytics', '?purpose=audit&include=entered_in_error', '?include=identity', '?patient=1']) {
    const r = await ctx(f.d, f.caseId, qs); assert.equal(r.status, 400, qs); assert.equal(r.body.error, 'unknown_parameter');
  }
  assert.equal((await ctx(f.d, 999999)).status, 404);
  assert.equal((await ctx(f.d, 'abc')).status, 404);
});

test('route: the same case gives identical bytes (deterministic order, same clock); a new value changes only the observations', async () => {
  const f = await fixture();
  const a = JSON.stringify((await ctx(f.d, f.caseId)).body), b = JSON.stringify((await ctx(await as('admin1'), f.caseId)).body);
  assert.equal(a, b);
  const before = JSON.parse(a), n = before.observations.length;
  assert.equal((await f.d.post(`/api/cases/${f.caseId}/observations`, { observations: [{ appliedSetId: f.appliedId, fieldKey: 'rr', value: 22, effectiveAt: ago(1), sourceType: 'clinician' }] })).status, 201);
  const after = (await ctx(f.d, f.caseId)).body; ok(after);
  assert.equal(after.observations.length, n + 1);
  assert.equal(after.case.ref, before.case.ref, 'the reference is stable across exports');
  assert.deepEqual(after.applied, before.applied);
});

test('route: a pathway pin and its sets carry the applied versions, not the newest', async () => {
  const f = await fixture();
  const set2 = await publishedSet({ title: 'Second', fields: [{ id: 'x', label: 'X', type: 'integer' }] });
  const pw = await R.doctor.post('/api/pathways', { slug: 'ctx-pw-' + (++seq), title: 'Ctx pathway', steps: [{ setId: set2.id, version: 1 }] });
  assert.equal(pw.status, 201, JSON.stringify(pw.body));
  assert.equal((await admin.post(`/api/pathways/${pw.body.pathway.id}/versions/1/publish`, {})).status, 200);
  const ap = await f.d.post(`/api/cases/${f.caseId}/applied-pathways`, { pathwayId: pw.body.pathway.id, version: 1 });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  const v2 = await R.doctor.post(`/api/element-sets/${set2.id}/versions`, { definition: { title: 'Second v2', fields: [{ id: 'x', label: 'X', type: 'integer' }, { id: 'y', label: 'Y', type: 'integer' }] } });
  assert.equal(v2.status, 201);
  await approveVersion(R, set2.id, 2); assert.equal((await admin.post(`/api/element-sets/${set2.id}/versions/2/publish`, {})).status, 200);
  const e = (await ctx(f.d, f.caseId)).body; ok(e);
  assert.deepEqual(e.applied.pathways, [{ id: pw.body.pathway.slug, type: 'pathway', version: '1.0.0' }]);
  assert.ok(e.applied.elements.some(x => x.id === set2.slug && x.version === '1.0.0'), 'exact version 1 of the set, not the newer 2');
  assert.equal(e.applied.elements.some(x => x.id === set2.slug && x.version === '2.0.0'), false);
});

test('route: audited with counts only; the audit row holds no value, name or reference', async () => {
  const f = await fixture();
  const before = (await env.pool.query('SELECT max(id) AS m FROM audit_log')).rows[0].m;
  const r = await ctx(f.d, f.caseId);
  const rows = (await env.pool.query(`SELECT * FROM audit_log WHERE id > $1 AND action = 'context.export'`, [before])).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].username, rows[0].role, rows[0].entity_type, rows[0].entity_id], ['doctor1', 'doctor', 'case', String(f.caseId)]);
  assert.equal(rows[0].detail.observations, r.body.observations.length);
  assert.equal(rows[0].detail.envelopeVersion, '0.1.0');
  const s = JSON.stringify(rows[0]);
  for (const x of [NAME, MRN, NARR, FREE, r.body.case.ref]) assert.ok(!s.includes(x), `audit row must not hold ${x}`);
  assert.deepEqual(Object.keys(rows[0].detail).sort(), ['envelopeVersion', 'observations', 'sha256', 'withheld']);
});

test('route: only admin and doctor may read it; others get 403 and no export is audited', async () => {
  const f = await fixture();
  const before = await withheldCount(env.pool);
  for (const u of ['nurse1', 'viewer1', 'informatician1']) { const r = await ctx(await as(u), f.caseId); assert.equal(r.status, 403, u); assert.equal(r.body.perm, 'context:read'); }
  assert.equal((await ctx(client(env.base), f.caseId)).status, 401);
  assert.equal((await ctx(await as('admin1'), f.caseId)).status, 200);
  assert.equal(await withheldCount(env.pool), before + 1);
});

test('route: without CONTEXT_REF_SECRET (or with a short one) the route refuses with 503 and exports nothing', async () => {
  const f = await fixture();
  const before = await withheldCount(env.pool);
  for (const secret of ['', 'too-short']) {
    const srv = createApp(env.appPool, { quiet: true, contextSecret: secret, contextNow: () => NOW }).listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    try {
      const d = client(`http://127.0.0.1:${srv.address().port}`); assert.equal((await d.login('doctor1')).status, 200);
      const r = await d.get(`/api/cases/${f.caseId}/context`);
      assert.equal(r.status, 503); assert.equal(r.body.error, 'context_not_configured');
    } finally { await new Promise(r => srv.close(r)); }
  }
  assert.equal(await withheldCount(env.pool), before, 'nothing was exported or audited');
});

test('route: two applied sets whose slugs map to the same id give 422 and export and audit nothing', async () => {
  const d = await as('doctor1');
  const mk = async slug => { const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: { title: 'T', fields: [{ id: 'a', label: 'A', type: 'boolean' }] } }); assert.equal(made.status, 201, JSON.stringify(made.body)); await approveVersion(R, made.body.set.id, 1); assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200); return made.body.set.id; };
  const s1 = await mk('ctx-clash_' + (++seq)), s2 = await mk('ctx-clash-' + seq);
  const p = await d.post('/api/patients', { name: 'Clash Patient', mrn: 'CLASH-' + seq, dob: DOB, sex: 'F' });
  const k = await d.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Clash' }); const caseId = k.body.case.id;
  for (const s of [s1, s2]) assert.equal((await d.post(`/api/cases/${caseId}/applied-sets`, { setId: s, version: 1 })).status, 201);
  const before = await withheldCount(env.pool);
  const r = await ctx(d, caseId);
  assert.equal(r.status, 422); assert.equal(r.body.error, 'envelope_unmappable');
  assert.equal(await withheldCount(env.pool), before);
});

// ---------- B5b: the export log and the downloadable file ----------
async function rawGet(user, path) {
  const login = await fetch(env.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-emr': '1' }, body: JSON.stringify({ username: user, password: 'test-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(env.base + path, { headers: { 'x-emr': '1', cookie } });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const exportsOf = caseId => env.pool.query('SELECT * FROM context_exports WHERE case_id = $1 ORDER BY id', [caseId]).then(r => r.rows);

test('route: a doctor downloads a file; one export row holds the hash of those exact bytes, the session user, no content', async () => {
  const f = await fixture();
  assert.equal((await exportsOf(f.caseId)).length, 0);
  const r = await rawGet('doctor1', `/api/cases/${f.caseId}/context`);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^application\/json/);
  const e = JSON.parse(r.text); ok(e);
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="context-envelope-${e.case.ref}.json"`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const rows = await exportsOf(f.caseId); assert.equal(rows.length, 1);
  const x = rows[0];
  assert.equal(x.envelope_sha256, require('node:crypto').createHash('sha256').update(r.text).digest('hex'));
  assert.deepEqual([x.envelope_version, x.observations], ['0.1.0', e.observations.length]);
  const doc = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id;
  assert.equal(x.exported_by, doc, 'the exporter is the session user');
  const s = JSON.stringify(x); for (const v of [NAME, MRN, NARR, FREE, e.case.ref]) assert.ok(!s.includes(v), `export row must not hold ${v}`);
  const a = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'context.export' AND entity_id = $1`, [String(f.caseId)])).rows;
  assert.equal(a.length, 1); assert.equal(a[0].detail.sha256, x.envelope_sha256, 'audit and export row agree');
  await rawGet('admin1', `/api/cases/${f.caseId}/context`);
  assert.equal((await exportsOf(f.caseId)).length, 2, 'each export is its own row');
});

test('route: a nurse is refused and nothing is logged; unknown case and bad parameters log nothing', async () => {
  const f = await fixture();
  assert.equal((await rawGet('nurse1', `/api/cases/${f.caseId}/context`)).status, 403);
  assert.equal((await rawGet('doctor1', `/api/cases/${f.caseId}/context?purpose=audit`)).status, 400);
  assert.equal((await rawGet('doctor1', `/api/cases/99999999/context`)).status, 404);
  assert.equal((await exportsOf(f.caseId)).length, 0);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM context_exports WHERE case_id = 99999999')).rows[0].n, 0);
});

test('database: the export log cannot be changed, deleted or truncated, even by the owner; the app role has insert and select only', async () => {
  const f = await fixture(); await rawGet('doctor1', `/api/cases/${f.caseId}/context`);
  const id = (await exportsOf(f.caseId))[0].id;
  for (const sql of [`UPDATE context_exports SET observations = 0 WHERE id = ${id}`, `DELETE FROM context_exports WHERE id = ${id}`, 'TRUNCATE context_exports'])
    await assert.rejects(env.pool.query(sql), /immutable|append|not allowed|forbid|cannot/i, sql);
  for (const sql of [`UPDATE context_exports SET observations = 0 WHERE id = ${id}`, `DELETE FROM context_exports WHERE id = ${id}`, 'TRUNCATE context_exports'])
    await assert.rejects(env.appPool.query(sql), /permission denied/i, 'app role: ' + sql);
  assert.equal((await exportsOf(f.caseId)).length, 1);
});

test('route: if the export row cannot be written, nothing is sent and nothing is audited', async () => {
  const f = await fixture();
  await env.pool.query('ALTER TABLE context_exports ADD CONSTRAINT ctx_test_block CHECK (observations < 0) NOT VALID');
  try {
    const before = await withheldCount(env.pool);
    const r = await rawGet('doctor1', `/api/cases/${f.caseId}/context`);
    assert.equal(r.status, 500); assert.equal(r.text.includes('"envelope"'), false, 'no envelope bytes leave');
    assert.equal(await withheldCount(env.pool), before, 'the audit row rolled back with the export row');
  } finally {
    await env.pool.query('ALTER TABLE context_exports DROP CONSTRAINT ctx_test_block');
  }
});

// ---- R3i: problems and allergies in the route ----
test('route R3i: the patient\'s problems and allergies travel as unclassified items with no text; in-error rows are only counted', async () => {
  const f = await fixture();
  const PROB = 'Hypertension noted for Zelda Hargrove', SUBS = 'Penicillin for Zelda Hargrove', RX = 'Rash seen by Quentin';
  const p1 = await f.d.post(`/api/patients/${f.patientId}/problems`, { label: PROB, onsetDate: '2019-05-04' });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  const p2 = await f.d.post(`/api/patients/${f.patientId}/problems`, { label: 'Wrong entry for Zelda Hargrove' });
  assert.equal((await f.d.post(`/api/problems/${p2.body.problem.id}/entered-in-error`, { reason: REASON, rowVersion: p2.body.problem.row_version ?? 1 })).status, 200);
  const a1 = await f.d.post(`/api/patients/${f.patientId}/allergies`, { substance: SUBS, reaction: RX, severity: 'severe' });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  const r = await ctx(f.d, f.caseId); assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = r.body; ok(e);
  assert.equal(e.envelope.version, '0.2.0');
  assert.deepEqual(e.problems.map(x => [x.id, x.lifecycle, x.concept.id]), [['pr-1', 'active', 'unclassified']]);
  assert.deepEqual(e.problems[0].effective, { value: '2019-05-04T00:00', zone: 'unknown' });
  assert.deepEqual(e.allergies.map(x => [x.id, x.lifecycle]), [['al-1', 'active']]);
  const bytes = JSON.stringify(e);
  for (const t of [PROB, SUBS, RX, 'Wrong entry', 'severe', 'Hargrove', 'Quentin']) assert.equal(bytes.includes(t), false, t + ' must not travel');
  assert.equal(e['x-emr'].withheld.enteredInErrorProblems, 1);
  const x = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'context.export' ORDER BY id DESC LIMIT 1`)).rows[0].detail;
  assert.equal(JSON.stringify(x).includes('Hargrove'), false, 'the audit row holds counts only');
});

test('route R3i: another patient\'s problems never appear; a case whose patient has none stays a plain 0.1.0', async () => {
  const f = await fixture(), g = await fixture();
  assert.equal((await f.d.post(`/api/patients/${f.patientId}/allergies`, { substance: 'Sulfa for the other patient' })).status, 201);
  const r = await ctx(g.d, g.caseId); assert.equal(r.status, 200); ok(r.body);
  assert.equal(r.body.envelope.version, '0.1.0');
  assert.equal('allergies' in r.body, false); assert.equal('problems' in r.body, false);
  assert.equal('enteredInErrorAllergies' in r.body['x-emr'].withheld, false);
});
