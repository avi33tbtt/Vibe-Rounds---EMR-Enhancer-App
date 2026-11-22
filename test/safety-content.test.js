'use strict';
// Chunk 05, checks 4 and 6:
//   4. seed content contains zero rules and zero bands (page library, pathways, demo sets, and what seed.js writes)
//   6. verified-only export: an unverified or mismatched code never appears as a FHIR Coding, in any output
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makePool } = require('../db');

const HTML = require('./html').pageHtml();
const ROOT = path.join(__dirname, '..');

function page({ store = {}, tx = {} } = {}) {
  const errors = [], calls = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
      w.fetch = async url => {
        url = String(url);
        if (url.startsWith('/api/')) return new Response('{}', { status: 401 });
        calls.push(url);
        if (tx.down) throw new TypeError('network down');
        const u = new URL(url);
        const d = (tx.codes || {})[u.searchParams.get('system') + '|' + u.searchParams.get('code')];
        if (!d) return new Response(JSON.stringify({ resourceType: 'OperationOutcome' }), { status: 404 });
        return new Response(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'display', valueString: d }] }), { status: 200 });
      };
    } });
  return { w: dom.window, d: dom.window.document, errors, calls, json: code => JSON.parse(dom.window.eval(`JSON.stringify(${code})`)) };
}

// ---------- 4. no rules, no bands in seed content ----------
// The page's "Suggest" keyword list is a search helper (words -> set ids), not a clinical rule; it is not seed content.
// Seed content may only use these keys. Thresholds, doses and bands need keys/numbers that are not here,
// so adding one fails this test and has to be a deliberate, reviewed change (rules arrive disabled; see core rules).
const ALLOWED_KEYS = new Set(['id', 'kind', 'title', 'desc', 'fields', 'members', 'label', 'type', 'unit', 'repeat', 'derived', 'options', 'bindings', 'system', 'code', 'display']);
const RULEISH = /rule|band|thresh|range|alert|dose|dosing|cutoff|critical|normal|trigger|limit|target|score|severity|warn|flag|min|max|lower|upper|bound|interval|formula|expression|condition|action/i;

