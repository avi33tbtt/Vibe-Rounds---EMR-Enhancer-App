'use strict';
// Task D13: the page draws the server's composed form (modules/92-pathway-form.js). Fake fetch, jsdom; the answer is built with the real composed-form.js.
// Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml } = require('./html');
const { composeForm } = require('../composed-form');

const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '92-pathway-form.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fld = (id, label, concept) => ({ id, label, type: 'text', ...(concept ? { concept } : {}) });
const DEFS = () => ({ dm: { title: 'DM', fields: [fld('hba1c', 'HbA1c', 'glycated-hb'), fld('bp', 'BP')] }, ckd: { title: 'CKD', fields: [fld('hb2', 'HbA1c kidney', 'glycated-hb'), fld('egfr', 'eGFR', 'egfr')] }, plain: { title: 'Plain', fields: [fld('p1', 'Plain one')] } });
const LAY = (set) => ({ sections: [{ id: 's1', label: 'Main', items: [{ kind: 'element', set }] }] });
const PWS = () => [{ slug: 'dm-path', version: 1, entryForm: LAY('dm'), contexts: [] }, { slug: 'ckd-path', version: 1, entryForm: LAY('ckd'), contexts: [] }];
const ANSWER = (defs = DEFS()) => ({ composed: true, pathways: [], pins: [], form: composeForm({ pathways: PWS(), sets: { dm: defs.dm, ckd: defs.ckd } }) });
const pin = (slug, i, o = {}) => ({ setId: slug, srvAs: String(100 + i), srvSet: String(i), version: 1, title: slug, fromPathway: slug === 'ckd' ? 'ckd-path' : slug === 'dm' ? 'dm-path' : null, fromPathwayVersion: slug === 'plain' ? null : 1, ...o });

async function page(answer) {
  const calls = { get: 0, posts: [] };
  const f = async (u, opt) => {
    const m = (opt && opt.method) || 'GET';
    if (u === '/api/me') return { status: 401, json: async () => ({}) };
    if (/composed-form$/.test(u)) { calls.get++; const a = typeof answer === 'function' ? await answer() : answer; return { status: a ? 200 : 500, json: async () => a || {} }; }
    if (m === 'POST') { calls.posts.push({ u, b: JSON.parse(opt.body) }); return { status: 201, json: async () => ({ observations: [] }) }; }
    return { status: 404, json: async () => ({}) };
  };
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/', beforeParse(w) { w.fetch = f; } });
  await sleep(120); return { w: dom.window, calls };
}
function setup(w, pins, defs = DEFS()) {
  w.__s = { pins, defs };
  w.eval(`Srv.user={username:'doc',role:'x',perms:['cases:write','cases:read','sets:read']};
    CASE={id:'c1',serverId:7,pinsOk:true,applied:__s.pins,values:{},obs:[]};
    Object.keys(__s.defs).forEach(k=>{const p=__s.pins.find(x=>x.setId===k);if(p)PIN.defs[p.srvSet+':1']={id:k,kind:'custom',title:__s.defs[k].title,desc:'',fields:__s.defs[k].fields,version:1}});
    PATHWAYS=[];`);
}
const forms = w => w.document.getElementById('forms');
const BOTH = () => [pin('dm', 1), pin('ckd', 2)];

test('1. composed answer: sections drawn, the shared field once at the owner with the "Also used by" note', async () => {
  const { w } = await page(ANSWER()); setup(w, BOTH()); w.eval('renderForms()'); await sleep(60);
  const t = forms(w).textContent;
  assert.equal(t.split('HbA1c').length - 1, 1, 'the shared label is drawn once');
  assert.ok(!t.includes('HbA1c kidney'), 'the user field is not drawn');
  assert.ok(t.includes('Also used by: CKD'), t);
  assert.ok(t.includes('eGFR'));
});

