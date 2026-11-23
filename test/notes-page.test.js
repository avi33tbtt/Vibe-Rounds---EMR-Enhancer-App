'use strict';
// Task B3c-2: notes in the page, signed in = server notes. Real page (jsdom) + real server + PostgreSQL.
// Author, signer and amender are the session (set by the server); nothing about a note is kept in the browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW } = require('./helpers');

let env, api, seq = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }
test.before(async () => { env = await setup(); api = client(env.base); assert.equal((await api.login('nurse1')).status, 200); });
test.after(async () => { await env.close(); });

async function openPage(store = {}) {
  const jar = {}, fetched = [];
  const dom = await JSDOM.fromURL(env.base + '/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
      w.confirm = () => true;
      w.fetch = async (path, o = {}) => {
        fetched.push({ path: String(path), method: o.method || 'GET', body: o.body || '' });
        const res = await fetch(env.base + path, { ...o, headers: { ...(o.headers || {}), ...(jar.c ? { cookie: jar.c } : {}) } });
        const sc = res.headers.get('set-cookie'); if (sc) jar.c = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
        return res;
      };
    } });
  const w = dom.window, d = w.document;
  const ui = { w, d, fetched, $: id => d.getElementById(id), ls: k => w.localStorage.getItem(k), ev: s => w.eval(s),
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); },
    async open(patientId) { await w.ptOpenCase(patientId); await until(() => w.eval('!!CASE.serverId && CASE.notesOk === true'), 'case and notes open'); },
    async add(text) { ui.$('n_body').value = text; await w.addNote('free'); },
    notes: () => JSON.parse(JSON.stringify(w.eval('CASE.notes'))),
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}
async function newPatient() {
  const p = await api.post('/api/patients', { name: 'Notes Page ' + (++seq), mrn: 'NP-' + seq, dob: '1975-05-05', sex: 'M' });
  assert.equal(p.status, 201); return p.body.patient.id;
}
const dbNotes = async cid => (await env.pool.query('SELECT n.id, n.status, n.body, n.row_version, u.username AS author, s.username AS signer FROM case_notes n JOIN users u ON u.id = n.author_id LEFT JOIN users s ON s.id = n.signed_by WHERE n.case_id = $1 ORDER BY n.id', [cid])).rows;

test('draft, edit, sign and amend through the page: the server holds them, the session is author, signer and amender, the browser keeps nothing', async () => {
  const pid = await newPatient(), a = await openPage(); await a.login('nurse1'); await a.open(pid);
  const cid = a.ev('CASE.serverId');
  assert.equal(a.$('n_titleRow').style.display, 'none', 'a server note has no title');
  assert.match(a.$('noteList').textContent, /No notes yet/);
  await a.add('SYNTH-NOTE first draft');
  assert.equal((await dbNotes(cid)).length, 1);
  const post = a.fetched.filter(f => f.method === 'POST' && /\/notes$/.test(f.path)); assert.deepEqual(JSON.parse(post[0].body), { body: 'SYNTH-NOTE first draft' }, 'only the text is sent');
  let n = a.notes()[0]; assert.equal(n.status, 'draft'); assert.equal(n.author, 'nurse1');

  const ta = a.d.querySelector('#noteList textarea'); ta.value = 'SYNTH-NOTE edited draft'; ta.dispatchEvent(new a.w.Event('change', { bubbles: true }));
  await until(async () => (await dbNotes(cid))[0].body === 'SYNTH-NOTE edited draft', 'edit saved');
  assert.equal((await dbNotes(cid))[0].row_version, 2);

  a.d.querySelector('#noteList button[data-act="signNote"]').click();
  await until(async () => (await dbNotes(cid))[0].status === 'signed', 'signed');
  assert.equal((await dbNotes(cid))[0].signer, 'nurse1');
  const signCall = a.fetched.find(f => /\/sign$/.test(f.path)); assert.deepEqual(JSON.parse(signCall.body), { rowVersion: 2 }, 'no signer is sent: the server uses the session');
  n = a.notes()[0]; assert.equal(n.status, 'signed'); assert.equal(n.signedBy, 'nurse1');
  assert.equal(a.d.querySelector('#noteList textarea'), null, 'a signed note has no text box');
  a.w.editNote(n.id, 'TAMPERED'); await wait(100);
  assert.equal((await dbNotes(cid))[0].body, 'SYNTH-NOTE edited draft');

  // amend: reason required, original kept
  a.w.toggleAmend(n.id);
  a.$('am_r_' + n.id).value = ''; a.$('am_b_' + n.id).value = 'SYNTH-NOTE amended'; a.w.submitAmend(n.id); await wait(100);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM case_note_amendments')).rows[0].n, 0, 'no reason, no amendment');
  a.$('am_r_' + n.id).value = 'Wrong side'; a.w.submitAmend(n.id);
  await until(async () => (await env.pool.query('SELECT count(*)::int n FROM case_note_amendments WHERE note_id = $1', [n.srvId])).rows[0].n === 1, 'amended');
  await until(() => a.notes()[0].amendments.length === 1, 'page shows the amendment');
  assert.equal((await dbNotes(cid))[0].body, 'SYNTH-NOTE edited draft', 'the original stays');
  assert.match(a.$('noteList').textContent, /reason: Wrong side/); assert.match(a.$('noteList').textContent, /Original \(as signed\)/);
  assert.equal((await env.pool.query('SELECT u.username FROM case_note_amendments m JOIN users u ON u.id = m.amended_by')).rows[0].username, 'nurse1');

  // nothing about the note is in the browser
  a.w.save(); a.w.interimWrite();
  assert.equal(a.ls('vr_traj'), null);
  assert.doesNotMatch(a.ls('vr_interim') || '', /SYNTH-NOTE|nurse1|Wrong side/);
  await a.close();
});

