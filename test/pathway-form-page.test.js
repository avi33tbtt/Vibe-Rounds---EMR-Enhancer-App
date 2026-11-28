'use strict';
// Task D11: the page draws one package pathway from its layout (modules/92-pathway-form.js). Fake fetch, jsdom; state is set directly, no server.
// Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const root = path.join(__dirname, '..');
const mod = fs.readFileSync(path.join(root, 'modules', '92-pathway-form.js'), 'utf8');
async function page() {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = async () => { throw new Error('offline'); }; } });
  await new Promise(r => setTimeout(r, 120));
  return dom.window;
}
const fld = (id, label, extra = {}) => ({ id, label, type: 'text', ...extra });
const DEFS = { 'a-set': { title: 'Alpha', fields: [fld('a1', 'Alpha one'), fld('a2', 'Alpha two')] }, 'b-set': { title: 'Beta', fields: [fld('b1', 'Beta one')] } };
const pin = (slug, i, o = {}) => ({ setId: slug, srvAs: String(100 + i), srvSet: String(i), version: 1, title: DEFS[slug].title, fromPathway: 'pw', fromPathwayTitle: 'Pw', fromPathwayVersion: 1, ...o });
const LAYOUT = { entryForm: { sections: [
  { id: 's1', label: 'First', items: [{ kind: 'element', set: 'a-set', fields: ['a2', 'a1'] }, { kind: 'section', section: 'core.problems' }] },
  { id: 's2', label: 'Second', items: [{ kind: 'element', set: 'b-set', visibleByDefault: false }, { kind: 'section', section: 'core.care-episode' }] }] }, contexts: [] };
function setup(w, { pins, layout = LAYOUT, pathways, defs = DEFS } = {}) {
  w.__s = { pins: pins || [pin('a-set', 1), pin('b-set', 2)], layout, defs, pathways };
  w.eval(`Srv.user={username:'doc',role:'x',perms:['cases:write','sets:read']};
    CASE={id:'c1',serverId:7,applied:__s.pins,values:{},obs:[]};
    Object.keys(__s.defs).forEach((k,i)=>{PIN.defs[(i+1)+':1']={id:k,kind:'custom',title:__s.defs[k].title,desc:'',fields:__s.defs[k].fields,version:1}});
    PATHWAYS=__s.pathways||[{id:'pw',kind:'pathway',title:'Pw',members:[],layout:__s.layout,srvPw:{pathwayId:1,version:1,steps:[]}}];`);
}
const forms = w => w.document.getElementById('forms');
const cards = w => [...forms(w).querySelectorAll('.cd')];

test('1. layout: sections in layout order, fields in layout order, each drawn once by fieldHTML', async () => {
  const w = await page(); setup(w); w.eval('renderForms()');
  const h = cards(w).map(c => c.querySelector('h3').textContent);
  assert.deepEqual(h, ['First', 'Second']);
  const t = forms(w).textContent;
  assert.ok(t.indexOf('Alpha two') < t.indexOf('Alpha one'), 'layout field order');
  for (const l of ['Alpha one', 'Alpha two', 'Beta one']) assert.equal(t.split(l).length - 1, 1, l);
  assert.ok(forms(w).querySelector('input,textarea,select'), 'real inputs from fieldHTML');
});

test('2. no layout or hand-made pins: pfRender is null and the old form is unchanged', async () => {
  const w = await page(); setup(w); const withLayout = w.eval('pfRender()'); assert.ok(typeof withLayout === 'string');
  setup(w, { pathways: [{ id: 'pw', kind: 'pathway', members: [], layout: null, srvPw: { pathwayId: 1, version: 1, steps: [] } }] });
  assert.equal(w.eval('pfRender()'), null);
  w.eval('renderForms()'); const old = forms(w).innerHTML;
  assert.equal(old, w.eval("CASE.applied.map(a=>formCard(a)).join('')"), 'renderForms equals the plain card list');
  setup(w, { pins: [pin('a-set', 1, { fromPathway: null, fromPathwayVersion: null })] });
  assert.equal(w.eval('pfRender()'), null);
});

