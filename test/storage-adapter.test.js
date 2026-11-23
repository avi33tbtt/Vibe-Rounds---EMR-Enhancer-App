'use strict';
// Task B1b-1: storage adapter in the page. Signed in = cases, title, status and narrative live on the server and
// 'vr_traj' is never written; signed out / file:// = the local demo path, unchanged.
// Real page (jsdom) + real server + PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createApp } = require('../app');
const { setup, client, PW, reviewers, approveVersion } = require('./helpers');
const { pageHtml } = require('./html');

let env, api, pid, pid2;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }

test.before(async () => {
  env = await setup();
  api = client(env.base); assert.equal((await api.login('nurse1')).status, 200);
  pid = (await api.post('/api/patients', { name: 'Adapter Patient', mrn: 'AD-1', dob: '1970-03-04', sex: 'F' })).body.patient.id;
  pid2 = (await api.post('/api/patients', { name: 'Second Patient', mrn: 'AD-2', dob: '1982-07-09', sex: 'M' })).body.patient.id;
});
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
    tab: t => d.querySelector(`[data-t=${t}]`).click(),
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); },
    async open(patientId) { await w.ptOpenCase(patientId); await until(() => w.eval('!!CASE.serverId'), 'case open'); },
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}
const write = (ui, text) => { ui.$('narrative').value = text; ui.w.saveCase(); };

test('a case created in one session is listed and opened in a second; it survives an app restart', async () => {
  const a = await openPage(); await a.login('nurse1'); await a.open(pid);
  const id = a.ev('CASE.serverId');
  assert.equal(a.$('srvCaseBox').style.display, '');
  a.$('sc_title').value = 'Chest pain, day 2'; await a.w.caseSaveMeta();
  assert.equal(a.ev('CASE.title'), 'Chest pain, day 2');
  write(a, 'Synthetic narrative one'); await a.w.storeFlush();
  assert.equal(a.$('narSt').textContent, 'saved');

  const b = await openPage(); await b.login('doctor1'); b.tab('cases');
  await until(() => /Chest pain, day 2/.test(b.$('caseList').textContent), 'case listed in second session');
  assert.match(b.$('caseList').textContent, /Adapter Patient/);
  assert.match(b.$('caseList').textContent, /MRN AD-1/);
  await b.w.openCase('s' + id);
  assert.equal(b.$('narrative').value, 'Synthetic narrative one');
  assert.equal(b.$('sc_title').value, 'Chest pain, day 2');
  assert.equal(b.ev('CASE.rowVersion'), 2);
  await a.close(); await b.close();

  // restart: a fresh app instance on the same database, a brand-new client
  const server2 = createApp(env.appPool, { quiet: true }).listen(0, '127.0.0.1');
  await new Promise(r => server2.once('listening', r));
  try {
    const c = client(`http://127.0.0.1:${server2.address().port}`); assert.equal((await c.login('viewer1')).status, 200);
    const list = await c.get(`/api/patients/${pid}/cases`);
    assert.equal(list.body.cases.length, 1); assert.equal(list.body.cases[0].title, 'Chest pain, day 2');
    const one = await c.get(`/api/cases/${id}`);
    assert.equal(one.body.narrative.body, 'Synthetic narrative one'); assert.equal(one.body.narrative.author, 'nurse1');
  } finally { await new Promise(r => server2.close(r)); }
});

async function publishSet(slug) {   // a set the page can pin: created, approved by two informaticians, published by the admin
  const R = await reviewers(env.base), admin = client(env.base); await admin.login('admin1');
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'care', definition: { title: 'Adapter set', fields: [{ id: 'x', label: 'X', type: 'text' }] } });
  assert.equal(made.status, 201, JSON.stringify(made.body)); await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
}

