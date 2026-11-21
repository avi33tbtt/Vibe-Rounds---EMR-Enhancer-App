'use strict';
// node --test no-handcode.test.js  (no database)
// Phase V, V8a: the client and server code must not name a clinical set id or field id. Every EMR screen is
// a registered view type plus data in a seed set; code reads ids from that data. Reads element-sets.js (seed
// sets and their fields) and scans enhancer.html, store.js and api.js for those ids as quoted words or as
// property names (r.<id>). F8 adds two checks: elements.js names no seed id, and no EMR file holds an analytics engine. Any hit not on ALLOW fails. ALLOW can only shrink: it must hold analytics lines
// only (Analytics runs in the other app), every entry must still match a hit, and its size is capped below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const FILES = ['enhancer.html', 'store.js', 'api.js'];
const MIN_ID = 4;                 // generic ids shorter than this are skipped
// Each entry is 'file:text', where text is a piece of the offending line. One entry covers every id on that line.
// DEBT entries are hand-coded clinical ids that Phase V still has to move into data. Each names the task that removes it
// (V8d1 to V8d8 in plan-V.md). When a task lands, delete its entries and lower ALLOW_MAX. The Phase V gate needs ALLOW empty
// (or analytics lines only, which the EMR does not have). Do not add a new entry for new code: fix the code.
const ALLOW = [
];
const ALLOW_MAX = 0;              // = ALLOW.length today; lower it when entries are removed, never raise it
// Not clinical: ids of EMR view pathways (contexts include 'emr') are configuration names, so code may name them
// (store.js and api.js hold the default list). Field ids that are also plain words in generic code are skipped:
// 'plan' is the FHIR CarePlan intent word, not a field reference.
const COMMON_FIELD_IDS = ['plan'];

const win = {};
vm.runInNewContext(fs.readFileSync('./element-sets.js', 'utf8'), { window: win });
const SEEDS = JSON.parse(JSON.stringify(win.SEED_SETS));

// ids from the seed data: every set id, every field id (sections[].fields[] and a flat fields[] if present)
const setIds = new Set(), fieldIds = new Set();
for (const s of SEEDS) {
  if ((s.contexts || []).includes('emr')) continue;   // view pathways are not clinical sets
  if (typeof s.setId === 'string' && s.setId.length >= MIN_ID) setIds.add(s.setId);
  const lists = [...(s.sections || []).map((x) => x.fields || []), s.fields || []];
  for (const fl of lists) for (const f of fl) if (f && typeof f.id === 'string' && f.id.length >= MIN_ID && !COMMON_FIELD_IDS.includes(f.id)) fieldIds.add(f.id);
}
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quoted = (id) => new RegExp('([\'"`])' + esc(id) + '\\1');
const prop = (id) => new RegExp('\\.' + esc(id) + '(?![\\w-])');
const isComment = (t) => /^\s*(\/\/|\/\*|\*)/.test(t);

function scan() {
  const hits = [];
  for (const file of FILES) {
    assert.ok(fs.existsSync('./' + file), file + ' is missing');
    // a bundled copy of enhancer.html may carry element-sets.js and cds-rules.js inline: that is seed data, not code (blank the lines, keep the line numbers)
    const text = fs.readFileSync('./' + file, 'utf8').replace(/<script>\s*\/\*\s*(?:element-sets|cds-rules)\.js :[\s\S]*?<\/script>/g, (m) => m.replace(/[^\n]/g, ''));
    text.split('\n').forEach((line, i) => {
      if (isComment(line)) return;
      for (const id of setIds) if (quoted(id).test(line)) hits.push({ file, n: i + 1, id, kind: 'set', line });
      for (const id of fieldIds) if (quoted(id).test(line) || prop(id).test(line)) hits.push({ file, n: i + 1, id, kind: 'field', line });
    });
  }
  return hits;
}
const allowed = (h) => ALLOW.some((a) => { const k = a.indexOf(':'); return a.slice(0, k) === h.file && h.line.includes(a.slice(k + 1)); });

