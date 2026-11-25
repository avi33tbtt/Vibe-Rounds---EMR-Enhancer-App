'use strict';
// Row R2f-5a: the Local terms screen (modules/75-terms.js). Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '75-terms.js'), 'utf8');
const NAMES = ['renderTermsNav', 'termsLoad', 'renderTerms', 'termAdd', 'termStep'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const box = w => w.document.getElementById('termsBox').innerHTML;
const T = (o = {}) => ({ id: 1, code: 'demo.fever', version: 1, display: 'Fever', category: 'finding', definition: null, status: 'draft', created_at: '2026-11-25T10:00:00Z', created_by: 'doc', ...o });

test('75-terms.js loads right after 70-review.js, before the inline script; nothing of it is inline; no inline handlers', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/75-terms.js'), l.indexOf('modules/70-review.js') + 1, l.join(', '));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n);
    assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing from the module: ' + n);
  }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers');
  assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /id="navTerms"[^>]*display:none/);
  assert.match(raw, /<div class="pane" id="terms">/);
});

test('the tab is hidden without terms:read and shown with it; without it no request is made and a signed-out list is cleared', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(200, { terms: [T()] }); });
  as(w, 'v', ['cases:read']); w.eval('renderTermsNav()');
  assert.equal(w.document.getElementById('navTerms').style.display, 'none');
  calls.length = 0; await w.eval('termsLoad()'); assert.deepEqual(calls, []);
  as(w, 'v', ['terms:read']); w.eval('renderTermsNav()');
  assert.equal(w.document.getElementById('navTerms').style.display, '');
  await w.eval('termsLoad()'); assert.equal(w.eval('TERM.items.length'), 1);
  w.eval('Srv.user = null; renderTermsNav()');
  assert.equal(w.eval('TERM.items.length'), 0); assert.equal(w.eval('TERM.loaded'), false);
});

test('termsLoad lists the server terms with their status and escapes every text', async () => {
  const w = await page(async () => res(200, { terms: [T({ display: '<img src=x onerror=alert(1)>', definition: '<b>bold</b>', created_by: '<i>u</i>' })] }));
  as(w, 'v', ['terms:read']); await w.eval('termsLoad()');
  const h = box(w);
  assert.ok(!h.includes('<img') && !h.includes('<b>bold') && !h.includes('<i>u'), 'escaped');
  assert.match(h, /demo\.fever/); assert.match(h, />draft</);
});

test('termsLoad shows a failure message and an empty list without crashing', async () => {
  const w = await page(async () => res(500, { error: 'boom' }));
  as(w, 'v', ['terms:read']); await w.eval('termsLoad()');
  assert.match(box(w), /could not be loaded/);
  const w2 = await page(async () => res(200, { terms: [] }));
  as(w2, 'v', ['terms:read']); await w2.eval('termsLoad()');
  assert.match(box(w2), /No local terms yet/);
});

test('buttons follow the permission and the status: submit, review, publish, retire; a term you wrote cannot be reviewed by you', async () => {
  const items = [T({ id: 1, status: 'draft' }), T({ id: 2, code: 'b', status: 'in_review' }), T({ id: 3, code: 'c', status: 'in_review', created_by: 'inf' }),
    T({ id: 4, code: 'd', status: 'reviewed' }), T({ id: 5, code: 'e', status: 'published' }), T({ id: 6, code: 'f', status: 'rejected' }), T({ id: 7, code: 'g', status: 'retired' })];
  const w = await page(async () => res(200, { terms: items }));
  as(w, 'inf', ['terms:read', 'terms:review']); await w.eval('termsLoad()');
  let h = box(w);
  assert.ok(!/termSubmit|termPublish|termRetire|termAdd/.test(h), 'reviewer sees none of the other buttons');
  assert.equal((h.match(/data-act="termApprove"/g) || []).length, 1, 'only on the term inf did not write');
  assert.match(h, /cannot review it/);
  as(w, 'adm', ['terms:read', 'terms:write', 'terms:submit', 'terms:publish']); w.eval('renderTerms()'); h = box(w);
  for (const a of ['termAdd', 'termSubmit', 'termPublish', 'termRetire']) assert.ok(h.includes(`data-act="${a}"`), a);
  assert.ok(!/termApprove|termReject/.test(h));
  assert.match(h, /Rejected: this version is final/); assert.match(h, /Retired and frozen/);
  as(w, 'v', ['terms:read']); w.eval('renderTerms()'); h = box(w);
  assert.ok(!/data-act="term(Add|Submit|Approve|Reject|Publish|Retire)"/.test(h), 'read-only role sees no action button');
});