function walk(node, where, visit) {
  if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${where}[${i}]`, visit));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { visit(k, v, `${where}.${k}`); walk(v, `${where}.${k}`, visit); }
  }
}

test('seed sets, pathways and demo sets carry zero rules and zero bands', () => {
  const p = page();
  assert.deepEqual(p.errors, []);
  const seeds = p.json('({builtin:BUILTIN,demos:[DEMO_SNAKE,DEMO_DKA],pathways:PATHWAYS,library:REGISTRY})');
  assert.ok(seeds.builtin.length >= 8 && seeds.demos.length === 2 && seeds.pathways.length >= 4, 'the seed content was really found');
  const bad = [];
  for (const [group, sets] of Object.entries(seeds)) {
    walk(sets, group, (k, v, where) => {
      if (RULEISH.test(k)) bad.push(`${where}: key name looks like a rule/band/threshold`);
      else if (!ALLOWED_KEYS.has(k) && !/^\d+$/.test(k)) bad.push(`${where}: key "${k}" is not allowed in seed content`);
      if (typeof v === 'number') bad.push(`${where}: a number (${v}) in seed content; thresholds and doses are numbers`);
    });
  }
  assert.deepEqual(bad, []);
  // the library the user sees on first load is exactly the built-in sets, with nothing else added
  assert.deepEqual(seeds.library.map(s => s.id).sort(), seeds.builtin.map(s => s.id).sort());
  // pathways only group existing sets
  const ids = new Set(seeds.library.map(s => s.id));
  for (const pw of seeds.pathways) for (const m of pw.members) assert.ok(ids.has(m), `${pw.id} member ${m} exists`);
});

test('the rule/band detector is not asleep: it flags a seed set that has a band', () => {
  const sample = { id: 'x', fields: [{ id: 'k', label: 'K', type: 'number', bands: [{ low: 3.5, high: 5.1 }] }] };
  const bad = [];
  walk(sample, 'sample', (k, v, where) => { if (RULEISH.test(k) || !ALLOWED_KEYS.has(k) && !/^\d+$/.test(k) || typeof v === 'number') bad.push(where); });
  assert.ok(bad.length >= 3);
});

test('seed.js creates users only: no patients, encounters, rules or content, AI stays off, passwords are hashed', async () => {
  const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const pool = makePool(URL);
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const run = () => execFileSync(process.execPath, ['seed.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: URL, SEED_PASSWORD: 'Seed-test-pw-1' }, encoding: 'utf8' });
    run(); run();    // twice: running it again must not duplicate or add anything
    const users = (await pool.query('SELECT username, role, password_hash, active FROM users ORDER BY username')).rows;
    assert.deepEqual(users.map(u => [u.username, u.role]), [['admin1', 'admin'], ['doctor1', 'doctor'], ['nurse1', 'nurse'], ['viewer1', 'viewer']]);
    for (const u of users) { assert.match(u.password_hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/); assert.ok(!u.password_hash.includes('Seed-test-pw-1')); }
    const tables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map(r => r.table_name);
    const filled = {};
    for (const t of tables) filled[t] = Number((await pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);
    const expected = { users: 4, schema_migrations: filled.schema_migrations, ai_settings: 1 };
    for (const t of tables) assert.equal(filled[t], expected[t] ?? 0, `seed left ${filled[t]} row(s) in ${t}`);
    assert.equal((await pool.query('SELECT enabled FROM ai_settings')).rows[0].enabled, false, 'AI is off after seeding');
    assert.ok(!tables.some(t => /rule|band|alert|threshold/i.test(t)), 'no rules/bands tables exist');
  } finally { await pool.end(); }
});

// ---------- 6. verified-only export ----------
const LOINC = 'http://loinc.org', SCT = 'http://snomed.info/sct';
const HL7_FIXED = 'http://terminology.hl7.org/';   // fixed FHIR status codes (e.g. Condition clinicalStatus), not bindings

// every {system, code} pair anywhere in an exported resource (a Coding is any object with both keys)
function codings(node, out = []) {
  if (Array.isArray(node)) node.forEach(x => codings(x, out));
  else if (node && typeof node === 'object') {
    if (typeof node.system === 'string' && 'code' in node) out.push(node);
    Object.values(node).forEach(v => codings(v, out));
  }
  return out.filter(c => !c.system.startsWith(HL7_FIXED));
}

const SERVER = {
  [LOINC + '|8867-4']: 'Heart rate',
  [LOINC + '|8480-6']: 'Systolic blood pressure',
  [LOINC + '|9999-9']: 'Heart rate',            // exists, but is a different concept from what the poisoned cache says
  [LOINC + '|LATE-1']: 'Respiratory rate',
  [SCT + '|364075005']: 'Heart rate',
};
// Every way a code can fail to be "verified": the code string of each one must appear NOWHERE in any output.
const FIELDS = [
  { id: 'ok_loinc',  label: 'Verified LOINC',        bindings: [{ system: 'loinc', code: '8867-4', display: 'Heart rate' }], good: ['8867-4'] },
  { id: 'ok_two',    label: 'Verified two systems',  bindings: [{ system: 'loinc', code: '8867-4', display: 'Heart rate' }, { system: 'snomed', code: '364075005', display: 'Heart rate' }], good: ['8867-4', '364075005'] },
  { id: 'notfound',  label: 'Not on the server',     bindings: [{ system: 'loinc', code: 'NF-UNVER-1', display: 'Made up' }] },
  { id: 'mismatch',  label: 'Display mismatch',      bindings: [{ system: 'loinc', code: '8480-6', display: 'Blood sugar level' }, { system: 'loinc', code: 'MM-UNVER-2', display: 'x' }] },
  { id: 'short',     label: 'Short display',         bindings: [{ system: 'loinc', code: '8480-6', display: 'HR' }] },                 // used to match ANY display
  { id: 'dashes',    label: 'Punctuation display',   bindings: [{ system: 'loinc', code: '8480-6', display: '--' }] },
  { id: 'icd',       label: 'ICD-10 (no verifier)',  bindings: [{ system: 'icd10', code: 'ICD-UNVER-3', display: 'Cholera' }] },
  { id: 'atc',       label: 'ATC (no verifier)',     bindings: [{ system: 'atc', code: 'ATC-UNVER-4', display: 'Metformin' }] },
  { id: 'ucum',      label: 'UCUM (no verifier)',    bindings: [{ system: 'ucum', code: 'UCUM-UNVER-5', display: 'milligram' }] },
  { id: 'local',     label: 'Local code',            bindings: [{ system: 'local', code: 'LOC-UNVER-6', display: 'Ward code' }] },
  { id: 'cpt',       label: 'CPT (off)',             bindings: [{ system: 'cpt', code: 'CPT-UNVER-7', display: 'Visit' }] },
  { id: 'unknown',   label: 'Unknown system',        bindings: [{ system: 'made-up', code: 'SYS-UNVER-8', display: 'Nothing' }] },
  { id: 'never',     label: 'Never verified',        bindings: [{ system: 'loinc', code: 'LATE-1', display: 'Respiratory rate' }], skipVerify: true },
  { id: 'llm_flag',  label: 'AI says verified',      bindings: [{ system: 'loinc', code: 'LLM-UNVER-9', display: 'Anything', source: 'llm', verified: true, status: 'verified' }] },
  { id: 'poisoned',  label: 'Poisoned cache',        bindings: [{ system: 'loinc', code: 'POI-UNVER-10', display: 'Heart rate' }], skipVerify: true },
  { id: 'edited',    label: 'Edited after verify',   bindings: [{ system: 'loinc', code: '8867-4', display: 'Heart rate' }], editAfter: 'Fasting glucose measurement' },
];
const unverCodes = ['NF-UNVER-1', 'MM-UNVER-2', 'ICD-UNVER-3', 'ATC-UNVER-4', 'UCUM-UNVER-5', 'LOC-UNVER-6', 'CPT-UNVER-7', 'SYS-UNVER-8', 'LLM-UNVER-9', 'POI-UNVER-10', 'LATE-1', '8480-6'];

async function exportEverything(p, fields) {
  const set = { id: 'sweep', kind: 'care', title: 'Sweep', desc: '', custom: true, version: 1, sdc: { authored: true },
    fields: fields.map(f => ({ id: f.id, label: f.label, type: 'text', bindings: JSON.parse(JSON.stringify(f.bindings)) })) };
  p.w.eval(`REGISTRY.push(${JSON.stringify(set)});applySet('sweep')`);
  for (const f of fields) {
    if (f.skipVerify) continue;
    for (const b of p.w.eval('getSet("sweep")').fields.find(x => x.id === f.id).bindings) await p.w.verifyBinding(b);
    if (f.editAfter) p.w.eval(`getSet("sweep").fields.find(x=>x.id==="${f.id}").bindings[0].display=${JSON.stringify(f.editAfter)}`);
  }
  p.w.eval(`Object.assign(CASE.values,${JSON.stringify(Object.fromEntries(fields.map(f => [f.id, 'value'])))})`);
  p.d.getElementById('qrMode').value = 'all';
  p.w.buildBundle();
  const bundle = JSON.parse(p.d.getElementById('bj').textContent);
  const questionnaire = p.json('buildQuestionnaire(getSet("sweep"))');
  return { bundle, questionnaire };
}

test('no unverified, mismatched, unknown or never-checked code appears as a Coding anywhere (Bundle, Questionnaire, QuestionnaireResponse)', async () => {
  const p = page({ store: { vr_codes: JSON.stringify({ [LOINC + '|POI-UNVER-10']: 'Totally different concept' }) }, tx: { codes: SERVER } });
  assert.deepEqual(p.errors, []);
  const { bundle, questionnaire } = await exportEverything(p, FIELDS);

  const types = bundle.entry.map(e => e.resource.resourceType);
  assert.ok(types.includes('Observation') && types.includes('QuestionnaireResponse') && types.includes('Composition'), 'the sweep really produced the outputs: ' + types.join());

  // verified pairs are exactly: LOINC 8867-4 and SNOMED 364075005 (the only codes that exist AND match)
  const verifiedPairs = new Set([LOINC + '|8867-4', SCT + '|364075005']);
  const found = [...codings(bundle), ...codings(questionnaire)];
  assert.ok(found.length >= 3, 'verified codes are still exported (found ' + found.length + ')');
  const stray = found.filter(c => !verifiedPairs.has(c.system + '|' + c.code));
  assert.deepEqual(stray, [], 'every Coding in every output is a verified one');
  for (const c of found) assert.ok(/heart rate/i.test(c.display || ''), 'exported display is the server display: ' + JSON.stringify(c));

  // and the unverified code strings are nowhere, not even as text
  const text = JSON.stringify(bundle) + JSON.stringify(questionnaire);
  for (const code of unverCodes) assert.ok(!text.includes(code), `code ${code} leaked into an export`);

  // the verified fields keep exactly their verified codings; the "edited after verify" field lost its coding
  const obs = label => bundle.entry.map(e => e.resource).find(r => r.resourceType === 'Observation' && r.code.text === label);
  assert.deepEqual(obs('Verified LOINC').code.coding.map(c => c.code), ['8867-4']);
  assert.deepEqual(obs('Verified two systems').code.coding.map(c => c.code).sort(), ['364075005', '8867-4']);
  for (const f of FIELDS.filter(x => !x.good)) assert.equal(obs(f.label).code.coding, undefined, `${f.label}: text only`);
  assert.match(p.d.getElementById('bchk').textContent, /unverified binding\(s\) left out of Coding/);
});

test('short or punctuation-only displays do not count as a display match', async () => {
  const p = page({ tx: { codes: SERVER } });
  for (const display of ['HR', 'BP', '--', 'a b', '!']) {
    const b = { system: 'loinc', code: '8480-6', display };
    assert.equal(await p.w.verifyBinding(b), 'mismatch', `display "${display}" against "Systolic blood pressure"`);
    assert.equal(p.w.eval(`bst(${JSON.stringify(b)})`), 'unverified', display);
  }
  assert.equal(await p.w.verifyBinding({ system: 'loinc', code: '8480-6', display: 'Systolic blood pressure' }), 'verified');
});

test('terminology server down: nothing becomes verified, nothing is exported as Coding', async () => {
  const p = page({ tx: { down: true } });
  const { bundle, questionnaire } = await exportEverything(p, FIELDS);
  assert.deepEqual([...codings(bundle), ...codings(questionnaire)], []);
  const text = JSON.stringify(bundle) + JSON.stringify(questionnaire);
  for (const code of [...unverCodes, '8867-4', '364075005']) assert.ok(!text.includes(code), `code ${code} leaked while the server was down`);
  assert.equal(p.w.localStorage.getItem('vr_codes'), null, 'a failed lookup caches nothing');
});