test('V8a: the seed gives set ids and field ids to look for', () => {
  assert.ok(setIds.size > 0, 'no seed set ids found');
  assert.ok(fieldIds.size > 0, 'no seed field ids found: check the section and field shape');
});
test('V8a: no code names a seed set id or field id, except on ALLOW', () => {
  const bad = scan().filter((h) => !allowed(h));
  assert.deepEqual(bad.map((h) => `${h.file}:${h.n} ${h.kind} ${h.id}  | ${h.line.trim().slice(0, 120)}`), []);
});
test('V8a: ALLOW can only shrink, and every entry still matches a line', () => {
  console.log('V8a ALLOW size: ' + ALLOW.length + ' (max ' + ALLOW_MAX + ')');
  assert.ok(ALLOW.length <= ALLOW_MAX, 'ALLOW grew');
  const hits = scan();
  for (const a of ALLOW) {
    const k = a.indexOf(':');
    assert.ok(hits.some((h) => h.file === a.slice(0, k) && h.line.includes(a.slice(k + 1))), 'unused ALLOW entry: ' + a);
  }
});

// ---------- F8 (rule E9): elements.js names no sets, and the EMR has no analytics engine ----------
// (1) elements.js is generic: a seed set id or field id may not appear in it as a quoted word, a property name or a bare word (comments are skipped; tests are not scanned).
// 'slot' is the compatibility vocabulary of elements.js (a requirement slot), not a field reference; it also happens to be a seed field id. Skipped for this check only.
const ELEMENT_VOCAB = ['slot'];
const word = (id) => new RegExp('(?<![\\w-])' + esc(id) + '(?![\\w-])');
function idHits(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    for (const id of [...setIds, ...fieldIds]) if (!ELEMENT_VOCAB.includes(id) && (quoted(id).test(line) || prop(id).test(line) || word(id).test(line))) hits.push(`${i + 1} ${id}  | ${line.trim().slice(0, 100)}`);
  });
  return hits;
}
// (2) Only analytics.export and /analytics/export may exist. These files must not define any other analytics action or route, or name the Analytics app's masking or element table.
const ANALYTICS_FILES = ['api.js', 'store.js', 'enhancer.html', 'permissions.js'];
const BANNED_WORDS = ['maskCounts', 'element_rows'];
function analyticsHits(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    const bad = [];
    for (const m of line.matchAll(/analytics\.([a-z_]+)/g)) if (m[1] !== 'export') bad.push('analytics.' + m[1]);
    for (const m of line.matchAll(/\/analytics\/([A-Za-z_-]+)/g)) if (m[1] !== 'export') bad.push('/analytics/' + m[1]);
    for (const w of BANNED_WORDS) if (line.includes(w)) bad.push(w);
    bad.forEach((b) => hits.push(`${i + 1} ${b}  | ${line.trim().slice(0, 100)}`));
  });
  return hits;
}
test('F8: the checks themselves catch made-up bad input and allow the export names', () => {
  const [anyId] = [...fieldIds];
  assert.equal(idHits(`var x = '${anyId}';`).length, 1);
  assert.equal(idHits(`// ${anyId} only in a comment`).length, 0);
  assert.equal(analyticsHits("a['analytics.run']").length, 1);
  assert.equal(analyticsHits("r.get('/analytics/patients')").length, 1);
  assert.equal(analyticsHits('maskCounts(x)').length, 1);
  assert.equal(analyticsHits('SELECT * FROM element_rows').length, 1);
  assert.equal(analyticsHits("'analytics.export' and '/analytics/export'").length, 0);
});
test('F8: elements.js names no seed set id or field id', () => {
  assert.deepEqual(idHits(fs.readFileSync('./elements.js', 'utf8')), []);
});
test('F8: no analytics engine in the EMR (only analytics.export and /analytics/export)', () => {
  for (const file of ANALYTICS_FILES) {
    assert.ok(fs.existsSync('./' + file), file + ' is missing');
    assert.deepEqual(analyticsHits(fs.readFileSync('./' + file, 'utf8')), [], file);
  }
});

// ---------- F9a: ana() is retired ----------
// The old Analytics tab computed analytics in the browser. Analytics now run only in the Analytics app, so enhancer.html may hold
// no ana() and no r.temp style property access (the old fever-chart analytics read the temperature field by name).
test('F9a: enhancer.html has no ana() and no r.temp property access', () => {
  const text = fs.readFileSync('./enhancer.html', 'utf8');
  assert.ok(!/(?<![\w$.])ana\(/.test(text), 'ana() is still called or defined');
  assert.ok(!/(?<![\w$])r\.temp(?![\w$])/.test(text), 'r.temp property access found');
});
