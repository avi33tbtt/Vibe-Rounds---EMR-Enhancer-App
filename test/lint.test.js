'use strict';
// Chunk 08a: the shared element-set lint. Every rule has failing and passing tests; a bad example triggers exactly its own rule.
// Pure module: no database needed (the seed-set test loads the page in jsdom, like safety-content.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { lint, RULES } = require('../lint');
const { buildKnown } = require('../deid');

const VERIFIED = { bindingState: () => 'verified' };
const clean = () => ({
  id: 'vitals_demo', kind: 'care', title: 'Demo vitals', desc: 'Core signs',
  fields: [
    { id: 'hr', label: 'Heart rate', type: 'integer', unit: '/min', repeat: true, bindings: [{ system: 'loinc', code: '8867-4', display: 'Heart rate' }] },
    { id: 'note', label: 'Notes', type: 'text' },
    { id: 'wbct', label: '20-min WBCT', type: 'select', options: ['Clotted', 'Unclotted', 'Not done'] },
  ],
});
const mut = fn => { const s = clean(); fn(s); return s; };
const rulesOf = r => [...new Set(r.findings.map(f => f.rule))].sort();
const only = (r, rule) => assert.deepEqual(rulesOf(r), [rule], JSON.stringify(r.findings));
const none = r => assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
const withLabel = text => mut(s => { s.fields[1].label = text; });

test('a clean set passes: no findings, ok, no second reviewer', () => {
  const r = lint(clean(), VERIFIED);
  none(r);
  assert.equal(r.ok, true);
  assert.equal(r.needsTwoReviewers, false);
  assert.deepEqual([...RULES].sort(), ['dose-no-citation', 'executable', 'patient-like', 'schema', 'unverified-code']);
});

test('findings carry severity, path, rule and message', () => {
  const r = lint(mut(s => { delete s.title; }), VERIFIED);
  assert.equal(r.ok, false);
  const f = r.findings[0];
  assert.deepEqual(Object.keys(f).sort(), ['message', 'path', 'rule', 'severity']);
  assert.equal(f.severity, 'error'); assert.equal(f.path, 'title'); assert.equal(f.rule, 'schema');
});

/* ---- rule 1: schema ---- */
test('schema: each malformed set triggers the schema rule and only that rule', () => {
  const bad = {
    'not an object': null,
    'missing id': mut(s => { delete s.id; }),
    'blank title': mut(s => { s.title = '  '; }),
    'unknown kind': mut(s => { s.kind = 'banana'; }),
    'desc not text': mut(s => { s.desc = 5; }),
    'no fields': mut(s => { s.fields = []; }),
    'field without label': mut(s => { delete s.fields[1].label; }),
    'field without id': mut(s => { delete s.fields[1].id; }),
    'unknown field type': mut(s => { s.fields[1].type = 'blob'; }),
    'select without options': mut(s => { delete s.fields[2].options; }),
    'select with an empty option': mut(s => { s.fields[2].options = ['Yes', '']; }),
    'options on a text field': mut(s => { s.fields[1].options = ['a']; }),
    'duplicate field ids': mut(s => { s.fields[1].id = 'hr'; }),
    'repeat not boolean': mut(s => { s.fields[0].repeat = 'yes'; }),
    'bindings not a list': mut(s => { s.fields[0].bindings = {}; }),
    'binding without code': mut(s => { s.fields[0].bindings = [{ system: 'loinc' }]; }),
    'binding without system': mut(s => { s.fields[0].bindings = [{ code: '1' }]; }),
    'bad coding policy mode': mut(s => { s.fields[1].codingPolicy = { mode: 'maybe' }; }),
    'custom policy without systems': mut(s => { s.fields[1].codingPolicy = { mode: 'custom' }; }),
    'empty citation': mut(s => { s.citation = ''; }),
    'citation too long': mut(s => { s.fields[0].citation = 'x'.repeat(501); }),
    'pathway without members': { id: 'pw', kind: 'pathway', title: 'P', members: [] },
  };
  for (const [name, set] of Object.entries(bad)) {
    const r = lint(set, VERIFIED);
    assert.equal(r.ok, false, name);
    assert.deepEqual(rulesOf(r), ['schema'], `${name}: ${JSON.stringify(r.findings)}`);
  }
});

