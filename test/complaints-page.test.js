'use strict';
// R1a: OPD complaint sets and the complaint picker. Runs the real page in jsdom (no network, no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { lint } = require('../lint');
const { pageHtml, localScripts } = require('./html');
const HTML = pageHtml();

function page() {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.fetch = async () => new Response('{}', { status: 401 }); w.confirm = () => true; } });
  const w = dom.window;
  return { w, d: w.document, errors, ev: code => { const r = w.eval(code); return r === undefined ? r : JSON.parse(JSON.stringify(r)); } };
}
const IDS = ['cc_fever', 'cc_cough', 'cc_abdo', 'cc_headache', 'cc_chest', 'cc_joint'];
const buttons = p => [...p.d.querySelectorAll('#ccList button')];

test('six complaint sets exist as built-ins; each passes the shared lint with no codes, doses or rules, and needs no second reviewer', () => {
  const p = page(); assert.deepEqual(p.errors, []);
  assert.deepEqual(p.ev('COMPLAINT_SETS.map(s=>s.id)'), IDS);
  for (const id of IDS) {
    const s = p.ev(`BUILTIN.find(x=>x.id==="${id}")`);
    assert.ok(s, id + ' is a built-in');
    const r = lint(s, { scrub: false, bindingState: () => 'verified' });
    assert.equal(r.ok, true, id + ': ' + JSON.stringify(r.findings));
    assert.equal(r.needsTwoReviewers, false, id);
    assert.ok(s.fields.length >= 5, id + ' has its questions');
    assert.ok(s.fields.every(f => !('coding' in f) && !('bindings' in f)), id + ' carries no codes');
    assert.ok(s.fields.every(f => !/\d/.test(f.label + (f.options || []).join(' '))), id + ' has no numbers (no thresholds)');
  }
});

test('field ids of the complaint sets are unique across every built-in set, so applied sets never clash', () => {
  const p = page();
  const seen = new Map(), clash = [];
  for (const s of p.ev('BUILTIN')) for (const f of s.fields) { if (seen.has(f.id)) clash.push(`${f.id}: ${seen.get(f.id)} and ${s.id}`); seen.set(f.id, s.id); }
  assert.deepEqual(clash, []);
});

test('the complaint sets are offered in the demo import, and the module loads between 50-cases and 60-library', () => {
  const p = page();
  const imp = p.ev('DEMO_IMPORT');
  for (const id of IDS) assert.ok(imp.includes(id), id);
  assert.ok(imp.every(id => p.ev(`BUILTIN.some(b=>b.id==="${id}")`)), 'every demo-import id is a built-in');
  const l = localScripts();
  assert.equal(l.indexOf('modules/52-complaints.js'), l.indexOf('modules/50-cases.js') + 1);
});

test('the picker lists the six complaints with no inline handler; a click applies the set and the button shows it as added', () => {
  const p = page();
  assert.equal(buttons(p).length, 6);
  assert.equal(p.d.getElementById('ccPick').querySelector('[onclick],[onchange],[oninput]'), null, 'no inline handler (CSP)');
  assert.deepEqual(buttons(p).map(b => b.dataset.arg), IDS);
  assert.match(buttons(p)[0].textContent, /^Fever$/);
  buttons(p)[0].click();
  assert.deepEqual(p.ev('CASE.applied.map(a=>a.setId)'), ['cc_fever']);
  assert.match(p.d.getElementById('forms').textContent, /Pattern of fever as described/);
  const b = buttons(p)[0];
  assert.equal(b.disabled, true); assert.match(b.textContent, /added/);
  assert.equal(buttons(p)[1].disabled, false);
  buttons(p)[0].click();   // a disabled button does nothing
  assert.equal(p.ev('CASE.applied.length'), 1);
});

test('typing in the search box filters the list by title; no match says so; clearing brings them all back', () => {
  const p = page();
  const q = p.d.getElementById('cc_q');
  const type = v => { q.value = v; q.dispatchEvent(new p.w.Event('input', { bubbles: true })); };
  type('chest'); assert.deepEqual(buttons(p).map(b => b.dataset.arg), ['cc_chest']);
  type('PAIN'); assert.deepEqual(buttons(p).map(b => b.dataset.arg), ['cc_abdo', 'cc_chest', 'cc_joint']);
  type('zzz'); assert.equal(buttons(p).length, 0); assert.match(p.d.getElementById('ccList').textContent, /No complaint matches/);
  type(''); assert.equal(buttons(p).length, 6);
});

test('hostile titles and ids from other sources are shown as text and never become markup or an attribute break', () => {
  const p = page();
  p.w.eval(`REGISTRY.push({id:'cc_"><img src=x onerror="window.__hit=1">',kind:'template',title:'<img src=x onerror="window.__hit=1">Evil',fields:[]});renderComplaints()`);
  const box = p.d.getElementById('ccList');
  assert.equal(box.querySelector('img'), null);
  assert.equal(p.w.__hit, undefined);
  assert.ok(box.textContent.includes('<img src=x onerror="window.__hit=1">Evil'));
  const evil = buttons(p).at(-1);
  assert.equal(evil.dataset.arg, 'cc_"><img src=x onerror="window.__hit=1">');
});

test('signed in with no complaint set published, the picker says so instead of inventing any; signed out with none, it says that', () => {
  const p = page();
  p.w.eval(`REGISTRY=REGISTRY.filter(s=>!s.id.startsWith('cc_'));renderComplaints()`);
  assert.equal(buttons(p).length, 0);
  assert.match(p.d.getElementById('ccList').textContent, /No complaint sets are in the library/);
  p.w.eval(`Srv.user={username:'dr'};renderComplaints()`);
  assert.match(p.d.getElementById('ccList').textContent, /No complaint sets are published on the server yet/);
  p.w.eval(`Srv.user=null`);
});

test('a server-published complaint set (srv pin) appears in the picker and a non-complaint set does not', () => {
  const p = page();
  p.w.eval(`REGISTRY=[{id:'cc_fever',kind:'template',title:'Complaint: Fever',desc:'',fields:[],version:2,srv:{setId:7,version:2,checksum:'x',publishedBy:'a'}},{id:'dka_ctx',kind:'disease',title:'DKA context',fields:[]}];renderComplaints()`);
  assert.deepEqual(buttons(p).map(b => b.dataset.arg), ['cc_fever']);
});
