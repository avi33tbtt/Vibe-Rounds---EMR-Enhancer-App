'use strict';
// Task B2b-1 (changed by 8c-2): the Library tab reads published element sets from the server when signed in. An admin or doctor can
// send the demo library for review once (created as v1 and submitted, without codes); it shows in the library only after an
// informatician approves it and an admin publishes it. Real page (jsdom) + real server + PostgreSQL.
// Pinning an exact version on a case, the diff and the explicit update are NOT here: they come with B3a/B3b.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW, reviewers, approveVersion } = require('./helpers');

let env, admin, R;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }
const DEMO = ['basic_emr', 'glucose_ss', 'dka_ctx', 'snake_ctx', 'vitals', 'opd_visit', 'ipd_admission', 'ipd_progress', 'ipd_discharge',
  'cc_fever', 'cc_cough', 'cc_abdo', 'cc_headache', 'cc_chest', 'cc_joint', 'ex_general', 'ex_cvs', 'ex_resp', 'ex_abdomen', 'ex_neuro'];   // R1a: the six OPD complaint sets travel with the demo import

test.after(async () => { if (env) await env.close(); });
// The set tables are append-only (the database refuses DELETE and TRUNCATE), so every test starts from a freshly migrated database.
async function reset() {
  if (env) await env.close();
  env = await setup();
  admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200);
  R = await reviewers(env.base);
}
// 8c-2: nothing is published without review. These helpers do what the people would do: submit, approve, publish.
async function pub(id, v = 1) { await approveVersion(R, id, v); const r = await admin.post(`/api/element-sets/${id}/versions/${v}/publish`); assert.equal(r.status, 200, JSON.stringify(r.body)); }
async function reviewAndPublishAll() { for (const s of (await admin.get('/api/element-sets')).body.sets) await pub(s.id); }

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
const pwBtn = ui => ui.d.querySelector('#libSrv button[data-act="libPwImport"]');
const importBtn = ui => ui.d.querySelector('#libSrv button[data-act="libImport"]');
const setIds = ui => ui.evj('REGISTRY.filter(s=>s.srv).map(s=>s.id).sort()');

test('signed in with an empty server library: no demo built-ins are shown; only an admin or a doctor is offered the import', async () => {
  await reset();
  for (const [user, canImport] of [['admin1', true], ['doctor1', true], ['nurse1', false], ['viewer1', false]]) {
    const ui = await openPage(); await ui.login(user);
    assert.deepEqual(ui.evj('REGISTRY.filter(s=>s.kind!=="pathway").map(s=>s.id)'), [], user + ': no demo built-ins while signed in');
    assert.match(ui.libText(), /read from the server/);
    assert.deepEqual([...ui.d.querySelectorAll('#libList .kind')].map(k => k.textContent).filter(t => t !== 'pathway'), [], user + ': only the static pathways are listed');
    assert.equal(!!importBtn(ui), canImport, user + ' import button');
    await ui.close();
  }
});

test('the admin sends the demo library for review once: v1 created and submitted (no codes), not published; then the offer is gone', async () => {
  await reset();
  const ui = await openPage(); await ui.login('admin1');
  const before = ui.fetched.length;
  importBtn(ui).click();
  await until(() => ui.ev('LIB.busy') === false && importBtn(ui) === null, 'import finished');
  assert.deepEqual(setIds(ui), [], 'not in the library: nothing is published without review');
  const sent = ui.fetched.slice(before).filter(f => f.method === 'POST');
  assert.equal(sent.length, 2 * DEMO.length, 'one create and one submit per set, no publish');
  assert.equal(sent.filter(f => /\/publish/.test(f.path)).length, 0);
  for (const f of sent) assert.doesNotMatch(f.body, /createdBy|publishedBy|submittedBy|published_by|author/i, 'no actor is sent in a body');
  assert.doesNotMatch(sent.map(f => f.body).join(''), /bindings/, 'no codes are sent');
  assert.match(ui.$('libSrv').textContent, /submitted for review/);

  const list = (await admin.get('/api/element-sets')).body.sets;
  assert.equal(list.length, DEMO.length);
  for (const s of list) { assert.equal(s.published_version, null); assert.equal(s.latest_version, 1); }
  const v = (await admin.get(`/api/element-sets/${list[0].id}/versions/1`)).body.version;
  assert.equal(v.status, 'in_review'); assert.equal(v.published_by, null);
  const n = async a => (await env.pool.query('SELECT count(*)::int AS n FROM audit_log WHERE action = $1', [a])).rows[0].n;
  assert.equal(await n('set.submit'), DEMO.length); assert.equal(await n('set.publish'), 0);

  // review and publish are done by people with those roles; then the sets appear in the library, as read-only server sets
  await reviewAndPublishAll(); await ui.w.libLoad();
  assert.deepEqual(setIds(ui), [...DEMO].sort());
  assert.match(ui.$('libList').textContent, /server v1/);
  assert.equal(importBtn(ui), null);

  const calls = ui.fetched.length; await ui.w.libImport();
  assert.equal(ui.fetched.length, calls, 'a second import does nothing');
  await ui.close();
});