test('3. two pathways applied: null (composition is D12 and D13)', async () => {
  const w = await page(); setup(w, { pins: [pin('a-set', 1), pin('b-set', 2, { fromPathway: 'other' })] });
  assert.equal(w.eval('pfRender()'), null);
  setup(w, { pins: [pin('a-set', 1), pin('b-set', 2, { fromPathwayVersion: 2 })] });
  assert.equal(w.eval('pfRender()'), null, 'two versions of one pathway');
});

test('4. hidden item is in a closed details; section item gives a tab button; care episode gives a label only', async () => {
  const w = await page(); setup(w); w.eval('renderForms()');
  const d = forms(w).querySelector('details'); assert.ok(d && !d.open && d.textContent.includes('Beta one'));
  const b = [...forms(w).querySelectorAll('[data-act=pfGoTab]')]; assert.deepEqual(b.map(x => x.dataset.arg), ['problems']);
  assert.ok(forms(w).textContent.includes('Care episode'));
  w.eval("document.querySelector('nav [data-t=problems]').style.display=''");
  let clicked = 0; w.document.querySelector('nav [data-t=problems]').addEventListener('click', () => clicked++);
  b[0].click(); assert.equal(clicked, 1);
  w.eval("pfGoTab('x\"]')"); assert.equal(clicked, 1, 'unknown tab name does nothing');
});

test('5. a pin the layout does not place still appears as an ordinary card', async () => {
  const w = await page(); const lay = { entryForm: { sections: [{ id: 's', label: 'Only', items: [{ kind: 'element', set: 'a-set' }] }] }, contexts: [] };
  setup(w, { layout: lay }); w.eval('renderForms()');
  const t = forms(w).textContent; assert.ok(t.includes('Alpha one') && t.includes('Beta one'));
  assert.ok(forms(w).querySelector('[data-act=removeSet][data-arg=b-set]'), 'old card with Remove');
});

test('6. layout problems show a coded note and never hide an applied set', async () => {
  const w = await page(); const lay = { entryForm: { sections: [{ id: 's', label: 'S', items: [{ kind: 'element', set: 'gone-set' }, { kind: 'element', set: 'gone-set' }, { kind: 'section', section: 'nope' }] }] }, contexts: [] };
  setup(w, { layout: lay }); w.eval('renderForms()');
  const t = forms(w).textContent; assert.ok(/layout problem \(set-missing ×2\)/.test(t) && /layout problem \(section-unknown\)/.test(t), t);
  assert.ok(!/section-marker/.test(t));
  assert.ok(t.includes('Alpha one') && t.includes('Beta one'), 'both applied sets still shown');
});

test('7. hostile strings are escaped; nothing is built from them', async () => {
  const w = await page(); const X = '<img src=x onerror=window.__pwn=1>';
  const defs = { 'a-set': { title: X, fields: [fld('a1', X)] }, 'b-set': DEFS['b-set'] };
  const lay = { entryForm: { sections: [{ id: 's', label: X, items: [{ kind: 'element', set: 'a-set' }, { kind: 'element', set: 'b-set', visibleByDefault: false }] }] }, contexts: [] };
  setup(w, { defs, layout: lay, pins: [pin('a-set', 1, { title: X }), pin('b-set', 2)] }); w.eval('renderForms()');
  assert.equal(forms(w).querySelector('img'), null); assert.equal(w.__pwn, undefined);
  assert.ok(forms(w).textContent.includes(X), 'shown as text');
});

test('8. /pathway-form.js is served and loaded before the modules; no inline handler or storage', async () => {
  const l = localScripts(); assert.ok(l.indexOf('pathway-form.js') > -1 && l.indexOf('pathway-form.js') < l.indexOf('modules/00-boot.js'), l.join(','));
  assert.ok(l.indexOf('modules/92-pathway-form.js') < l.indexOf('modules/90-wire.js'));
  assert.ok(!/\son(click|change|input)=/i.test(mod) && !/localStorage|sessionStorage|fetch\(/.test(mod));
  assert.match(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), /app\.get\('\/pathway-form\.js'/);
  assert.match(fs.readFileSync(path.join(root, 'modules', '90-wire.js'), 'utf8'), /pfGoTab:/);
});