test('schema: an unknown code system is refused only when the system list is passed in', () => {
  const s = mut(x => { x.fields[0].bindings[0].system = 'madeup'; });
  none(lint(s, VERIFIED));
  only(lint(s, { ...VERIFIED, systems: ['loinc', 'snomed'] }), 'schema');
  none(lint(clean(), { ...VERIFIED, systems: ['loinc', 'snomed'] }));
});

test('schema: well-formed variants pass (pathway, citation, skip and custom policy, repeat, required)', () => {
  none(lint({ id: 'pw', kind: 'pathway', title: 'Pathway', members: ['basic_emr', 'vitals'] }, VERIFIED));
  none(lint(mut(s => { s.citation = 'Local guideline 2024, section 3'; s.fields[1].codingPolicy = { mode: 'skip' }; s.fields[2].required = true; }), VERIFIED));
  none(lint(mut(s => { s.fields[1].codingPolicy = { mode: 'custom', systems: ['loinc'] }; }), VERIFIED));
});

/* ---- rule 2: every bound code is verified (state passed in) ---- */
test('unverified-code: fails when the state is not "verified", passes when it is', () => {
  const s = clean();
  only(lint(s, { bindingState: () => 'unverified' }), 'unverified-code');
  only(lint(s, { bindingState: () => 'mismatch' }), 'unverified-code');
  none(lint(s, VERIFIED));
});

test('unverified-code: the state is asked per binding, so one bad code among good ones is found at its path', () => {
  const s = mut(x => { x.fields[0].bindings.push({ system: 'snomed', code: '364075005', display: 'Heart rate' }); });
  const r = lint(s, { bindingState: b => (b.system === 'snomed' ? 'unverified' : 'verified') });
  only(r, 'unverified-code');
  assert.deepEqual(r.findings.map(f => f.path), ['fields[0].bindings[1]']);
});

test('unverified-code: unknown never passes (no state supplied, or the state function throws)', () => {
  only(lint(clean(), {}), 'unverified-code');
  only(lint(clean(), { bindingState: () => { throw new Error('boom'); } }), 'unverified-code');
});

test('unverified-code: an old-format coding is also a bound code', () => {
  const s = mut(x => { delete x.fields[0].bindings; x.fields[0].coding = { system: 'loinc', code: '8867-4' }; });
  only(lint(s, { bindingState: () => 'unverified' }), 'unverified-code');
  none(lint(s, VERIFIED));
});

test('unverified-code: coding is optional everywhere (no binding, or a deliberate skip, is clean even with no state)', () => {
  none(lint(mut(x => { delete x.fields[0].bindings; }), {}));
  none(lint(mut(x => { delete x.fields[0].bindings; x.fields[0].codingPolicy = { mode: 'skip' }; }), {}));
});

test('unverified-code: lint never reaches a server (it only calls what it is handed)', () => {
  let asked = 0;
  lint(clean(), { bindingState: () => { asked++; return 'verified'; } });
  assert.equal(asked, 1);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lint.js'), 'utf8');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|require\(['"](?:http|https|net|pg)['"]\)/.test(src), 'lint.js must not use the network or the database');
});

/* ---- rule 3: dose or threshold-like text without a citation ---- */
const DOSEY = ['Give 5 mg', 'Dose 0.5 mcg', 'Keep above 3 mmol', 'HR over 120 bpm', 'SpO2 below 94%', 'Hb < 7', 'Glucose ≥ 250',
  'Rate 20 /min', 'Insulin 4 units', 'Fluid 500 ml', 'Pressure 90 mmHg', 'Give 2 g', 'Target >= 8'];

test('dose-no-citation: dose or threshold-like text fails without a citation, and asks for two reviewers', () => {
  for (const text of DOSEY) {
    const r = lint(withLabel(text), VERIFIED);
    only(r, 'dose-no-citation');
    assert.equal(r.needsTwoReviewers, true, text);
    assert.equal(r.findings[0].path, 'fields[1].label', text);
  }
});