test('signed in: vr_traj is never written; no case data (notes, applied sets, values) is kept in the browser; applied sets are server pins and values server observations that come back', async () => {
  await publishSet('adapter_set');
  const raw = JSON.stringify({ cases: [{ id: 'c_demo', patient: { name: 'Demo Only', mrn: 'D-0', age: '50', sex: 'M' }, narrative: 'demo narrative', applied: [], values: {}, notes: [], status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], current: 'c_demo', customs: [] });
  const a = await openPage({ vr_traj: raw });
  assert.match(a.$('pbanner').textContent, /Demo Only/);                    // signed out: the local demo case
  await a.login('nurse1');
  assert.doesNotMatch(a.$('pbanner').textContent, /Demo Only/);             // signed in: demo cases are not shown
  assert.match(a.$('encPanel').textContent, /No case is open/);
  await a.open(pid);
  const setId = 'adapter_set';   // published on the server above; applying it pins it there (B3b-1)
  a.w.applySet(setId); await until(() => a.ev('CASE.applied.length') === 1, 'pinned'); write(a, 'typed while signed in');
  a.w.setVal('x', 'value kept on the server', a.ev('CASE.applied[0].setId')); await until(() => a.ev('Object.keys(CASE.values).length') === 1, 'value stored');   // a server observation since B3b-2
  a.ev("save()"); await a.w.storeFlush();
  assert.equal(a.ls('vr_traj'), raw, 'vr_traj must be byte-for-byte untouched while signed in');
  const interim = JSON.parse(a.ls('vr_interim'));
  assert.equal('cases' in interim, false, 'no per-case data (notes, applied sets, values) is kept in the browser'); assert.doesNotMatch(a.ls('vr_interim'), /value kept on the server/);
  assert.doesNotMatch(a.ls('vr_interim'), /Adapter Patient|AD-1/);          // identity is not copied into the browser
  assert.ok(interim._temporary);
  const keys = Object.keys(a.w.localStorage).filter(k => /^vr_/.test(k)).sort();
  assert.ok(!keys.includes('vr_traj_pre_bindings'));

  // sign out: the demo case is back, and still untouched
  await a.w.srvLogout(); await until(() => !a.ev('Srv.user'), 'logout');
  assert.match(a.$('pbanner').textContent, /Demo Only/);
  assert.equal(a.ls('vr_traj'), raw);
  const saved = a.ls('vr_interim'); await a.close();

  // a later session (same browser storage) gets the pin from the server and the interim data from the browser
  const b = await openPage({ vr_interim: saved, vr_traj: raw }); await b.login('nurse1'); await b.open(pid);
  assert.equal(b.ev('CASE.applied.length'), 1); assert.equal(b.ev('CASE.applied[0].setId'), setId); assert.equal(b.ev('CASE.values[CASE.applied[0].srvSet + ":x"]'), 'value kept on the server');
  assert.equal(b.ev('CASE.narrative'), 'typed while signed in');           // narrative comes from the server, not the browser
  assert.equal(b.ls('vr_traj'), raw);
  await b.close();
});

test('demo mode still works: offline page and signed-out page save to vr_traj as before', async () => {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', url: 'http://127.0.0.1:1/', pretendToBeVisual: true,
    beforeParse(w) { w.fetch = async () => { throw new Error('down'); }; w.confirm = () => true; } });
  const w = dom.window, d = w.document; await wait(150);
  d.getElementById('narrative').value = 'offline narrative'; w.saveCase();
  w.newCase(); d.getElementById('narrative').value = 'second demo case'; w.saveCase();
  const saved = JSON.parse(w.localStorage.getItem('vr_traj'));
  assert.equal(saved.cases.length, 2);
  assert.deepEqual(saved.cases.map(c => c.narrative).sort(), ['offline narrative', 'second demo case']);
  assert.equal(w.localStorage.getItem('vr_interim'), null);
  assert.equal(d.getElementById('srvCaseBox').style.display, 'none');
  await wait(250); w.close();

  const s = await openPage();                                              // real server, nobody signed in
  write(s, 'signed-out text'); assert.equal(JSON.parse(s.ls('vr_traj')).cases.find(c => c.narrative === 'signed-out text').narrative, 'signed-out text');
  assert.ok(!s.fetched.some(f => /\/api\/cases/.test(f.path)), 'signed out: no case request is sent');
  await s.close();
});

