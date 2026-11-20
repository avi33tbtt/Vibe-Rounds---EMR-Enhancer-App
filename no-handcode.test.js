'use strict';
// node --test no-handcode.test.js  (no database)
// Phase V, V8a: the client and server code must not name a clinical set id or field id. Every EMR screen is
// a registered view type plus data in a seed set; code reads ids from that data. Reads element-sets.js (seed
// sets and their fields) and scans enhancer.html, store.js and api.js for those ids as quoted words or as
// property names (r.<id>). Any hit not on ALLOW fails. ALLOW can only shrink: it must hold analytics lines
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
  // V8d1: default and quick-add set lists (Demo mode starter sets)
  "enhancer.html:const DEF=['care.vitals','template.basic_emr'",
  "enhancer.html:const quickIds=['care.vitals'",
  "enhancer.html:const set=registry().find(x=>x.setId==='template.basic_emr')",
  // V8d2: demo sample cases
  "enhancer.html:const DEMO=SEEDS.find(s=>s.setId=='disease.snake_envenomation')",
  // V8d3: FHIR export pairing and method text
  "enhancer.html:bp2=gf.some(q=>q.id=='bp_sys')",
  "enhancer.html:if(fv&&f.id=='route')return;",
  "enhancer.html:const bpOk=bp2&&(f.id=='bp_sys'",
  "enhancer.html:if(bpOk){if(f.id=='bp_dia')return;",
  "enhancer.html:if(fv&&f.id==V.tempField&&row.route)",
  // V8d4: blood pressure pair in text lines
  "enhancer.html:bp=gf.find(f=>f.id=='bp_sys'),bd=gf.find(f=>f.id=='bp_dia'),lines=[];",
  "enhancer.html:function rowText(r,vals){const bp=vals.find(f=>f.id=='bp_sys')",
  // V8d5: typed target echo and insulin scale echo
  "enhancer.html:const lo=fnum(CUR.values[vk(sid,'tgt_low')])",
  "enhancer.html:const ssi=CUR.applied.some(a=>a.setId=='care.sliding_scale_insulin')",
  // V8d6: pulse on the fever chart
  "enhancer.html:pf=(v.extra||[]).includes('pulse')",
  // V8d7: HbA1c trend and due label
  "enhancer.html:if(!(c.applied||[]).some(a=>a.setId=='care.hba1c_monitoring'))return;",
  "enhancer.html:const ts=rowsOf(c,'care.hba1c_monitoring','hba1c')",
  "enhancer.html:function dueBadge(){",
  "enhancer.html:function patientDueLabel(x){if(x.set==='care.hba1c_monitoring'",
  // V8d8: snake-bite gap
  "enhancer.html:function gapOf(c){let g=parseFloat(val(c,'gap',SNK))",
];
const ALLOW_MAX = 19;             // = ALLOW.length today; lower it when entries are removed, never raise it
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
