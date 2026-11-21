'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, sha256Hex, lintPackage, FIELD_TYPES, MAX_CONTENT_BYTES, RULE_OPS, DOSE_LIKE } = require('./package-lint.js');

test('canonicalJson: keys sorted at every level, no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } }), '{"a":{"c":"x","d":[3,1]},"b":1}');
});

test('canonicalJson: array order is kept', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('canonicalJson: values that JSON cannot hold exactly are refused', () => {
  for (const bad of [undefined, () => 1, NaN, Infinity, new Date(), { a: undefined }]) {
    assert.throws(() => canonicalJson(bad), TypeError);
  }
});

test('sha256Hex: known test vector for "abc" and for the empty string', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('hash is the same when keys are in a different order, and differs when a value changes', async () => {
  const a = { id: 'x', fields: [{ id: 'f1', unit: 'mL' }], v: 1 };
  const b = { v: 1, fields: [{ unit: 'mL', id: 'f1' }], id: 'x' };
  const c = { v: 1, fields: [{ unit: 'mg', id: 'f1' }], id: 'x' };
  const ha = await sha256Hex(canonicalJson(a));
  assert.equal(ha, await sha256Hex(canonicalJson(b)));
  assert.notEqual(ha, await sha256Hex(canonicalJson(c)));
  assert.match(ha, /^[0-9a-f]{64}$/);
});

test('sha256Hex: non-ASCII text is hashed as UTF-8 (same as node:crypto)', async () => {
  const s = 'é 中 😀';
  assert.equal(await sha256Hex(s), require('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex'));
});

/* 42a2 and 42a3: lintPackage. Made-up set and roles only: nothing here names a seed set. */
const ROLES = ['admin', 'doctor', 'nurse', 'viewer'];
const goodContent = () => ({
  setId: 'zz.test_set', kind: 'care', version: 1, access: { view: ['doctor', 'nurse'], enter: ['doctor'] },
  sections: [{ id: 's1', fields: [{ id: 't', type: 'datetime' }, { id: 'v', type: 'number', unit: 'mL' }, { id: 'k', type: 'select', options: ['a'] }] }],
  view: { type: 'flowsheet', timeField: 't' },
});
const good = () => ({ manifest: { id: 'care.intake_output', version: '1.0.0', targetApp: 'emr', kind: 'set' }, content: goodContent() });
const lint = (p) => lintPackage(p, { roles: ROLES });
const codes = (p) => lint(p).errors.map((e) => e.code);

test('lintPackage: a good package has no errors and no warnings', () => {
  assert.deepEqual(lint(good()), { errors: [], warnings: [] });
});

test('lintPackage: bad manifest (missing, not an object, no id, no version)', () => {
  for (const bad of [null, undefined, 'x', [], {}, { manifest: null }, { manifest: [] }]) assert.deepEqual(codes(bad), ['bad_manifest']);
  const noId = good(); delete noId.manifest.id;
  assert.deepEqual(lint(noId).errors.map((e) => e.path), ['manifest.id']);
  const noVer = good(); delete noVer.manifest.version;
  assert.deepEqual(lint(noVer).errors.map((e) => [e.code, e.path]), [['bad_manifest', 'manifest.version']]);
  const num = good(); num.manifest.version = 1;
  assert.deepEqual(codes(num), ['bad_manifest']);
});

test('lintPackage: bad semver', () => {
  for (const v of ['1', '1.0', 'v1.0.0', '01.0.0', '1.0.0.0', '1.0.x', ' 1.0.0']) {
    const p = good(); p.manifest.version = v;
    assert.deepEqual(lint(p).errors.map((e) => [e.code, e.path]), [['bad_semver', 'manifest.version']], v);
  }
  for (const v of ['0.0.1', '1.2.3', '1.0.0-beta.1', '2.0.0+build5']) { const p = good(); p.manifest.version = v; assert.deepEqual(codes(p), [], v); }
});

test('lintPackage: bad id pattern', () => {
  for (const id of ['care', 'Care.Intake', 'care.intake output', '.care', 'care.', 'care..x', '1care.x', 'care/x.y', 'care.x\n']) {
    const p = good(); p.manifest.id = id;
    assert.deepEqual(lint(p).errors.map((e) => [e.code, e.path]), [['bad_id', 'manifest.id']], JSON.stringify(id));
  }
  for (const id of ['care.intake_output', 'local.my_form', 'pathway.emr.ward_board']) { const p = good(); p.manifest.id = id; assert.deepEqual(codes(p), [], id); }
});

test('lintPackage: reports id and version problems together, and never throws', () => {
  const p = good(); p.manifest = { id: 'BAD', version: 'x', targetApp: 'emr', kind: 'set' };
  assert.deepEqual(codes(p), ['bad_id', 'bad_semver']);
  assert.doesNotThrow(() => lintPackage(Symbol('x')));
  assert.doesNotThrow(() => lintPackage(good()));   // no opts at all
});

test('42a3: content missing, or holding a value JSON cannot store', () => {
  const p = good(); delete p.content;
  assert.deepEqual(codes(p), ['bad_content']);
  const q = good(); q.content.sections[0].fields[0].default = undefined;
  assert.deepEqual(codes(q), ['content_not_json']);
});

test('42a3: unknown field type, with the path', () => {
  const p = good(); p.content.sections[0].fields[1].type = 'dropdown';
  const r = lint(p).errors.filter((e) => e.code === 'unknown_field_type');
  assert.equal(r.length, 1);
  assert.equal(r[0].path, 'content.sections[0].fields[1].type');
  for (const t of FIELD_TYPES) { const q = good(); q.content.sections[0].fields[1].type = t; assert.equal(codes(q).includes('unknown_field_type'), false, t); }
});

test('42a3: content over 1 MB is refused, just under is not', () => {
  const big = good(); big.content.note = 'x'.repeat(MAX_CONTENT_BYTES + 1);
  assert.deepEqual(codes(big), ['content_too_large']);
  const ok = good(); ok.content.note = 'x'.repeat(MAX_CONTENT_BYTES - 5000);
  assert.deepEqual(codes(ok), []);
  const wide = good(); wide.content.note = '\u00e9'.repeat(MAX_CONTENT_BYTES / 2 + 1);   // 2 bytes each: counted in bytes, not characters
  assert.deepEqual(codes(wide), ['content_too_large']);
});

test('42a3: a key named eval or function is refused at any depth and in any case', () => {
  const p = good(); p.content.sections[0].fields[0].meta = { deep: [{ Eval: 'x' }, { ok: 1 }], FUNCTION: 'y' };
  const r = lint(p).errors.filter((e) => e.code === 'banned_key').map((e) => e.path);
  assert.deepEqual(r.sort(), ['content.sections[0].fields[0].meta.FUNCTION', 'content.sections[0].fields[0].meta.deep[0].Eval']);
  const v = good(); v.content.note = 'the word eval as a value is fine';
  assert.deepEqual(codes(v), []);
});

test('42a3: content nested too deeply is refused without a crash', () => {
  const p = good(); let n = p.content; for (let i = 0; i < 200; i++) { n.a = {}; n = n.a; }
  assert.doesNotThrow(() => lint(p));
  assert.ok(codes(p).some((c) => c === 'too_deep' || c === 'content_not_json'));
});

test('42a3: a view block that fails validateView is refused', () => {
  const p = good(); p.content.view = { type: 'nope', timeField: 'missing' };
  const r = lint(p).errors.filter((e) => e.code === 'bad_view');
  assert.ok(r.length >= 2);
  assert.ok(r.every((e) => e.path === 'content.view'));
});

test('42a3: an EMR pathway surface that fails validatePathwayViews is refused', () => {
  const pw = () => ({ manifest: { id: 'pathway.emr.zz_board', version: '1.0.0', targetApp: 'emr', kind: 'pathway' },
    content: { setId: 'pathway.emr.zz_board', kind: 'pathway', contexts: ['emr'], members: [], rules: [], surface: { type: 'case_tab', id: 'zz', label: 'ZZ' }, sections: [{ type: 'narrative' }], access: { view: ['doctor'] } } });
  assert.deepEqual(codes(pw()), []);
  const bad = pw(); bad.content.surface.type = 'sidebar'; bad.content.rules = [{}];
  assert.deepEqual(codes(bad).filter((c) => c === 'bad_pathway_view'), ['bad_pathway_view', 'bad_pathway_view']);
  const mem = pw(); mem.content.members = ['zz.unknown'];
  assert.deepEqual(lintPackage(mem, { roles: ROLES, knownSetIds: ['zz.other'] }).errors.map((e) => e.code), ['bad_pathway_view']);
});

test('42a3: access block missing, with an unknown role, an unknown action, or no role list', () => {
  const none = good(); delete none.content.access;
  assert.deepEqual(codes(none), ['bad_access']);
  const role = good(); role.content.access.enter = ['doctor', 'wizard'];
  assert.deepEqual(codes(role), ['bad_access']);
  assert.match(lint(role).errors[0].message, /wizard/);
  const act = good(); act.content.access.delete = ['admin'];
  assert.deepEqual(codes(act), ['bad_access']);
  assert.deepEqual(lintPackage(good()).errors.map((e) => e.code), ['no_role_list']);
});

test('42a3: every finding has a code, a path and a message', () => {
  const p = good(); p.manifest.id = 'X'; p.content.sections[0].fields[0].type = 'q'; delete p.content.access;
  const r = lint(p).errors;
  assert.ok(r.length >= 3);
  r.forEach((e) => { assert.equal(typeof e.code, 'string'); assert.equal(typeof e.path, 'string'); assert.equal(typeof e.message, 'string'); });
});

/* 42a4: rules */
const rule = (o) => Object.assign({ ruleId: 'r1', fieldRef: 'zz.test_set/v', op: '>', threshold: 5, indicator: 'info', summary: 'x' }, o);
const REFS = () => [{ id: 'g1', citation: 'Made-up guideline, 2020' }];
const withRules = (rs) => { const p = good(); p.content.rules = rs; p.content.references = REFS(); return p; };   // 42a5: rules need a source

test('42a4: every allowed operator passes, with integer, decimal and negative thresholds', () => {
  for (const op of RULE_OPS) for (const th of [0, 5, -2.5, 1e3]) assert.deepEqual(codes(withRules([rule({ op, threshold: th })])), [], op + ' ' + th);
});

test('42a4: an operator that is not whitelisted is refused, with the path', () => {
  for (const op of ['=', '<>', 'contains', 'eval', '', undefined, null, 5, '>=;']) {
    const bad = rule({ op }); if (op === undefined) delete bad.op;   // an undefined value cannot be stored as JSON at all
    const r = lint(withRules([rule(), bad])).errors;
    assert.deepEqual(r.map((e) => [e.code, e.path]), [['bad_rule_op', 'content.rules[1].op']], String(op));
  }
});

test('42a4: a threshold that is not a finite number is refused', () => {
  for (const th of [undefined, null, '', '5', 'high', NaN, Infinity, -Infinity, true, [], {}]) {
    const p = withRules([rule({ threshold: th })]);
    if (th === undefined) delete p.content.rules[0].threshold;
    let r; try { r = lint(p).errors; } catch (e) { assert.fail(String(th)); }
    const want = Number.isNaN(th) || th === Infinity || th === -Infinity ? ['content_not_json'] : ['bad_rule_threshold'];
    assert.deepEqual(r.map((e) => e.code), want, String(th));
  }
});

test('42a4: rules that are not a list, or entries that are not objects, are refused; no rules is fine', () => {
  assert.deepEqual(codes(withRules('x')), ['bad_rules']);
  assert.deepEqual(codes(withRules([5, null])), ['bad_rules', 'bad_rules']);
  assert.deepEqual(codes(withRules([])), []);
});

test('42a4: RULE_OPS equals OPS in cds-rules.js (when that file is next to this one)', () => {
  const fs = require('node:fs'), path = require('node:path');
  const f = path.join(__dirname, 'cds-rules.js');
  if (!fs.existsSync(f)) return;
  const m = fs.readFileSync(f, 'utf8').match(/const OPS=(\[[^\]]*\])/);
  assert.ok(m, 'could not find OPS in cds-rules.js');
  assert.deepEqual(RULE_OPS, JSON.parse(m[1].replace(/'/g, '"')));
});

/* 42a5: references */
const ex = (p) => lint(p).errors;

test('42a5: rules without a references entry are refused, with a source they pass', () => {
  const p = good(); p.content.rules = [rule()];
  const r = ex(p);
  assert.deepEqual(r.map((e) => [e.code, e.path]), [['missing_references', 'content.references']]);
  assert.match(r[0].message, /content\.rules/);
  p.content.references = REFS();
  assert.deepEqual(codes(p), []);
  const empty = good(); empty.content.rules = []; assert.deepEqual(codes(empty), []);   // an empty list needs no source
});

test('42a5: bands (a key named bands with content) need a source', () => {
  const p = good(); p.content.protocol = { bands: [{ from: 1, to: 2 }] };
  assert.deepEqual(codes(p), ['missing_references']);
  p.content.references = REFS(); assert.deepEqual(codes(p), []);
  const none = good(); none.content.protocol = { bands: [] }; assert.deepEqual(codes(none), []);
});

test('42a5: dose-like text needs a source; plain units and ordinary words do not', () => {
  for (const s of ['Give 5 mg every 6 h', '0.5mg', '10 units', '2,5 ml', '250 mcg', 'x 1 g']) {
    const p = good(); p.content.sections[0].fields[0].rationale = s;
    assert.deepEqual(codes(p), ['missing_references'], s);
  }
  for (const s of ['mL', 'Volume in mg', 'the dose is typed by the clinician', 'Room 5 gate', 'G6PD', 'ab5mg', '12 mgs']) {
    const p = good(); p.content.sections[0].fields[0].rationale = s;
    assert.deepEqual(codes(p), [], s);
  }
  assert.ok(DOSE_LIKE instanceof RegExp);
});

test('42a5: the finding names where the text was, and lists at most 5 places', () => {
  const p = good(); p.content.sections[0].fields = Array.from({ length: 9 }, (_, i) => ({ id: 'f' + i, type: 'text', rationale: i + ' mg' }));
  const m = ex(p)[0].message;
  assert.match(m, /fields\[0\]\.rationale/);
  assert.equal((m.match(/looks like a dose/g) || []).length, 5);
});

test('42a5: a bad references list is refused, and a good one is not needed when nothing needs it', () => {
  for (const bad of ['x', [5], [{ id: 'a' }], [{ citation: 'c' }], [{ id: ' ', citation: 'c' }], [{ id: 'a', citation: '' }], [{ id: 'a', citation: 'c' }, { id: 'a', citation: 'd' }]]) {
    const p = good(); p.content.references = bad;
    assert.ok(codes(p).includes('bad_reference'), JSON.stringify(bad));
  }
  const fine = good(); fine.content.references = REFS(); assert.deepEqual(codes(fine), []);
  const emptyRefs = good(); emptyRefs.content.rules = [rule()]; emptyRefs.content.references = [];
  assert.deepEqual(codes(emptyRefs), ['missing_references']);
});

test('42a5: text inside the references list itself does not trigger the check', () => {
  const p = good(); p.content.references = [{ id: 'g1', citation: 'Dosing table, 5 mg per kg, 2020' }];
  assert.deepEqual(codes(p), []);
});

/* 42a6: patient-like strings */
const withText = (s) => { const p = good(); p.content.sections[0].fields[0].rationale = s; return p; };

test('42a6: phone numbers, long digit runs, e-mail, MRN and "patient name" are refused, with the path and no copy of the text', () => {
  const cases = { '+977 9812345678': 'long_digits', '+44 20 7946 0958': 'phone', '(415) 555-0100': 'phone', '415-555-0100': 'phone', '415.555.0100': 'phone',
    '1234567': 'long_digits', 'call 98123456789 now': 'long_digits', 'ram@example.org': 'email', 'MRN 12': 'mrn', 'mrn: ab': 'mrn', 'Medical record number': 'mrn',
    'Patient name': 'patient_name', 'patient_name': 'patient_name', "patient's name": 'patient_name' };
  for (const [s, kind] of Object.entries(cases)) {
    const r = ex(withText(s));
    assert.equal(r.length, 1, s);
    assert.equal(r[0].code, 'patient_like', s);
    assert.equal(r[0].path, 'content.sections[0].fields[0].rationale', s);
    assert.ok(r[0].message.includes(kind), s + ' -> ' + r[0].message);
    if (s !== kind) assert.equal(r[0].message.includes(s), false, 'the finding must not copy the text: ' + s);   // (the string "patient_name" is also the kind's own name)
  }
});

test('42a6: ordinary numbers, dates, versions and words are not flagged', () => {
  for (const s of ['123456', '2026-11-21', '2026-11-21T10:30:00Z', 'version 1.2.3', 'Range 10 to 20', '12-34', 'mrnx', 'Patients', 'at 98.6', 'room 12, bed 4', '10 15 2020']) assert.deepEqual(codes(withText(s)), [], s);
});

test('42a6: the manifest is scanned too, and several strings give several findings', () => {
  const p = withText('ram@example.org'); p.manifest.title = 'Call 9812345678';
  assert.deepEqual(ex(p).map((e) => e.path).sort(), ['content.sections[0].fields[0].rationale', 'manifest.title']);
});

test('42a6: a citation may hold a long number, but not an e-mail, an MRN or a patient name', () => {
  const p = good(); p.content.references = [{ id: 'a', citation: 'Smith J. Journal 2020. doi:10.1000/182 PMID 12345678' }];
  assert.deepEqual(codes(p), []);
  p.content.references = [{ id: 'a', citation: 'MRN of the first case' }, { id: 'b', citation: 'write to ram@example.org' }];
  assert.deepEqual(ex(p).map((e) => e.path), ['content.references[0].citation', 'content.references[1].citation']);
});

test('42a6: findings are capped at 50 and the check never throws', () => {
  const p = good(); p.content.sections[0].fields = Array.from({ length: 80 }, (_, i) => ({ id: 'f' + i, type: 'text', rationale: 'ram' + i + '@example.org' }));
  assert.equal(ex(p).filter((e) => e.code === 'patient_like').length, 50);
});

/* 42a7: warnings */
const warns = (p, opts) => lintPackage(p, Object.assign({ roles: ROLES }, opts)).warnings;
const VER = ['zz-sys|100', { system: 'zz-sys', code: '200' }];

test('42a7: a verified code gives no warning; an unverified one does, with the path; neither is an error', () => {
  const p = good(); p.content.sections[0].fields[1].coding = { system: 'zz-sys', code: '100' };
  assert.deepEqual(warns(p, { verifiedCodes: VER }), []);
  p.content.sections[0].fields[1].coding = { system: 'zz-sys', code: '999' };
  const w = warns(p, { verifiedCodes: new Set(['zz-sys|100']) });
  assert.deepEqual(w.map((x) => [x.code, x.path]), [['unverified_coding', 'content.sections[0].fields[1].coding']]);
  assert.deepEqual(lintPackage(p, { roles: ROLES, verifiedCodes: VER }).errors, []);
  const q = good(); q.content.sections[0].fields[1].fhir = { resource: 'Observation', code: { system: 'zz-sys', code: '555' } };
  assert.deepEqual(warns(q, { verifiedCodes: VER }).map((x) => x.path), ['content.sections[0].fields[1].fhir.code']);
});

test('42a7: a code with no verified list given says so once instead of guessing', () => {
  const p = good(); p.content.sections[0].fields[0].coding = { system: 'a', code: '1' }; p.content.sections[0].fields[1].coding = { system: 'a', code: '2' };
  assert.deepEqual(warns(p).map((x) => x.code), ['no_verified_list']);
  assert.deepEqual(warns(good()), []);   // no codes, so nothing to say
});

test('42a7: a field with no code, or a choice block (coding.allow), is not an unverified code', () => {
  const p = good(); p.content.sections[0].fields[2].coding = { allow: ['none'] };
  assert.deepEqual(warns(p, { verifiedCodes: [] }), []);
});

test('42a7: an empty rationale warns; a missing one or a real one does not', () => {
  for (const r of ['', '   ', null, 5]) { const p = good(); p.content.sections[0].fields[1].rationale = r; assert.deepEqual(warns(p).map((x) => [x.code, x.path]), [['empty_rationale', 'content.sections[0].fields[1].rationale']], String(r)); }
  const ok = good(); ok.content.sections[0].fields[1].rationale = 'Why this is recorded.'; assert.deepEqual(warns(ok), []);
  assert.deepEqual(warns(good()), []);
});

test('42a7: a repeated field id warns once for each repeat, across sections and in a top-level fields list', () => {
  const p = good(); p.content.sections.push({ id: 's2', fields: [{ id: 'v', type: 'number' }] }); p.content.fields = [{ id: 't', type: 'text' }];
  const w = warns(p).filter((x) => x.code === 'duplicate_field_id');
  assert.deepEqual(w.map((x) => x.path), ['content.sections[1].fields[0].id', 'content.fields[0].id']);
  assert.match(w[0].message, /sections\[0\]\.fields\[1\]/);
});

test('42a7: warnings never turn into errors and each has a code, a path and a message', () => {
  const p = good(); p.content.sections[0].fields[1].rationale = ''; p.content.sections[0].fields[2].id = 'v';
  const r = lintPackage(p, { roles: ROLES });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 2);
  r.warnings.forEach((w) => { assert.equal(typeof w.code, 'string'); assert.equal(typeof w.path, 'string'); assert.equal(typeof w.message, 'string'); });
});

/* 42a3b: targetApp, kind and definition checks. Made-up data only. */
const asAnalytic = () => { const p = good(); p.manifest.targetApp = 'analytics'; p.manifest.kind = 'analytic'; p.content = { slots: [{ id: 's1' }], analyticKind: 'count', params: {}, access: { view: ['doctor'] }, rules: [] }; return p; };

test('42a3b: targetApp must be "emr" or "analytics"', () => {
  for (const v of [undefined, '', 'EMR', 'both', 1]) { const p = good(); p.manifest.targetApp = v; assert.deepEqual(lint(p).errors.map((e) => [e.code, e.path]), [['bad_target_app', 'manifest.targetApp']], String(v)); }
});

test('42a3b: kind must match the target app (also when kind is missing)', () => {
  const a = good(); a.manifest.kind = 'analytic';
  const b = asAnalytic(); b.manifest.kind = 'set';
  const c = good(); delete c.manifest.kind;
  for (const p of [a, b, c]) assert.deepEqual(lint(p).errors.map((e) => [e.code, e.path]), [['kind_target_mismatch', 'manifest.kind']]);
});

test('42a3b: a set and a pathway for the EMR, and a definition for analytics, pass', () => {
  assert.deepEqual(lint(good()), { errors: [], warnings: [] });
  assert.deepEqual(lint(asAnalytic()).errors, []);
});

test('42a3b: a definition with a threshold, expression, query or list is refused, with the path', () => {
  const cases = [['threshold', 5, 'content.params.threshold'], ['expression', 'a > b', 'content.params.expression'], ['lists', ['x'], 'content.params.lists'], ['query', 'q', 'content.slots[0].query']];
  for (const [k, v, path] of cases) {
    const p = asAnalytic();
    if (k === 'query') p.content.slots[0].query = v; else p.content.params[k] = v;
    assert.deepEqual(lint(p).errors.map((e) => [e.code, e.path]), [['forbidden_in_definition', path]], k);
  }
  const r = asAnalytic(); r.content.rules = [{ op: '<', threshold: 1 }];
  assert.ok(codes(r).includes('forbidden_in_definition'));
});

test('42a3b: the same words are fine in an EMR set, and a good definition says its validator is pending', () => {
  const p = good(); p.content.params = { query: 'free text' };
  assert.deepEqual(codes(p), []);
  assert.deepEqual(lint(asAnalytic()).warnings.map((w) => w.code), ['analytic_validator_pending']);
});

/* 42b1: registry defaults. Made-up entries only. */
const { registryDefaults, REGISTRY_FIELDS } = require('./package-lint.js');

test('42b1: an old seed entry gets source seed, read-only, tier local-draft and empty links', () => {
  assert.deepEqual(registryDefaults({ setId: 'zz.a', version: 1 }, true), { setId: 'zz.a', version: 1, source: 'seed', readOnly: true, tier: 'local-draft', forkedFrom: null, package: null });
});

test('42b1: an old user entry gets source local, editable, tier local-draft', () => {
  const r = registryDefaults({ setId: 'zz.b' }, false);
  assert.deepEqual([r.source, r.readOnly, r.tier, r.forkedFrom, r.package], ['local', false, 'local-draft', null, null]);
});

test('42b1: values already on the entry are kept, including null, and only the missing ones are filled', () => {
  const e = { setId: 'zz.c', source: 'marketplace', readOnly: true, tier: 'marketplace-verified', forkedFrom: null, package: { id: 'x.y', version: '1.0.0', contentHash: 'h' } };
  assert.equal(registryDefaults(e, false), e);   // complete entry: same object back, no copy
  const p = registryDefaults({ setId: 'zz.d', tier: 'local-reviewed' }, false);
  assert.equal(p.tier, 'local-reviewed');
  assert.equal(p.source, 'local');
});

test('42b1: the entry passed in is not changed, and a non-object comes back as it is', () => {
  const e = { setId: 'zz.e' }; registryDefaults(e, true);
  assert.deepEqual(e, { setId: 'zz.e' });
  for (const v of [null, undefined, 'x', 5]) assert.equal(registryDefaults(v, true), v);
  assert.deepEqual(REGISTRY_FIELDS, ['source', 'readOnly', 'tier', 'forkedFrom', 'package']);
});

/* 42b2: tier badge. */
const { tierBadge } = require('./package-lint.js');

test('42b2: each tier has its own key, label and plain-language title', () => {
  const r = ['marketplace-verified', 'local-reviewed', 'local-draft'].map((t) => tierBadge({ tier: t }));
  assert.deepEqual(r.map((x) => x.key), ['marketplace-verified', 'local-reviewed', 'local-draft']);
  assert.deepEqual(r.map((x) => x.label), ['Marketplace-verified', 'Local-reviewed', 'Local draft']);
  r.forEach((x) => assert.ok(x.title.length > 5));
  assert.match(r[0].title, /not regulatory approval/i);
});

test('42b2: a missing, unknown or odd tier is shown as a local draft, never as verified', () => {
  for (const e of [{}, { tier: 'verified' }, { tier: 'Marketplace-verified' }, { tier: 5 }, { tier: '__proto__' }, { tier: 'toString' }, null, undefined, 'x']) assert.equal(tierBadge(e).key, 'local-draft', JSON.stringify(e));
});

test('42b2: read-only or source alone never changes the badge', () => {
  assert.equal(tierBadge({ readOnly: true, source: 'marketplace' }).key, 'local-draft');
});

/* 42b7: fork to a local copy. Made-up entries only. */
const { forkEntry, contentHashOf } = require('./package-lint.js');
const orig = () => ({ setId: 'pkg.zz_form', kind: 'care', version: 3, title: 'ZZ Form', source: 'marketplace', readOnly: true, tier: 'marketplace-verified',
  package: { id: 'pkg.zz_form', version: '1.0.0', contentHash: 'abc' }, forkedFrom: null, sections: [{ id: 's1', fields: [{ id: 'a', type: 'text' }] }], rules: [{ id: 'r1', op: '>', threshold: 1, enabled: true }] });

test('42b7: a fork is a new local draft with version 1, an unused id and a forkedFrom record', () => {
  const f = forkEntry(orig(), ['pkg.zz_form'], 'h1');
  assert.equal(f.setId, 'local.zz_form'); assert.equal(f.version, 1); assert.equal(f.title, 'ZZ Form (local copy)');
  assert.deepEqual([f.source, f.readOnly, f.tier, f.package], ['local', false, 'local-draft', null]);
  assert.deepEqual(f.forkedFrom, { setId: 'pkg.zz_form', version: 3, contentHash: 'h1' });
});

test('42b7: the original is never changed, and the copy shares no objects with it', () => {
  const o = orig(), snap = JSON.stringify(o);
  const f = forkEntry(o, [], 'h');
  f.sections[0].fields[0].type = 'number'; f.rules[0].threshold = 99;
  assert.equal(JSON.stringify(o), snap);
});

test('42b7: the id is made unique, and copied rules arrive disabled', () => {
  assert.equal(forkEntry(orig(), ['local.zz_form'], 'h').setId, 'local.zz_form_2');
  assert.equal(forkEntry(orig(), ['local.zz_form', 'local.zz_form_2'], 'h').setId, 'local.zz_form_3');
  assert.equal(forkEntry(orig(), [], 'h').rules[0].enabled, false);
  assert.equal(forkEntry({ setId: 'a.b', title: '123 !!' }, [], 'h').setId, 'local.s_123');
  assert.equal(forkEntry({ setId: 'a.b', title: '!!!' }, [], 'h').setId, 'local.copy');
});

test('42b7: a fork needs a setId and a hash', () => {
  assert.throws(() => forkEntry({}, [], 'h'), TypeError);
  assert.throws(() => forkEntry(orig(), [], ''), TypeError);
});

test('42b7: contentHashOf keeps a package hash, else hashes the entry without registry fields', async () => {
  assert.equal(await contentHashOf(orig()), 'abc');
  const a = { setId: 'x.y', version: 1, title: 'T' }, b = Object.assign({ tier: 'local-reviewed', source: 'local', readOnly: false, forkedFrom: null, package: null }, { title: 'T', version: 1, setId: 'x.y' });
  const h = await contentHashOf(a);
  assert.match(h, /^[0-9a-f]{64}$/); assert.equal(h, await contentHashOf(b));
  assert.notEqual(h, await contentHashOf({ setId: 'x.y', version: 1, title: 'U' }));
});

/* 42c2: prepareInstall. Made-up packages only. */
const { prepareInstall } = require('./package-lint.js');
const hashed = async (p) => { p.manifest.contentHash = await sha256Hex(canonicalJson(p.content)); return p; };
const prep = (p, ids) => prepareInstall(p, { roles: ROLES, existingIds: ids || [] });

test('42c2: a good package with the right hash gives a read-only marketplace-verified entry', async () => {
  const p = await hashed(good()); const snap = JSON.stringify(p);
  const r = await prep(p);
  assert.equal(r.ok, true); assert.deepEqual(r.problems, []);
  assert.deepEqual([r.entry.source, r.entry.readOnly, r.entry.tier, r.entry.forkedFrom], ['marketplace', true, 'marketplace-verified', null]);
  assert.deepEqual(r.entry.package, { id: 'care.intake_output', version: '1.0.0', contentHash: p.manifest.contentHash });
  assert.equal(r.entry.setId, 'zz.test_set'); assert.equal(r.hash, p.manifest.contentHash);
  assert.equal(JSON.stringify(p), snap);   // the package passed in is not changed
});

test('42c2: the content cannot declare its own tier, source or package', async () => {
  const p = good(); Object.assign(p.content, { tier: 'marketplace-verified', source: 'seed', readOnly: false, package: { id: 'fake' }, forkedFrom: { setId: 'x' } });
  const r = await prep(await hashed(p));
  assert.equal(r.ok, true);
  assert.deepEqual([r.entry.source, r.entry.readOnly, r.entry.forkedFrom, r.entry.package.id], ['marketplace', true, null, 'care.intake_output']);
});

test('42c2: rules arrive disabled', async () => {
  const p = good(); p.content.rules = [{ id: 'r1', op: '>', threshold: 5, enabled: true }]; p.content.references = [{ id: 'ref1', citation: 'A source' }];
  const r = await prep(await hashed(p));
  assert.equal(r.ok, true); assert.equal(r.entry.rules[0].enabled, false);
});

test('42c2: a changed byte, a missing hash or a wrong hash installs nothing', async () => {
  const p = await hashed(good()); p.content.sections[0].fields[1].unit = 'mg';
  let r = await prep(p); assert.equal(r.ok, false); assert.deepEqual(r.problems.map((x) => x.code), ['hash_mismatch']);
  const q = good(); r = await prep(q); assert.deepEqual(r.problems.map((x) => x.code), ['no_hash']);
  const w = good(); w.manifest.contentHash = 'abc'; r = await prep(w); assert.deepEqual(r.problems.map((x) => x.code), ['hash_mismatch']);
});

test('42c2: lint errors, another target app, a bad set id and an id already here are each refused', async () => {
  const bad = await hashed(good()); bad.manifest.version = '1'; bad.manifest.contentHash = await sha256Hex(canonicalJson(bad.content));
  assert.ok((await prep(bad)).problems.some((x) => x.code === 'lint_errors'));
  const an = good(); an.manifest.targetApp = 'analytics'; an.manifest.kind = 'analytic'; an.content = { slots: [], analyticKind: 'count', params: {}, access: { view: ['doctor'] }, rules: [] };
  assert.ok((await prep(await hashed(an))).problems.some((x) => x.code === 'wrong_target_app'));
  const bs = good(); bs.content.setId = 'has space';
  assert.ok((await prep(await hashed(bs))).problems.some((x) => x.code === 'bad_set_id'));
  const dup = await hashed(good());
  assert.deepEqual((await prep(dup, ['zz.test_set'])).problems.map((x) => x.code), ['already_in_registry']);
  assert.equal((await prepareInstall(null)).ok, false);
});

test('42c2: a long hash in the manifest is not mistaken for patient data, but other manifest text still is', () => {
  const p = good(); p.manifest.contentHash = '1234567890'.repeat(6) + '1234';
  assert.deepEqual(codes(p), []);
  p.manifest.note = 'call 0123456789'; assert.deepEqual(codes(p), ['patient_like']);
});