test('dose-no-citation: a citation on the field or on the set clears the finding but not the second reviewer', () => {
  for (const text of DOSEY) {
    const onField = withLabel(text); onField.fields[1].citation = 'Guideline X 2023, table 2';
    const onSet = withLabel(text); onSet.citation = 'Guideline X 2023';
    for (const s of [onField, onSet]) { const r = lint(s, VERIFIED); none(r); assert.equal(r.needsTwoReviewers, true, text); }
  }
});

test('dose-no-citation: a citation on a different field does not cover this one', () => {
  const s = withLabel('Give 5 mg'); s.fields[0].citation = 'Guideline X';
  only(lint(s, VERIFIED), 'dose-no-citation');
});

test('dose-no-citation: the title, description, rationale and select options are read too', () => {
  const title = clean(); title.title = 'Target > 7';
  const desc = clean(); desc.desc = 'Give 10 units';
  const rat = clean(); rat.fields[1].rationale = 'Keep under 5 mmol';
  const opt = mut(s => { s.fields[2].options = ['Give 2 g', 'No']; });
  for (const [s, p] of [[title, 'title'], [desc, 'desc'], [rat, 'fields[1].rationale'], [opt, 'fields[2].options[0]']]) {
    const r = lint(s, VERIFIED); only(r, 'dose-no-citation'); assert.equal(r.findings[0].path, p);
  }
});

test('dose-no-citation: ordinary clinical wording is not flagged', () => {
  for (const text of ['20-min WBCT', 'Time of bite', 'Bite to ASV (min)', 'Heart rate (/min)', 'Grade 2 swelling', 'Day 3 review', 'Initial ASV vials']) {
    const r = lint(withLabel(text), VERIFIED); none(r); assert.equal(r.needsTwoReviewers, false, text);
  }
});

test('needsTwoReviewers: rules or bands in the set, even with no dose text, ask for a second reviewer', () => {
  assert.equal(lint(clean(), VERIFIED).needsTwoReviewers, false);
  const bands = mut(s => { s.fields[0].bands = [{ low: 60, high: 100 }]; });
  const rules = mut(s => { s.rules = [{ id: 'r1' }]; });
  for (const s of [bands, rules]) { const r = lint(s, VERIFIED); none(r); assert.equal(r.needsTwoReviewers, true); }
  assert.equal(lint({ id: 'pw', kind: 'pathway', title: 'P', members: ['a'] }, VERIFIED).needsTwoReviewers, false);
});

/* ---- rule 4: executable content ---- */
test('executable: script, javascript:, event handlers and markup fail, wherever they are in the set', () => {
  const bad = ['<script>alert(1)</script>', '< script >x', 'see javascript:alert(1)', 'VBScript:msgbox', 'x" onfocus=alert(1) y',
    '<img src=x onerror=alert(1)>', '<b>bold</b>', 'data:text/html;base64,AAAA', '"><svg/onload=alert(1)>'];
  for (const text of bad) {
    only(lint(withLabel(text), VERIFIED), 'executable');
    only(lint(mut(s => { s.desc = text; }), VERIFIED), 'executable');
    only(lint(mut(s => { s.fields[2].options = [text, 'No']; }), VERIFIED), 'executable');
  }
});

test('executable: found in nested data too (history, sdc), reported at that path, one finding per string', () => {
  const s = mut(x => { x.sdc = { note: '<script>1</script>' }; x.history = [{ version: 1, title: 'javascript:alert(1)' }]; });
  const r = lint(s, VERIFIED);
  only(r, 'executable');
  assert.deepEqual(r.findings.map(f => f.path).sort(), ['history[0].title', 'sdc.note']);
  const one = lint(withLabel('<script>alert(1)</script> and <img onerror=x>'), VERIFIED);
  assert.equal(one.findings.length, 1);
});

test('executable: plain text that only looks similar passes', () => {
  for (const text of ['Onset = bite time', 'Condition = see plan', 'Hb is lower than usual', 'Time of onset', 'Script notes (typed)', 'Day 3 vs day 5']) none(lint(withLabel(text), VERIFIED));
});