test('a slug that already exists on the server is left alone (and not offered again); the others are still submitted', async () => {
  await reset();
  const made = await admin.post('/api/element-sets', { slug: 'dka_ctx', kind: 'disease', definition: { title: 'Someone else’s DKA', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
  assert.equal(made.status, 201);   // a draft: not in the signed-in library
  const ui = await openPage(); await ui.login('admin1');
  assert.deepEqual(ui.evj('[...LIB.slugs]'), ['dka_ctx']);
  importBtn(ui).click();
  await until(() => ui.ev('LIB.busy') === false && importBtn(ui) === null, 'partial import');
  const states = Object.fromEntries((await env.pool.query('SELECT s.slug, v.status FROM element_sets s JOIN element_set_versions v ON v.element_set_id = s.id')).rows.map(r => [r.slug, r.status]));
  for (const id of DEMO) assert.equal(states[id], id === 'dka_ctx' ? 'draft' : 'in_review', id);
  const row = (await admin.get(`/api/element-sets/${made.body.set.id}`)).body;
  assert.equal(row.set.title, 'Someone else’s DKA'); assert.equal(row.versions.length, 1); assert.equal(row.versions[0].status, 'draft');
  await ui.close();
});

test('the library shows the latest published version; drafts are not shown; an older case entry is not changed', async () => {
  await reset();
  const mk = await admin.post('/api/element-sets', { slug: 'lib_one', kind: 'care', definition: { title: 'Lib one', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
  const id = mk.body.set.id;
  await pub(id);
  const ui = await openPage(); await ui.login('nurse1');
  assert.deepEqual(setIds(ui), ['lib_one']);
  assert.equal(ui.ev('getSet("lib_one").version'), 1);
  ui.ev("CASE.applied.push({setId:'lib_one',version:1,addedAt:new Date().toISOString(),fromPathway:null})");

  const v2 = await admin.post(`/api/element-sets/${id}/versions`, { definition: { title: 'Lib one', fields: [{ id: 'a', label: 'A', type: 'text' }, { id: 'b', label: 'B', type: 'text' }] } });
  assert.equal(v2.status, 201);
  await ui.w.libLoad();
  assert.equal(ui.ev('getSet("lib_one").version'), 1, 'a draft v2 is not shown');
  await pub(id, 2);
  await ui.w.libLoad();
  assert.equal(ui.ev('getSet("lib_one").version'), 2);
  assert.equal(ui.ev('getSet("lib_one").fields.length'), 2);
  assert.equal(ui.ev('CASE.applied[0].version'), 1, 'the case entry still says v1 (exact pinning is B3a/B3b)');
  await ui.close();
});

test('server sets are read-only in the page and never copied into the browser', async () => {
  await reset();
  const mk = await admin.post('/api/element-sets', { slug: 'ro_set', kind: 'care', definition: { title: 'RO set', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
  await pub(mk.body.set.id);
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

test('the admin imports the demo pathways once, only those whose sets are published; applying one pins its exact versions', async () => {   // B4b: replaces the client-side member list
  await reset();
  const ui = await openPage(); await ui.login('admin1');
  importBtn(ui).click(); await until(() => ui.ev('LIB.busy') === false && importBtn(ui) === null, 'import');
  assert.equal(pwBtn(ui), null, 'no pathway is ready while no set is published');
  assert.match(ui.$('libSrv').textContent, /Waiting for their sets to be published/);
  await reviewAndPublishAll(); await ui.w.libLoad();
  assert.equal(setIds(ui).length, DEMO.length);
  assert.ok(pwBtn(ui), 'the import is offered once the sets are published');
  pwBtn(ui).click(); await until(() => ui.ev('LIB.busy') === false && pwBtn(ui) === null, 'pathway import');
  // pw_dm and pw_dm_ckd_foot name sets the demo import never sends (dm_ctx, hba1c_mon...): they wait; the others are published as v1
  assert.deepEqual(ui.evj('PATHWAYS.map(p=>p.id)'), ['pw_basic', 'pw_dka', 'pw_ipd', 'pw_ipd_discharge', 'pw_opd', 'pw_snake']);
  assert.match(ui.$('libSrv').textContent, /Waiting for their sets/);
  const list = (await admin.get('/api/pathways')).body.pathways;
  assert.ok(list.every(p => p.published_version === 1));
  assert.equal(ui.ev('PATHWAYS.every(p=>p.srvPw&&p.srvPw.steps.length===p.members.length)'), true);
  assert.match(ui.$('libList').textContent, /basic_emr v1, vitals v1/);
  const calls = ui.fetched.length; await ui.w.libPwImport();
  assert.equal(ui.fetched.length, calls, 'a second import does nothing');
  const pid = (await admin.post('/api/patients', { name: 'Pathway Patient', mrn: 'PW-1', dob: '1980-01-01', sex: 'F' })).body.patient.id;
  await ui.w.ptOpenCase(pid); await until(() => ui.ev('!!CASE.serverId && CASE.pinsOk === true'), 'case open');
  ui.w.applySet('pw_basic');
  await until(() => ui.ev('CASE.applied.length') === 2, 'members pinned');
  assert.deepEqual(ui.evj('CASE.applied.map(a=>[a.setId,a.version,a.fromPathway])'), [['basic_emr', 1, 'pw_basic'], ['vitals', 1, 'pw_basic']]);
  assert.match(ui.$('toast').textContent, /Pathway applied: Basic admission v1/);
  await ui.close();
});

test('text from the server is shown as text; sign-out brings back the local demo library', async () => {
  await reset();
  const bad = 'Tom & "quoted" \'single\' &amp; &lt;b&gt;';   // markup itself is refused by the server (lint), and a number with a comparison trips the dose rule; this checks that odd text is shown as typed, not decoded
  const mk = await admin.post('/api/element-sets', { slug: 'hostile', kind: 'care', definition: { title: bad, desc: bad, fields: [{ id: 'a', label: bad, type: 'text' }] } });
  assert.equal(mk.status, 201);
  await pub(mk.body.set.id);
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