test('2. typing in the owner input posts to the OWNER set pin', async () => {
  const { w, calls } = await page(ANSWER()); setup(w, BOTH()); w.eval('renderForms()'); await sleep(60);
  const inp = forms(w).querySelector('input[data-arg=hba1c]'); assert.ok(inp); inp.value = '7'; inp.dispatchEvent(new w.Event('change', { bubbles: true })); await sleep(60);
  assert.equal(calls.posts.length, 1); assert.equal(calls.posts[0].b.observations[0].appliedSetId, 101); assert.equal(calls.posts[0].b.observations[0].fieldKey, 'hba1c');
});

test('3. composed:false or a failed request: old form, and no second request for the same key', async () => {
  for (const ans of [{ composed: false, reason: 'no-layout' }, null]) {
    const { w, calls } = await page(ans); setup(w, BOTH()); w.eval('renderForms()'); await sleep(60); w.eval('renderForms()'); w.eval('renderForms()'); await sleep(30);
    assert.equal(calls.get, 1); const old = forms(w).innerHTML; assert.equal(old, w.eval("CASE.applied.map(a=>formCard(a)).join('')"));
  }
});

test('4. withdrawing a pin changes the key and asks again', async () => {
  const { w, calls } = await page(ANSWER()); setup(w, BOTH()); w.eval('renderForms()'); await sleep(60); assert.equal(calls.get, 1);
  w.eval("CASE.applied=CASE.applied.concat([{setId:'plain',srvAs:'103',srvSet:'3',version:1,title:'Plain',fromPathway:null,fromPathwayVersion:null}]);PIN.defs['3:1']={id:'plain',kind:'custom',title:'Plain',desc:'',fields:[{id:'p1',label:'Plain one',type:'text'}],version:1}");
  w.eval('renderForms()'); await sleep(60); assert.equal(calls.get, 2);
});

test('5. a late answer for an old key is dropped', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const { w, calls } = await page(async () => { if (!release.used) { release.used = true; await gate; } return ANSWER(); });
  setup(w, BOTH()); w.eval('renderForms()'); await sleep(30);
  w.eval("CASE.applied=CASE.applied.slice(0,1).concat([{setId:'ckd',srvAs:'555',srvSet:'2',version:1,title:'ckd',fromPathway:'ckd-path',fromPathwayVersion:1}])");
  release(); await sleep(80);
  assert.equal(calls.get, 1); assert.equal(w.eval('CF.key'), null, 'the answer for the old pin set is not kept');
});

test('6. unplaced and plain pins still appear as old cards', async () => {
  const { w } = await page(ANSWER()); setup(w, [...BOTH(), pin('plain', 3)]); w.eval('renderForms()'); await sleep(60);
  assert.ok(forms(w).textContent.includes('Plain one')); assert.ok(forms(w).querySelector('[data-act=removeSet][data-arg=plain]'));
});

test('7. hostile strings are escaped', async () => {
  const X = '<img src=x onerror=window.__pwn=1>', defs = DEFS(); defs.ckd.title = X; defs.dm.fields[0].label = X;
  const { w } = await page(ANSWER(defs)); setup(w, BOTH(), defs); w.eval('renderForms()'); await sleep(60);
  assert.equal(forms(w).querySelector('img'), null); assert.equal(w.__pwn, undefined); assert.ok(forms(w).textContent.includes(X));
});

test('8. a one-pathway case draws as in D11; no inline handler or browser storage', async () => {
  const { w, calls } = await page(ANSWER()); setup(w, [pin('dm', 1)]);
  w.eval("PATHWAYS=[{id:'dm-path',kind:'pathway',members:[],layout:{entryForm:{sections:[{id:'s',label:'Only',items:[{kind:'element',set:'dm'}]}]},contexts:[]},srvPw:{pathwayId:1,version:1,steps:[]}}]");
  w.eval('renderForms()'); await sleep(40); assert.equal(calls.get, 0); assert.ok(forms(w).textContent.includes('Only'));
  assert.ok(!/\son(click|change|input)=/i.test(mod) && !/localStorage|sessionStorage/.test(mod));
});
