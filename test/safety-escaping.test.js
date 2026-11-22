'use strict';
// Chunk 06a: every piece of user- or server-supplied text the page renders is escaped.
// Hostile strings are stored where real data lives (localStorage case + custom set) and the page is rendered in jsdom.
// Each must show up as visible text, create no element, and run nothing. Handler arguments (ids) must not break out of the string.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = require('./html').pageHtml();

const SCRIPT = '<script>window.__pwn=1</script>';
const IMG = '<img src=x onerror="window.__pwn=1">';
const SVG = '"><svg onload="window.__pwn=1">';
const QUOTE = "x');window.__pwn=1;('";          // breaks out of '...' in a handler if spliced in raw
const AMP = 'a &amp; b';                         // must display as typed, not as "a & b"

const SET_ID = 'hostile_' + QUOTE;
const REP_ID = 'rep_' + QUOTE;
const TXT_ID = 'txt' + SVG;
const NOTE_ID = 'n_' + QUOTE;
const SIGNED_ID = 'n2_' + QUOTE;
const NOW = '2026-01-01T00:00:00.000Z';

function seed() {
  const set = {
    id: SET_ID, kind: 'care', title: SCRIPT, desc: IMG, custom: true, version: 1,
    fields: [
      { id: 'sel', label: IMG, type: 'select', options: [SCRIPT, SVG, AMP], unit: SVG, rationale: SCRIPT },
      { id: TXT_ID, label: SVG, type: 'text' },
      { id: REP_ID, label: SCRIPT, type: 'number', unit: IMG, repeat: true,
        bindings: [{ system: 'local', code: SVG, display: IMG }] },
    ],
  };
  const kindSet = { id: 'odd_kind', kind: SVG, title: 'Odd kind', desc: '', custom: true, version: 1, fields: [{ id: 'a', label: 'A', type: 'text' }] };
  const c = {
    id: 'c1', patient: { name: SCRIPT, mrn: IMG, age: SVG, sex: 'M' }, narrative: '', patientId: null,
    applied: [{ setId: SET_ID, version: 1, addedAt: NOW }, { setId: 'odd_kind', version: 1, addedAt: NOW }],
    values: { sel: SVG, [TXT_ID]: IMG, [REP_ID]: [{ ts: SVG, value: SCRIPT }] },
    notes: [
      { id: NOTE_ID, kind: 'free', title: SCRIPT, body: IMG, status: 'draft', createdAt: NOW, amendments: [] },
      { id: SIGNED_ID, kind: 'free', title: SVG, body: SCRIPT, status: 'signed', createdAt: NOW, signedAt: NOW, signedBy: IMG,
        amendments: [{ at: NOW, by: SCRIPT, reason: SVG, body: IMG }] },
    ],
    status: 'open', createdAt: NOW, updatedAt: NOW,
  };
  return { vr_traj: JSON.stringify({ cases: [c], current: 'c1', customs: [set, kindSet] }) };
}

function page() {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(seed())) w.localStorage.setItem(k, v);
      w.fetch = async () => new Response('{}', { status: 401 });
    } });
  const w = dom.window;
  w.renderAll();
  return { w, d: w.document, errors };
}

// Nothing the data supplied may have become an element, and no inline handler may exist.
function assertInert(w, d, id) {
  const box = d.getElementById(id);
  assert.ok(box, id + ' exists');
  const bad = box.querySelector('script, img, svg, [onerror], [onload]');
  assert.equal(bad, null, `${id}: hostile markup became an element: ${bad && bad.outerHTML}`);
  for (const el of box.querySelectorAll('*')) {
    for (const a of el.attributes) {
      if (/^on/.test(a.name)) assert.fail(`${id}: inline handler ${a.name} on <${el.tagName.toLowerCase()}> (the page has none since 6d-2c)`);
    }
  }
  assert.equal(w.__pwn, undefined, `${id}: hostile script ran`);
}

const CONTAINERS = ['pbanner', 'appliedChips', 'pathwayList', 'elementList', 'forms', 'libList', 'codeTab', 'noteList', 'caseList'];

test('escA escapes both quote kinds, < > and &', () => {
  const { w } = page();
  assert.equal(w.escA(`<>"'&`), '&lt;&gt;&quot;&#39;&amp;');
  assert.equal(w.escA(null), '');
});

test('hostile stored text renders as visible text and runs nothing, in every list', () => {
  const { w, d, errors } = page();
  w.renderLib(); w.renderCustomList(); w.codesUI(); w.renderNotes(); w.renderCases();
  w.document.querySelector('[data-t=case]').click();
  for (const id of CONTAINERS.concat('customList')) assertInert(w, d, id);
  assert.deepEqual(errors, []);
});