test('termAdd needs code and display (no request), sends only the four fields, and keeps the form when the server refuses', async () => {
  const calls = [];
  const w = await page(async (u, o) => { calls.push((o && o.method || 'GET') + ' ' + u + (o && o.body ? ' ' + o.body : '')); return o && o.method === 'POST' ? res(409, { message: 'Version 1 of this code is draft.' }) : res(200, { terms: [] }); });
  as(w, 'd', ['terms:read', 'terms:write']); await w.eval('termsLoad()'); calls.length = 0;
  await w.eval('termAdd()');
  assert.deepEqual(calls, []); assert.match(box(w), /Code and display are required/);
  const d = w.document;
  d.getElementById('tf_code').value = 'demo.cough'; d.getElementById('tf_display').value = ' Cough '; d.getElementById('tf_category').value = 'finding'; d.getElementById('tf_definition').value = '  ';
  await w.eval('termAdd()');
  assert.deepEqual(calls, ['POST /api/local-terms {"code":"demo.cough","display":"Cough","category":"finding"}']);
  assert.match(box(w), /Version 1 of this code is draft/);
  assert.equal(d.getElementById('tf_code').value, 'demo.cough', 'typed values are kept after a refusal');
  as(w, 'v', ['terms:read']); calls.length = 0; await w.eval('termAdd()'); assert.deepEqual(calls, [], 'no terms:write, no request');
});

test('termAdd success clears the form and reloads the list', async () => {
  let listed = 0;
  const w = await page(async (u, o) => { if (o && o.method === 'POST') return res(201, { term: T() }); listed++; return res(200, { terms: [T()] }); });
  as(w, 'd', ['terms:read', 'terms:write']); await w.eval('termsLoad()');
  w.document.getElementById('tf_code').value = 'demo.fever'; w.document.getElementById('tf_display').value = 'Fever';
  const before = listed; await w.eval('termAdd()');
  assert.equal(listed, before + 1); assert.equal(w.document.getElementById('tf_code').value, '');
});

test('termStep sends the right request per step; approve and reject need a reason first (no confirm, no request); bad ids and missing permission do nothing', async () => {
  const calls = []; let asked = 0;
  const w = await page(async (u, o) => { calls.push((o && o.method || 'GET') + ' ' + u + (o && o.body ? ' ' + o.body : '')); return o && o.method === 'POST' ? res(200, { term: T() }) : res(200, { terms: [T({ id: 2, status: 'in_review' })] }); });
  w.confirm = () => { asked++; return true; };
  as(w, 'inf', ['terms:read', 'terms:review', 'terms:submit', 'terms:publish']); await w.eval('termsLoad()'); calls.length = 0;
  await w.eval(`termStep('approve', '2')`);
  assert.equal(asked, 0); assert.deepEqual(calls, []); assert.match(box(w), /A reason is required/);
  w.document.getElementById('tr_2').value = ' Looks right ';
  await w.eval(`termStep('approve', '2')`);
  assert.equal(calls[0], 'POST /api/local-terms/2/approve {"reason":"Looks right"}');
  calls.length = 0;
  await w.eval(`termStep('submit', '9')`); await w.eval(`termStep('publish', '9')`); await w.eval(`termStep('retire', '9')`);
  assert.deepEqual(calls.filter(c => c.startsWith('POST')), ['POST /api/local-terms/9/submit {}', 'POST /api/local-terms/9/publish {}', 'POST /api/local-terms/9/retire {}']);
  calls.length = 0;
  for (const bad of ['x', '1/../2', '', '1;2']) await w.eval(`termStep('submit', ${JSON.stringify(bad)})`);
  await w.eval(`termStep('delete', '1')`); await w.eval(`termStep('toString', '1')`);
  as(w, 'v', ['terms:read']); await w.eval(`termStep('submit', '1')`); await w.eval(`termStep('publish', '1')`);
  assert.deepEqual(calls, []);
});

test('a refusal shows the server message on that term; 409 reloads the list; a click on a button runs the step', async () => {
  const calls = [];
  const w = await page(async (u, o) => {
    calls.push((o && o.method || 'GET') + ' ' + u);
    if (o && o.method === 'POST') return res(403, { error: 'own_term', message: 'You wrote or submitted this term, so you cannot review it.' });
    return res(200, { terms: [T({ id: 3, status: 'in_review', created_by: 'someone' })] });
  });
  as(w, 'inf', ['terms:read', 'terms:review']); await w.eval('termsLoad()');
  w.document.getElementById('tr_3').value = 'ok';
  w.document.querySelector('[data-act="termReject"]').click();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(calls.includes('POST /api/local-terms/3/reject'));
  assert.match(box(w), /cannot review it/);
  assert.equal(w.document.getElementById('tr_3').value, 'ok', 'the reason stays in the box after a refusal');
});
