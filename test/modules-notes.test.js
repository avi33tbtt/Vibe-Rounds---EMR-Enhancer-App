'use strict';
// Row R0e-3: notes (draft, sign, amend; B3c-2) live in modules/84-notes.js and behave as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '84-notes.js'), 'utf8');
const NAMES = ['snapshotText', 'noteFromRow', 'notesLoad', 'noteCall', 'srvNoteAdd', 'srvNoteEdit', 'srvNoteSign', 'srvNoteDiscard', 'srvNoteAmend',
  'addNote', 'editNote', 'signNote', 'discardNote', 'toggleAmend', 'submitAmend', 'renderNotes'];
const CONSTS = ['AMEND', 'NOTEF', 'NOTE_TYPE_LABEL', 'noteCurrent', 'NQ', 'noteQ', 'noteMine', 'lostBox', 'nid'];

test('84-notes.js loads after 82-insights.js and before the inline script; none of it is inline any more', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/84-notes.js'), l.indexOf('modules/82-insights.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/84-notes.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    const re = new RegExp(`(async )?function ${n}\\(`);
    assert.ok(!re.test(inline), 'still inline: ' + n);
    assert.ok(re.test(mod), 'missing from the module: ' + n);
  }
  for (const c of CONSTS) {
    assert.ok(!new RegExp(`^const ${c}=`, 'm').test(inline), 'constant still inline: ' + c);
    assert.ok(new RegExp(`^const ${c}=`, 'm').test(mod), 'constant missing: ' + c);
  }
  const tops = mod.split('\n').filter(x => /^(const|let|var) /.test(x)).map(x => x.split('=')[0].replace(/^(const|let|var) /, ''));
  assert.deepEqual(tops, CONSTS, 'no other top-level variables');
  assert.match(inline, /\/\* LLM generate \*\//, 'the AI code after the notes stays in the page');
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });

test('noteCurrent returns the latest amendment text, otherwise the signed body', async () => {
  const w = await page();
  assert.equal(w.eval(`noteCurrent({ body: 'a', amendments: [] })`), 'a');
  assert.equal(w.eval(`noteCurrent({ body: 'a', amendments: [{ body: 'b' }, { body: 'c' }] })`), 'c');
});

test('lostBox escapes the text that was refused and shows nothing when nothing was lost', async () => {
  const w = await page();
  const h = w.eval(`lostBox({ lost: '<img src=x onerror=1>' })`);
  assert.ok(!h.includes('<img'), h);
  assert.match(h, /Not saved \(someone else saved first\)/);
  assert.equal(w.eval(`lostBox({ lost: '' })`), '');
});

test('notesLoad reads the notes of the case, oldest first, and marks a refused text as lost', async () => {
  const w = await page(async (u) => u === '/api/cases/5/notes'
    ? res(200, { notes: [{ id: 2, body: 'new', status: 'draft', amendments: [] }, { id: 1, body: 'old', status: 'draft', amendments: [] }] }) : res(404, {}));
  const c = w.eval(`({ serverId: 5, notes: [] })`);
  const ok = await w.eval(`(async()=>{ window.__c = { serverId: 5, notes: [] }; const r = await notesLoad(window.__c, { 2: 'my text' }); return r })()`);
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(w.eval(`JSON.stringify(window.__c.notes.map(n => [n.srvId, n.lost]))`)), [[1, ''], [2, 'my text']]);
  void c;
});

test('srvNoteAdd refuses without a saved case, with notes not loaded, or without cases:write, and sends nothing', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }`);
  calls.length = 0;
  w.eval(`CASE.serverId = null`); await w.eval(`srvNoteAdd('note')`);
  w.eval(`CASE.serverId = 5; CASE.notesOk = false`); await w.eval(`srvNoteAdd('note')`);
  w.eval(`CASE.notesOk = true; Srv.user = { username: 'v', role: 'viewer', perms: [] }`); await w.eval(`srvNoteAdd('note')`);
  assert.deepEqual(calls, []);
});

test('srvNoteAdd posts only the body and the note type, and puts the server row first; the typed box is cleared', async () => {
  const calls = [];
  const w = await page(async (u, o) => {
    calls.push((o && o.method) + ' ' + u + ' ' + (o && o.body));
    return res(201, { note: { id: 9, body: 'hello', status: 'draft', amendments: [], author: 'd', created_at: '2026-11-25T10:00:00Z', row_version: 1 } });
  });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }; CASE.serverId = 5; CASE.notesOk = true; CASE.notes = []`);
  w.document.getElementById('n_body').value = 'hello';
  calls.length = 0;
  await w.eval(`srvNoteAdd('note')`);
  assert.deepEqual(calls, ['POST /api/cases/5/notes {"body":"hello","type":"general"}']);
  assert.equal(w.eval('CASE.notes[0].srvId'), 9);
  assert.equal(w.document.getElementById('n_body').value, '');
});

test('submitAmend needs a reason and changed text before it asks the server anything', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }; CASE.notes = [{ id: 's1', srvId: 1, status: 'signed', body: 'x', amendments: [] }]`);
  w.document.body.insertAdjacentHTML('beforeend', '<input id="am_r_s1" value=""><textarea id="am_b_s1">y</textarea>');
  calls.length = 0;
  await w.eval(`submitAmend('s1')`);
  w.document.getElementById('am_r_s1').value = 'why';
  w.document.getElementById('am_b_s1').value = 'x';
  await w.eval(`submitAmend('s1')`);
  assert.deepEqual(calls, []);
});