test('a second session sees the notes; another person\'s draft is read-only there; a viewer cannot write', async () => {
  const pid = await newPatient(), a = await openPage(); await a.login('nurse1'); await a.open(pid);
  const cid = a.ev('CASE.serverId'); await a.add('SYNTH-NOTE by nurse'); await a.add('SYNTH-NOTE second');
  const b = await openPage(); await b.login('doctor1'); await b.open(pid);
  assert.equal(b.notes().length, 2);
  assert.equal(b.d.querySelector('#noteList textarea'), null, 'no text box for a draft by someone else');
  assert.equal(b.d.querySelector('#noteList button[data-act="signNote"]'), null, 'no Sign button for someone else\'s draft');
  assert.match(b.$('noteList').textContent, /only the author can edit, sign or discard/);
  const id = b.notes()[0].id; await b.w.signNote(id); await wait(100);
  assert.deepEqual((await dbNotes(cid)).map(x => x.status), ['draft', 'draft'], 'the draft was not signed by the doctor');
  // the doctor writes their own and signs it; the nurse sees it signed by the doctor after reopening
  await b.add('SYNTH-NOTE by doctor'); await b.w.signNote(b.notes()[0].id);
  await until(async () => (await dbNotes(cid)).some(x => x.signer === 'doctor1'), 'doctor signed');
  const v = await openPage(); await v.login('viewer1'); await v.open(pid);
  assert.equal(v.notes().length, 3);
  assert.equal(v.d.querySelector('#noteList textarea'), null);
  await v.add('viewer text'); assert.equal((await dbNotes(cid)).length, 3, 'a viewer cannot add a note');
  assert.ok(v.d.querySelector('#noteList button[data-act="toggleAmend"]').disabled, 'a viewer cannot amend');
  await a.close(); await b.close(); await v.close();
});

test('a stale edit is refused: the notes reload, the text you typed stays on screen, marked as not saved', async () => {
  const pid = await newPatient(), a = await openPage(); await a.login('nurse1'); await a.open(pid);
  const cid = a.ev('CASE.serverId'); await a.add('SYNTH-NOTE v1');
  const b = await openPage(); await b.login('nurse1'); await b.open(pid);
  const ta = a.d.querySelector('#noteList textarea'); ta.value = 'SYNTH-NOTE from A'; ta.dispatchEvent(new a.w.Event('change', { bubbles: true }));
  await until(async () => (await dbNotes(cid))[0].body === 'SYNTH-NOTE from A', 'A saved');
  const tb = b.d.querySelector('#noteList textarea'); tb.value = 'SYNTH-NOTE from B'; tb.dispatchEvent(new b.w.Event('change', { bubbles: true }));
  await until(() => /Not saved/.test(b.$('noteList').textContent), 'conflict shown');
  assert.match(b.$('noteList').textContent, /SYNTH-NOTE from B/, 'the refused text is still on screen');
  assert.equal(b.d.querySelector('#noteList textarea').value, 'SYNTH-NOTE from A', 'the box shows the server text');
  assert.equal((await dbNotes(cid))[0].body, 'SYNTH-NOTE from A', 'the server kept the first save');
  await a.close(); await b.close();
});

test('sign right after an edit signs the edited text (the calls run in order); discard keeps the draft', async () => {
  const pid = await newPatient(), a = await openPage(); await a.login('nurse1'); await a.open(pid);
  const cid = a.ev('CASE.serverId'); await a.add('SYNTH-NOTE one'); await a.add('SYNTH-NOTE two');
  const [two, one] = a.notes();                                              // newest first
  a.w.editNote(one.id, 'SYNTH-NOTE one, edited'); a.w.signNote(one.id);      // no waiting between them
  a.w.discardNote(two.id);
  await until(async () => { const r = await dbNotes(cid); return r[0].status === 'signed' && r[1].status === 'discarded'; }, 'sign and discard done');
  const rows = await dbNotes(cid);
  assert.equal(rows[0].body, 'SYNTH-NOTE one, edited'); assert.equal(rows[1].body, 'SYNTH-NOTE two', 'the discarded draft is kept');
  assert.equal(a.notes().length, 2); assert.match(a.$('noteList').textContent, /Discarded by nurse1/);
  await a.close();
});

test('the page never sends an author, signer or amender, and nothing in it sets one', async () => {
  const pid = await newPatient(), a = await openPage(); await a.login('nurse1'); await a.open(pid);
  await a.add('SYNTH-NOTE x'); const n = a.notes()[0];
  a.w.localStorage.setItem('vr_user', 'Evil Stored'); const evil = a.d.createElement('input'); evil.id = 'n_user'; evil.value = 'Evil Typed'; a.d.body.appendChild(evil);
  await a.w.signNote(n.id); await a.w.signNote(a.notes()[0].id); await wait(100);
  for (const f of a.fetched.filter(f => /\/api\/(cases\/\d+\/notes|notes\/)/.test(f.path) && f.method !== 'GET')) assert.doesNotMatch(f.body, /author|signed|amend(ed)?By|Evil|nurse1/i, f.path);
  assert.equal(a.notes()[0].signedBy, 'nurse1');
  await a.close();
});