test('each hostile string is shown literally: set title, field label, option, note body, patient name', () => {
  const { w, d } = page();
  w.renderLib(); w.renderCustomList(); w.codesUI();
  const text = id => d.getElementById(id).textContent;
  assert.ok(text('pbanner').includes(SCRIPT), 'patient name in banner');
  assert.ok(text('appliedChips').includes(SCRIPT), 'set title in chip');
  assert.ok(text('elementList').includes(SCRIPT) && text('elementList').includes(IMG), 'set title and description in sidebar');
  const forms = text('forms');
  assert.ok(forms.includes(SCRIPT), 'set title and repeating-field label in form');
  assert.ok(forms.includes(IMG), 'select-field label');
  assert.ok(forms.includes(AMP), 'option shown as typed, not decoded');
  assert.ok(text('noteList').includes(IMG), 'draft note body (textarea) / signer');
  assert.ok(text('noteList').includes(SCRIPT), 'signed note body');
  assert.ok(text('libList').includes(SCRIPT), 'library title');
  assert.ok(text('codeTab').includes(SVG) || text('codeTab').includes('local'), 'code table renders the code as text');
  assert.equal(d.getElementById('forms').querySelector('#f_' + CSS_ESC(w, 'sel')).value, SVG, 'select keeps stored value');
  assert.equal(w.__pwn, undefined);
});

test('an id containing a quote cannot break out of an inline handler', () => {
  const { w, d } = page();
  w.renderLib(); w.renderCustomList();
  w.eval("Srv.user = { username: 'doc', role: 'doctor', perms: [] }"); w.renderNotes(); w.renderForms();   // the Sign and Error buttons are disabled without a session (chunks 8e, 8f)
  const got = [];
  for (const fn of ['applySet', 'removeSet', 'dlQ', 'editCustom', 'signNote', 'toggleAmend', 'editNote', 'setVal', 'addRow', 'markRowError', 'openCase'])
    w[fn] = (...a) => got.push([fn, ...a]);
  const click = (sel, root = d) => { const el = root.querySelector(sel); assert.ok(el, 'found ' + sel); el.click(); };
  const last = (sel, back = 2) => { const all = d.querySelectorAll(sel); assert.ok(all.length >= back, 'found ' + sel); all[all.length - back].click(); };
  last('#libList button[data-act="applySet"]');      // built-ins come first, then the hostile set, then odd_kind
  last('#elementList .item');
  click('#forms button[data-act="removeSet"]');
  last('#libList button[data-act="dlQ"]');
  click('#customList button[data-act="editCustom"]');
  click('#noteList button[data-act="signNote"]');
  click('#noteList button[data-act="toggleAmend"]');
  click('#caseList .item');
  const sel = d.querySelector('#forms select'); sel.dispatchEvent(new w.Event('change', { bubbles: true }));   // setVal(fieldId, value)
  const ta = d.querySelector('#noteList textarea'); ta.dispatchEvent(new w.Event('change', { bubbles: true })); // editNote(noteId, value)
  const add = d.querySelector('#forms .rep-add button'); d.getElementById('new_' + REP_ID).value = '5'; add.click(); // addRow(fieldId, value)
  click('#forms button[data-act="markRowError"]');
  assert.equal(w.__pwn, undefined, 'no handler argument executed code');
  const by = fn => got.filter(g => g[0] === fn);
  assert.equal(by('applySet')[0][1], SET_ID);   // from the library button
  assert.ok(by('applySet').some(g => g[1] === SET_ID), 'sidebar item passes the exact id');
  assert.equal(by('removeSet')[0][1], SET_ID);
  assert.equal(by('dlQ')[0][1], SET_ID);
  assert.equal(by('editCustom')[0][1], SET_ID);
  assert.equal(by('signNote')[0][1], NOTE_ID);
  assert.equal(by('toggleAmend')[0][1], SIGNED_ID);
  assert.equal(by('editNote')[0][1], NOTE_ID);
  assert.equal(by('setVal')[0][1], 'sel');
  assert.deepEqual(by('addRow')[0].slice(1), [REP_ID, '5']);
  assert.equal(by('markRowError')[0][1], REP_ID);
  assert.equal(by('openCase')[0][1], 'c1');
});

test('registered-patient lists (server data) are inert too', async () => {
  const { w, d } = page();
  w.eval(`Srv.user = ${JSON.stringify({ username: SCRIPT, role: IMG, perms: ['patients:archive'] })}`);
  w.renderWho();
  assertInert(w, d, 'who');
  assert.ok(d.getElementById('who').textContent.includes(SCRIPT));
  w.eval(`Srv.pts = { 7: ${JSON.stringify({ id: 7, name: SCRIPT, mrn: IMG, age: SVG, sex: 'M', dob: SVG, open_bed: SCRIPT, open_encounter_id: 3, open_since: SVG })} }; CASE.patientId = 7;`);
  w.renderBanner(); w.renderEncounter();
  assertInert(w, d, 'pbanner'); assertInert(w, d, 'encPanel');
  assert.ok(d.getElementById('pbanner').textContent.includes(SCRIPT));
  assert.equal(w.__pwn, undefined);
});

function CSS_ESC(w, s) { return w.CSS && w.CSS.escape ? w.CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'); }
