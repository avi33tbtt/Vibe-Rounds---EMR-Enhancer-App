'use strict';
// Task B5: the context envelope (context.js, GET /api/cases/:id/context), built to CCIS docs/IMPORT-CONTRACT.md draft 0.1.
// The permission matrix row is in safety-routes.test.js. The CCIS fixtures (CCIS row 1.4) do not exist yet: when they do, this
// exporter must also pass them (IMP-120); passing these tests is not enough.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, reviewers, approveVersion } = require('./helpers');
const { createApp } = require('../app');
const { buildEnvelope, caseRef } = require('../context');

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
const obsOf = body => body.items.filter(i => i.kind === 'observation');

test('route: a versioned envelope with exact pins, typed values, both times, source class and provenance', async () => {
  const f = await fixture();
  const r = await ctx(f.d, f.caseId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = r.body;
  assert.deepEqual(Object.keys(e), ['context_version', 'contract', 'exported_at', 'producer', 'purpose', 'declared', 'case_ref', 'items', 'provenance']);
  assert.equal(e.context_version, '0.1.0'); assert.equal(e.exported_at, NOW.toISOString()); assert.equal(e.purpose, 'analytics');
  const pin = e.items.find(i => i.kind === 'applied_set');
  assert.deepEqual([pin.set_key, pin.version, pin.state, pin.supersedes_ref, pin.from_pathway_ref], [f.set.slug, 1, 'active', null, null]);
  assert.match(pin.checksum, /^[0-9a-f]{64}$/);
  const o = obsOf(e);
  const by = (key, pred = () => true) => o.filter(x => x.concept.field_key === key && pred(x));
  const hr = by('hr', x => x.value && x.value.value === 86)[0];
  assert.deepEqual(hr.value, { kind: 'quantity', value: 86, unit: { display: 'bpm', code: null } });
  assert.deepEqual(hr.concept.codes, [], 'no published set can hold a code yet (review refuses unverified codes), so a concept exports as having none (IMP-073)');
  assert.equal(hr.status, 'amended'); assert.match(hr.corrects_ref, /^ob-\d+$/);
  assert.ok(o.some(x => x.ref === hr.corrects_ref && x.value.value === 88), 'the original is kept and linked (IMP-081)');
  assert.match(hr.effective_at, /Z$/); assert.match(hr.recorded_at, /Z$/);
  assert.equal(by('count')[0].value.kind, 'decimal', 'a number without a unit is not a quantity');
  assert.equal(by('rr', x => x.flags.derived).length, 1);
  assert.deepEqual(by('alert')[0].value, { kind: 'boolean', value: false }, 'false stays false');
  const u = by('avpu')[0];
  assert.deepEqual([u.value, u.value_state], [null, 'unknown'], 'unknown stays unknown, not blank or zero');
  assert.equal(by('hr', x => x.flags.ai_proposed)[0].status, 'preliminary');
  assert.equal(by('rr', x => x.flags.derived)[0].source_class, 'derived');
  assert.deepEqual(by('rr', x => x.flags.derived)[0].derivation, { recorded: false });
  assert.equal(by('hr', x => x.flags.ai_proposed)[0].source_class, 'ai_proposed');
  assert.equal(by('hr', x => x.source_class === 'clinician_entered')[0].provenance_ref.startsWith('pv-'), true);
  const pv = e.provenance.find(p => p.ref === hr.provenance_ref);
  assert.deepEqual(pv, { ref: hr.provenance_ref, source_class: 'clinician_entered', supplied_by_role: 'doctor', origin: { set_key: f.set.slug, set_version: 1 }, verified: false, corrected: false });
  assert.ok(e.provenance.some(p => p.corrected === true), 'the corrected original is flagged');
  assert.equal(new Set(e.items.map(i => i.ref)).size, e.items.length, 'refs are unique and every reference resolves');
  for (const x of o) { assert.ok(e.items.some(i => i.ref === x.applied_set_ref)); assert.ok(e.provenance.some(p => p.ref === x.provenance_ref)); }
});

test('route: identity, narrative, free text, usernames and case numbers are provably absent', async () => {
  const f = await fixture();
  const r = await ctx(f.d, f.caseId);
  const text = JSON.stringify(r.body);
  for (const s of [NAME, 'Zelda', 'Hargrove', MRN, DOB, '1971', NARR, 'snakebite', FREE, 'sister', REF, REASON, 'Re-measured', 'doctor1', 'nurse1', 'admin1', 'Hargrove case title', 'CASE-'])
    assert.ok(!text.includes(s), `the envelope must not contain "${s}"`);
  assert.match(r.body.case_ref, /^cx_[0-9a-f]{32}$/);
  assert.notEqual(r.body.case_ref, caseRef(SECRET, f.caseId + 1), 'another case, another reference');
  assert.notEqual(r.body.case_ref, caseRef('another-secret-another-secret-another-1', f.caseId), 'the reference depends on the server secret');
  assert.deepEqual(r.body.declared.excluded_categories, ['identity', 'narrative', 'entered_in_error']);
  assert.deepEqual(r.body.declared.included_categories, []);
  assert.equal(r.body.declared.withheld.narrative_observations, 1, 'the free-text value is withheld and counted');
  assert.equal(r.body.declared.withheld.entered_in_error_observations, 1);
  assert.ok(r.body.declared.withheld.unclassified_events > 0, 'system events are left out with a declared count (IMP-061)');
  assert.equal(obsOf(r.body).filter(o => o.concept.field_key === 'comment').length, 0);
  assert.equal(obsOf(r.body).some(o => o.status === 'entered_in_error'), false);
});

test('route: entered-in-error only with purpose=audit and include=entered_in_error, marked and recorded in the envelope', async () => {
  const f = await fixture();
  let r = await ctx(f.d, f.caseId, '?purpose=audit&include=entered_in_error');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ee = obsOf(r.body).filter(o => o.status === 'entered_in_error');
  assert.equal(ee.length, 1);
  assert.deepEqual([ee[0].value_state, ee[0].value.value], ['entered_in_error', 777]);
  assert.deepEqual(r.body.declared.included_categories, ['entered_in_error']);
  assert.deepEqual(r.body.declared.excluded_categories, ['identity', 'narrative']);
  assert.equal(r.body.purpose, 'audit');
  assert.ok(!JSON.stringify(r.body).includes(REASON), 'even then the free-text reason stays out');
  assert.equal((await ctx(f.d, f.caseId, '?include=entered_in_error')).body.error, 'include_not_allowed', 'the default purpose cannot include it');
  assert.equal((await ctx(f.d, f.caseId, '?purpose=audit&include=identity')).body.error, 'include_not_allowed', 'identity can never be included (IMP-096)');
  assert.equal((await ctx(f.d, f.caseId, '?purpose=audit&include=narrative')).body.error, 'include_not_allowed');
});

test('route: unknown purposes, parameters and repeated values are refused; unknown case is 404', async () => {
  const f = await fixture();
  assert.equal((await ctx(f.d, f.caseId, '?purpose=marketing')).body.error, 'unknown_purpose');
  assert.equal((await ctx(f.d, f.caseId, '?purpose=analytics&purpose=audit')).status, 400);
  assert.equal((await ctx(f.d, f.caseId, '?patient=1')).body.error, 'unknown_parameter');
  assert.equal((await ctx(f.d, 999999)).status, 404);
  assert.equal((await ctx(f.d, 'abc')).status, 404);
});

test('route: the same case gives identical bytes (deterministic order, same clock); a new value changes only the observations', async () => {
  const f = await fixture();
  const a = JSON.stringify((await ctx(f.d, f.caseId)).body), b = JSON.stringify((await ctx(await as('admin1'), f.caseId)).body);
  assert.equal(a, b);
  assert.equal(JSON.stringify((await ctx(f.d, f.caseId, '?purpose=analytics')).body), a, 'naming the default purpose changes nothing');
  const before = JSON.parse(a), n = before.items.filter(i => i.kind === 'observation').length;
  assert.equal((await f.d.post(`/api/cases/${f.caseId}/observations`, { observations: [{ appliedSetId: f.appliedId, fieldKey: 'rr', value: 22, effectiveAt: ago(1), sourceType: 'clinician' }] })).status, 201);
  const after = (await ctx(f.d, f.caseId)).body;
  assert.equal(after.items.filter(i => i.kind === 'observation').length, n + 1);
  assert.equal(after.case_ref, before.case_ref, 'the reference is stable across exports');
  const old = new Map(before.items.map(i => [i.ref, JSON.stringify(i)]));
  for (const i of after.items) if (old.has(i.ref)) assert.equal(JSON.stringify(i), old.get(i.ref), 'existing items keep their reference and content');
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
  await approveVersion(R, set2.id, 2); assert.equal((await admin.post(`/api/element-sets/${set2.id}/versions/2/publish`, {})).status, 200);
  assert.equal(v2.status, 201);
  const e = (await ctx(f.d, f.caseId)).body;
  const p = e.items.find(i => i.kind === 'applied_pathway');
  assert.deepEqual([p.pathway_key, p.version], [pw.body.pathway.slug, 1]); assert.match(p.checksum, /^[0-9a-f]{64}$/);
  const s = e.items.find(i => i.kind === 'applied_set' && i.set_key === set2.slug);
  assert.deepEqual([s.version, s.from_pathway_ref], [1, p.ref], 'exact version 1, not the newer 2; and the pin names its pathway');
});

test('route: audited with counts only; the audit row holds no value, name or reference', async () => {
  const f = await fixture();
  const before = (await env.pool.query('SELECT max(id) AS m FROM audit_log')).rows[0].m;
  const r = await ctx(f.d, f.caseId);
  const rows = (await env.pool.query(`SELECT * FROM audit_log WHERE id > $1 AND action = 'context.export'`, [before])).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].username, rows[0].role, rows[0].entity_type, rows[0].entity_id], ['doctor1', 'doctor', 'case', String(f.caseId)]);
  assert.equal(rows[0].detail.items, r.body.items.length);
  assert.equal(rows[0].detail.purpose, 'analytics');
  const s = JSON.stringify(rows[0]);
  for (const x of [NAME, MRN, NARR, FREE, r.body.case_ref]) assert.ok(!s.includes(x), `audit row must not hold ${x}`);
  assert.deepEqual(Object.keys(rows[0].detail).sort(), ['contextVersion', 'include', 'items', 'purpose', 'withheld']);
});

