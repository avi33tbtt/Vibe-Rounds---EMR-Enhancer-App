'use strict';
// Task B2b-1: the Library tab reads published element sets from the server when signed in, and an admin can import the
// minimum demo library once, as published v1. Real page (jsdom) + real server + PostgreSQL.
// Pinning an exact version on a case, the diff and the explicit update are NOT here: they come with B3a/B3b.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW } = require('./helpers');

let env, admin;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }
const DEMO = ['basic_emr', 'glucose_ss', 'dka_ctx', 'snake_ctx'];

test.after(async () => { if (env) await env.close(); });
// The set tables are append-only (the database refuses DELETE and TRUNCATE), so every test starts from a freshly migrated database.
async function reset() {
  if (env) await env.close();
  env = await setup();
  admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200);
}

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
  const ui = { w, d, fetched, $: id => d.getElementById(id), ls: k => w.localStorage.getItem(k), ev: s => w.eval(s), evj: s => JSON.parse(w.eval('JSON.stringify(' + s + ')')),   // arrays from the page's realm, as plain data
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); },
    libText: () => { w.renderLib(); return d.getElementById('libSrv').textContent + ' ' + d.getElementById('libList').textContent; },
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}
const importBtn = ui => ui.d.querySelector('#libSrv button[data-act="libImport"]');
const setIds = ui => ui.evj('REGISTRY.filter(s=>s.srv).map(s=>s.id).sort()');

test('signed in with an empty server library: no demo built-ins are shown; only an admin is offered the import', async () => {
  await reset();
  for (const [user, canImport] of [['admin1', true], ['doctor1', false], ['nurse1', false], ['viewer1', false]]) {
    const ui = await openPage(); await ui.login(user);
    assert.deepEqual(ui.evj('REGISTRY.filter(s=>s.kind!=="pathway").map(s=>s.id)'), [], user + ': no demo built-ins while signed in');
    assert.match(ui.libText(), /read from the server/);
    assert.deepEqual([...ui.d.querySelectorAll('#libList .kind')].map(k => k.textContent).filter(t => t !== 'pathway'), [], user + ': only the static pathways are listed');
    assert.equal(!!importBtn(ui), canImport, user + ' import button');
    await ui.close();
  }
});