test('409: a stale title/status change shows the conflict screen; reload and keep-mine are explicit choices', async () => {
  const a = await openPage(); await a.login('nurse1'); await a.open(pid2);
  const id = a.ev('CASE.serverId'), other = client(env.base); await other.login('doctor1');
  let rv = a.ev('CASE.rowVersion');
  assert.equal((await other.patch(`/api/cases/${id}`, { title: 'Theirs 1', rowVersion: rv })).status, 200);

  a.$('sc_title').value = 'Mine 1'; await a.w.caseSaveMeta();
  assert.equal(a.$('conflictBox').style.display, 'block');
  assert.match(a.$('conflictBox').textContent, /changed by someone else/); assert.match(a.$('conflictBox').textContent, /Mine 1/);
  assert.equal((await env.pool.query('SELECT title FROM clinical_cases WHERE id = $1', [id])).rows[0].title, 'Theirs 1', 'nothing was overwritten');
  await a.w.conflictReload();
  assert.equal(a.$('conflictBox').style.display, 'none'); assert.equal(a.$('sc_title').value, 'Theirs 1');
  assert.equal((await env.pool.query('SELECT title FROM clinical_cases WHERE id = $1', [id])).rows[0].title, 'Theirs 1');

  rv = a.ev('CASE.rowVersion');
  assert.equal((await other.patch(`/api/cases/${id}`, { title: 'Theirs 2', rowVersion: rv })).status, 200);
  a.$('sc_title').value = 'Mine 2'; a.$('sc_status').value = 'resolved'; await a.w.caseSaveMeta();
  assert.equal(a.$('conflictBox').style.display, 'block');
  await a.w.conflictKeep();
  assert.equal(a.$('conflictBox').style.display, 'none');
  const row = (await env.pool.query('SELECT title, status, row_version FROM clinical_cases WHERE id = $1', [id])).rows[0];
  assert.equal(row.title, 'Mine 2'); assert.equal(row.status, 'resolved'); assert.equal(row.row_version, rv + 2);
  assert.equal(a.ev('CASE.rowVersion'), row.row_version);
  const rej = (await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'case.update_rejected' AND entity_id = $1`, [String(id)])).rows[0].n;
  assert.equal(rej, 2);

  // the same screen guards archive
  const rv2 = a.ev('CASE.rowVersion');
  assert.equal((await other.patch(`/api/cases/${id}`, { title: 'Theirs 3', rowVersion: rv2 })).status, 200);
  await a.w.archiveCase();
  assert.equal(a.$('conflictBox').style.display, 'block'); assert.match(a.$('conflictBox').textContent, /archive this case/);
  assert.equal((await env.pool.query('SELECT status FROM clinical_cases WHERE id = $1', [id])).rows[0].status, 'resolved');
  await a.close();
});

test('archive and restore go through the server; archived cases appear only under show archived', async () => {
  const a = await openPage(); await a.login('doctor1'); await a.open(pid2);
  const id = a.ev('CASE.serverId');
  await a.w.archiveCase();
  assert.equal((await env.pool.query('SELECT status FROM clinical_cases WHERE id = $1', [id])).rows[0].status, 'archived');
  assert.equal(a.ev('!!CASE.serverId') ? a.ev('CASE.id') !== 's' + id : true, true);   // another case or the empty placeholder is now open
  a.tab('cases'); await until(() => !/Second Patient/.test(a.$('caseList').textContent), 'archived case hidden');
  a.$('caseArch').checked = true; a.$('caseArch').dispatchEvent(new a.w.Event('change', { bubbles: true }));
  await until(() => /Second Patient/.test(a.$('caseList').textContent), 'archived case shown');
  assert.match(a.$('caseList').innerHTML, /data-act="restoreCase"/);
  await a.w.restoreCase('s' + id);
  assert.equal((await env.pool.query('SELECT status FROM clinical_cases WHERE id = $1', [id])).rows[0].status, 'active');
  await a.close();
});

test('narrative: saved after a pause, entries are append-only, an empty text is never sent', async () => {
  const a = await openPage(); await a.login('nurse1'); await a.open(pid);
  const id = a.ev('CASE.serverId'), n = async () => (await env.pool.query('SELECT count(*)::int AS n FROM case_narrative_entries WHERE case_id = $1', [id])).rows[0].n;
  const before = await n();
  write(a, 'Draft A'); write(a, 'Draft AB'); write(a, 'Draft ABC');
  assert.equal(await n(), before, 'typing alone sends nothing');
  await until(async () => (await n()) === before + 1, 'saved after the pause');
  assert.equal((await env.pool.query('SELECT body FROM case_narrative_entries WHERE case_id = $1 ORDER BY id DESC LIMIT 1', [id])).rows[0].body, 'Draft ABC');
  await a.w.storeFlush(); assert.equal(await n(), before + 1, 'unchanged text is not sent again');
  const posts = () => a.fetched.filter(f => f.method === 'POST' && /narrative/.test(f.path)).length, p0 = posts();
  write(a, '   '); await a.w.storeFlush(); assert.equal(posts(), p0, 'blank text is not sent');
  write(a, 'Draft D'); await a.w.storeFlush(); assert.equal(await n(), before + 2);
  await a.close();
});

test('viewer: can read cases, cannot change or create; the screen says so', async () => {
  const a = await openPage(); await a.login('viewer1'); await a.open(pid);
  assert.equal(a.$('sc_save').disabled, true); assert.equal(a.$('sc_title').disabled, true);
  assert.match(a.$('sc_info').textContent, /not change/);
  const count = async () => (await env.pool.query('SELECT count(*)::int AS n FROM clinical_cases')).rows[0].n, c0 = await count();
  const p3 = (await api.post('/api/patients', { name: 'No Case Yet', mrn: 'AD-3', dob: '1990-01-01', sex: 'U' })).body.patient.id;
  await a.w.ptOpenCase(p3); await wait(150);
  assert.equal(await count(), c0, 'a viewer opening a patient creates no case');
  await a.close();
});

test('a hostile case title is shown as text, never as markup', async () => {
  const a = await openPage(); await a.login('nurse1'); await a.open(pid);
  a.$('sc_title').value = '<img src=x onerror="window.__x=1">'; await a.w.caseSaveMeta();
  a.tab('cases'); await until(() => /onerror/.test(a.$('caseList').textContent), 'title listed');
  assert.equal(a.$('caseList').querySelector('img'), null); assert.equal(a.w.__x, undefined);
  await a.close();
});