test('route: only admin and doctor may read it; others get 403 and no export is audited', async () => {
  const f = await fixture();
  const before = (await env.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'context.export'`)).rows[0].n;
  for (const u of ['nurse1', 'viewer1', 'informatician1']) { const r = await ctx(await as(u), f.caseId); assert.equal(r.status, 403, u); assert.equal(r.body.perm, 'context:read'); }
  assert.equal((await ctx(client(env.base), f.caseId)).status, 401);
  assert.equal((await ctx(await as('admin1'), f.caseId)).status, 200);
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'context.export'`)).rows[0].n, before + 1);
});

test('route: without CONTEXT_REF_SECRET (or with a short one) the route refuses with 503 and exports nothing', async () => {
  const f = await fixture();
  const before = (await env.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'context.export'`)).rows[0].n;
  for (const secret of ['', 'too-short']) {
    const srv = createApp(env.appPool, { quiet: true, contextSecret: secret, contextNow: () => NOW }).listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    try {
      const d = client(`http://127.0.0.1:${srv.address().port}`); assert.equal((await d.login('doctor1')).status, 200);
      const r = await d.get(`/api/cases/${f.caseId}/context`);
      assert.equal(r.status, 503); assert.equal(r.body.error, 'context_not_configured');
    } finally { await new Promise(r => srv.close(r)); }
  }
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'context.export'`)).rows[0].n, before, 'nothing was exported or audited');
});

// ---------- the pure builder (no database) ----------
const T = '2026-11-20T10:00:00.000Z';
const base = () => ({
  caseId: 7, eventCount: 0,
  appliedSets: [{ id: 1, slug: 's', version: 2, checksum: 'a'.repeat(64), definition_json: { fields: [{ id: 'f', type: 'number', unit: 'mg' }] }, state: 'active', applied_at: T, state_at: null, supersedes_id: null, from_applied_pathway_id: null }],
  appliedPathways: [],
  observations: [],
});
const ob = (id, extra = {}) => ({ id, applied_set_id: 1, field_key: 'f', value_type: 'number', value_json: 5, unit_display: 'mg', effective_at: T, recorded_at: T, source_type: 'clinician', status: 'final', corrects_id: null, recorded_role: 'nurse', ...extra });

test('builder: deterministic for the same input and clock, whatever order the rows arrive in', () => {
  const i1 = base(); i1.observations = [ob(1), ob(2, { effective_at: '2026-11-20T09:00:00.000Z' }), ob(3, { value_json: 6 })];
  const i2 = base(); i2.observations = [ob(3, { value_json: 6 }), ob(1), ob(2, { effective_at: '2026-11-20T09:00:00.000Z' })];
  const o = { secret: SECRET, now: NOW };
  assert.equal(JSON.stringify(buildEnvelope(i1, o)), JSON.stringify(buildEnvelope(i2, o)));
  const e = buildEnvelope(i1, o);
  assert.deepEqual(obsOf(e).map(x => x.effective_at), [...obsOf(e).map(x => x.effective_at)].sort(), 'ordered by effective time');
  assert.notEqual(JSON.stringify(buildEnvelope(i1, { secret: SECRET, now: new Date(NOW.getTime() + 1000) })), JSON.stringify(e), 'the export time is the one field that moves with the clock');
});

test('builder: a correction whose original is withheld says so instead of leaving a dangling reference', () => {
  const i = base(); i.observations = [ob(1, { status: 'entered_in_error' }), ob(2, { status: 'amended', corrects_id: 1, value_json: 6 })];
  const e = buildEnvelope(i, { secret: SECRET, now: NOW });
  const c = obsOf(e)[0];
  assert.equal(obsOf(e).length, 1);
  assert.deepEqual([c.corrects_ref, c.correction_target_withheld], [null, true]);
  const all = buildEnvelope(i, { secret: SECRET, now: NOW, purpose: 'audit', include: ['entered_in_error'] });
  assert.equal(obsOf(all).length, 2); assert.equal(obsOf(all)[1].corrects_ref, obsOf(all)[0].ref);
  assert.equal(obsOf(all)[1].correction_target_withheld, undefined);
});

test('builder: concepts with no code export no code; a code is always unverified; an unlisted unit is not invented', () => {
  const i = base(); i.observations = [ob(1, { unit_display: null })];
  const e = buildEnvelope(i, { secret: SECRET, now: NOW });
  assert.deepEqual(obsOf(e)[0].concept.codes, []);
  assert.deepEqual(obsOf(e)[0].value, { kind: 'decimal', value: 5 });
  i.appliedSets[0].definition_json.fields[0].bindings = [{ system: 'http://snomed.info/sct', code: '123' }, { system: 'x' }];
  const c = buildEnvelope(i, { secret: SECRET, now: NOW });
  assert.deepEqual(obsOf(c)[0].concept.codes, [{ system: 'http://snomed.info/sct', system_version: null, code: '123', display: null, verification: 'unverified' }]);
});