test('the admin imports the minimum demo library once: four sets, published v1 by the session user, then the offer is gone', async () => {
  await reset();
  const ui = await openPage(); await ui.login('admin1');
  const before = ui.fetched.length;
  importBtn(ui).click();
  await until(() => ui.ev('LIB.busy') === false && setIds(ui).length === 4, 'import finished');
  assert.deepEqual(setIds(ui), [...DEMO].sort());
  assert.equal(importBtn(ui), null, 'nothing left to import');
  const sent = ui.fetched.slice(before).filter(f => f.method === 'POST');
  assert.equal(sent.length, 8, 'one create and one publish per set');
  for (const f of sent) assert.doesNotMatch(f.body, /createdBy|publishedBy|published_by|author/i, 'no actor is sent in a body');

  const list = (await admin.get('/api/element-sets')).body.sets;
  assert.equal(list.length, 4);
  for (const s of list) assert.equal(s.published_version, 1);
  const v = (await admin.get(`/api/element-sets/${list[0].id}/versions/1`)).body.version;
  assert.equal(v.status, 'published'); assert.equal(v.published_by, 'admin1');
  assert.match(ui.$('libList').textContent, /server v1/);
  const aud = await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'set.publish'`);
  assert.equal(aud.rows[0].n, 4);

  // the codes the demo carried survive as bindings, and nothing outside the whitelist was sent
  const glu = ui.ev('JSON.stringify(REGISTRY.find(s=>s.id==="glucose_ss").fields[0])');
  assert.match(glu, /"system":"loinc".*"code":"2339-0"|"code":"2339-0".*"system":"loinc"/);
  assert.doesNotMatch(glu, /coding"|legacyCoding/);

  const calls = ui.fetched.length; await ui.w.libImport();
  assert.equal(ui.fetched.length, calls, 'a second import does nothing');
  await ui.close();
});

test('a slug that already exists on the server is left alone and reported; the others are still imported', async () => {
  await reset();
  const made = await admin.post('/api/element-sets', { slug: 'dka_ctx', kind: 'disease', definition: { title: 'Someone else’s DKA', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
  assert.equal(made.status, 201);   // a draft: not in the signed-in library
  const ui = await openPage(); await ui.login('admin1');
  importBtn(ui).click();
  await until(() => ui.ev('LIB.busy') === false && setIds(ui).length === 3, 'partial import');
  assert.deepEqual(setIds(ui), ['basic_emr', 'glucose_ss', 'snake_ctx']);
  assert.match(ui.$('libSrv').textContent, /already exists on the server/);
  const row = (await admin.get(`/api/element-sets/${made.body.set.id}`)).body;
  assert.equal(row.set.title, 'Someone else’s DKA'); assert.equal(row.versions.length, 1); assert.equal(row.versions[0].status, 'draft');
  await ui.close();
});

test('the library shows the latest published version; drafts are not shown; an older case entry is not changed', async () => {
  await reset();
  const mk = await admin.post('/api/element-sets', { slug: 'lib_one', kind: 'care', definition: { title: 'Lib one', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
  const id = mk.body.set.id;
  assert.equal((await admin.post(`/api/element-sets/${id}/versions/1/publish`)).status, 200);
  const ui = await openPage(); await ui.login('nurse1');
  assert.deepEqual(setIds(ui), ['lib_one']);
  assert.equal(ui.ev('getSet("lib_one").version'), 1);
  ui.ev("CASE.applied.push({setId:'lib_one',version:1,addedAt:new Date().toISOString(),fromPathway:null})");

  const v2 = await admin.post(`/api/element-sets/${id}/versions`, { definition: { title: 'Lib one', fields: [{ id: 'a', label: 'A', type: 'text' }, { id: 'b', label: 'B', type: 'text' }] } });
  assert.equal(v2.status, 201);
  await ui.w.libLoad();
  assert.equal(ui.ev('getSet("lib_one").version'), 1, 'a draft v2 is not shown');
  assert.equal((await admin.post(`/api/element-sets/${id}/versions/2/publish`)).status, 200);
  await ui.w.libLoad();
  assert.equal(ui.ev('getSet("lib_one").version'), 2);
  assert.equal(ui.ev('getSet("lib_one").fields.length'), 2);
  assert.equal(ui.ev('CASE.applied[0].version'), 1, 'the case entry still says v1 (exact pinning is B3a/B3b)');
  await ui.close();
});

test('server sets are read-only in the page and never copied into the browser', async () => {
  await reset();
  const mk = await admin.post('/api/element-sets', { slug: 'ro_set', kind: 'care', definition: { title: 'RO set', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
  await admin.post(`/api/element-sets/${mk.body.set.id}/versions/1/publish`);
  const ui = await openPage({ vr_traj: JSON.stringify({ cases: [], customs: [] }) }); const raw = ui.ls('vr_traj');
  await ui.login('doctor1');
  assert.deepEqual(setIds(ui), ['ro_set']);
  assert.doesNotMatch(ui.$('customList').textContent + (ui.w.renderCustomList(), ui.$('customList').textContent), /ro_set/, 'not listed as a custom set');
  ui.w.editCustom('ro_set');
  assert.equal(ui.$('c_id').value, '', 'edit form was not filled');
  ui.$('c_id').value = 'ro_set'; ui.$('c_title').value = 'Changed'; ui.$('c_kind').value = 'care';
  ui.w.addFieldRow({ id: 'z', label: 'Z', type: 'text' }); ui.w.saveElement();
  assert.equal(ui.ev('getSet("ro_set").title'), 'RO set', 'the server set was not overwritten');
  assert.equal(ui.ev('!!getSet("ro_set").srv'), true);
  ui.w.interimWrite();
  assert.doesNotMatch(ui.ls('vr_interim'), /ro_set/, 'no server set in vr_interim');
  assert.equal(ui.ls('vr_traj'), raw, 'vr_traj untouched while signed in');
  await ui.close();
});

test('a pathway applies only the members that are in the library and says how many were skipped', async () => {
  await reset();
  const ui = await openPage(); await ui.login('admin1');
  importBtn(ui).click(); await until(() => ui.ev('LIB.busy') === false && setIds(ui).length === 4, 'import');
  ui.ev('CASE.applied.length=0');
  ui.w.applySet('pw_basic');   // basic_emr + vitals; vitals is not in the library
  assert.deepEqual(ui.evj('CASE.applied.map(a=>a.setId)'), ['basic_emr']);
  assert.match(ui.$('toast').textContent, /1 set\(s\) are not in the library/);
  await ui.close();
});

test('text from the server is shown as text; sign-out brings back the local demo library', async () => {
  await reset();
  const bad = '5 < 6 & "quoted" \'single\' &amp; &lt;b&gt;';   // markup itself is refused by the server (lint); this checks that odd text is shown as typed, not decoded
  const mk = await admin.post('/api/element-sets', { slug: 'hostile', kind: 'care', definition: { title: bad, desc: bad, fields: [{ id: 'a', label: bad, type: 'text' }] } });
  assert.equal(mk.status, 201);
  await admin.post(`/api/element-sets/${mk.body.set.id}/versions/1/publish`);
  const ui = await openPage(); await ui.login('viewer1');
  ui.w.renderLib(); ui.w.renderAll();
  assert.ok(ui.$('libList').textContent.includes(bad));
  assert.ok(ui.$('libList').innerHTML.includes('&amp;amp;'), 'a typed &amp; was escaped, not decoded');

  await ui.w.srvLogout();
  assert.equal(ui.ev('Srv.user'), null);
  assert.ok(ui.ev('REGISTRY.some(s=>s.id==="vitals")'), 'demo built-ins are back when signed out');
  assert.equal(ui.ev('REGISTRY.some(s=>s.srv)'), false);
  assert.equal(ui.$('libSrv').innerHTML, '');
  await ui.close();
});