/* ---- rule 5: patient-like strings (deid.js patterns) ---- */
test('patient-like: names, phones, emails, dates and ids fail', () => {
  const bad = ['Patient Ramesh Kumar', 'Mrs Sharma', 'Call 9876543210', 'mail a.b@example.com', 'Seen on 12/03/2024', 'MRN: AB12345', '34-year-old man', 'Bed 12'];
  for (const text of bad) {
    const r = lint(withLabel(text), VERIFIED);
    only(r, 'patient-like');
    assert.equal(r.ok, false, text);
  }
});

test('patient-like: registered patients are matched exactly when their names are passed in', () => {
  const known = buildKnown([{ name: 'Zxqwv Plmokn', mrn: 'QX7788' }]);
  const s = withLabel('Review for Zxqwv Plmokn');
  none(lint(s, VERIFIED));                                     // not known: a made-up word is not patient-like by pattern
  only(lint(s, { ...VERIFIED, known }), 'patient-like');       // known: caught exactly
  only(lint(withLabel('Ref QX7788 here'), { ...VERIFIED, known }), 'patient-like');
});

test('patient-like: a citation is not scanned (it may be a URL), but the same text in a label is', () => {
  const s = withLabel('Give 5 mg'); s.fields[1].citation = 'https://example.org/guideline 2019';
  none(lint(s, VERIFIED));
  const label = withLabel('see https://example.org/guideline');
  only(lint(label, VERIFIED), 'patient-like');
});

test('patient-like: ordinary wording passes', () => {
  for (const text of ['Chief complaint', 'History of present illness', 'Heart rate', 'Past medical history', 'Examination findings']) none(lint(withLabel(text), VERIFIED));
});

test('patient-like: the app can supply its own scrub, and can switch the check off with a visible warning', () => {
  let n = 0;
  none(lint(clean(), { ...VERIFIED, scrub: () => { n++; return { counts: {} }; } }));
  assert.ok(n > 0);
  only(lint(withLabel('x'), { ...VERIFIED, scrub: () => ({ counts: { name: 1 } }) }), 'patient-like');
  const off = lint(clean(), { ...VERIFIED, scrub: false });
  assert.equal(off.ok, true);                                   // a warning, not an error: the server checks again
  assert.deepEqual(off.findings.map(f => [f.severity, f.rule]), [['warning', 'patient-like']]);
});

/* ---- the same file works in a browser (no require, no module) ---- */
test('lint.js loads as a plain browser script and reports the unchecked patient-like rule as a warning', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lint.js'), 'utf8');
  const ctx = { self: {} };
  vm.runInNewContext(src, ctx);
  const L = ctx.self.EmrLint;
  assert.equal(typeof L.lint, 'function');
  const r = L.lint(clean(), VERIFIED);
  assert.equal(r.ok, true);
  // (objects made inside the vm context have another Array prototype, so compare as JSON)
  assert.equal(JSON.stringify(r.findings.map(f => [f.severity, f.rule])), JSON.stringify([['warning', 'patient-like']]));
  assert.equal(L.lint(clean(), { ...VERIFIED, scrub: () => ({ counts: {} }) }).findings.length, 0);
  assert.equal(L.lint(withLabel('<script>1</script>'), VERIFIED).ok, false);
});

/* ---- real content: nothing the app ships may trip the lint (catches false positives) ---- */
test('the page\'s built-in sets, pathways and demo sets pass the lint (codes treated as verified)', () => {
  const HTML = require('./html').pageHtml();
  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.fetch = async () => new Response('{}', { status: 401 }); } });
  const sets = JSON.parse(dom.window.eval('JSON.stringify([...BUILTIN, DEMO_SNAKE, DEMO_DKA, ...PATHWAYS])'));
  assert.ok(sets.length >= 10, 'expected the seed sets to load');
  for (const s of sets) {
    const r = lint(s, VERIFIED);
    assert.deepEqual(r.findings, [], `${s.id}: ${JSON.stringify(r.findings)}`);
    assert.equal(r.needsTwoReviewers, false, s.id);
  }
});
