'use strict';
// Task B3b-1: applied sets in the page are server pins (exact published version). Apply, pathway apply, withdraw and the explicit update go
// through the server; the browser keeps no applied sets. Real page (jsdom) + real server + PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW, reviewers, approveVersion } = require('./helpers');

let env, R, admin, nurse, n = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }
const def = (title, ids) => ({ title, fields: ids.map(id => ({ id, label: id.toUpperCase(), type: 'text' })) });

test.before(async () => {
  env = await setup(); R = await reviewers(env.base);
  admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200);
  nurse = client(env.base); assert.equal((await nurse.login('nurse1')).status, 200);
});
test.after(async () => { await env.close(); });

async function publishedSet(slug, d) {
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: d });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return made.body.set.id;
}
async function newVersion(setId, d) {
  const v = await R.doctor.post(`/api/element-sets/${setId}/versions`, { definition: d });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  await approveVersion(R, setId, v.body.version.version);
  assert.equal((await admin.post(`/api/element-sets/${setId}/versions/${v.body.version.version}/publish`, {})).status, 200);
}
async function patient() {
  const r = await nurse.post('/api/patients', { name: 'Pin Patient ' + (++n), mrn: 'PIN-' + n, dob: '1980-01-01', sex: 'F' });
  assert.equal(r.status, 201); return r.body.patient.id;
}
async function openPage(confirmAnswer = true) {
  const jar = {}, fetched = [];
  const dom = await JSDOM.fromURL(env.base + '/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.confirm = () => confirmAnswer;
      w.fetch = async (path, o = {}) => {
        fetched.push({ path: String(path), method: o.method || 'GET', body: o.body || '' });
        const res = await fetch(env.base + path, { ...o, headers: { ...(o.headers || {}), ...(jar.c ? { cookie: jar.c } : {}) } });
        const sc = res.headers.get('set-cookie'); if (sc) jar.c = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
        return res;
      };
    } });
  const w = dom.window, d = w.document;
  const ui = { w, d, fetched, $: id => d.getElementById(id), ls: k => w.localStorage.getItem(k), ev: s => w.eval(s),
    posts: re => fetched.filter(f => f.method === 'POST' && re.test(f.path)),
    toast: () => ui.$('toast').textContent,
    chips: () => ui.$('appliedChips').textContent,
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); await until(() => w.eval('LIB.loaded'), 'library'); },
    async open(pid) { await w.ptOpenCase(pid); await until(() => w.eval('!!CASE.serverId && CASE.pinsOk === true'), 'case open'); },
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}
const pins = async ui => (await nurse.get(`/api/cases/${ui.ev('CASE.serverId')}/timeline`)).body.appliedSets;

test('apply pins the exact published version on the server; the browser keeps no applied sets; a new session gets the pin back', async () => {
  await publishedSet('pin-a', def('Pin A', ['pa']));
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p);
  a.w.applySet('pin-a'); await until(() => a.ev('CASE.applied.length') === 1, 'pinned');
  const sent = a.posts(/\/applied-sets$/); assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(sent[0].body)).sort(), ['setId', 'version']);   // no user, no time, no case data in the body
  const rows = await pins(a); assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, 'pin-a'); assert.equal(rows[0].version, 1); assert.equal(rows[0].state, 'active'); assert.equal(rows[0].applied_by, 'nurse1');
  assert.match(a.chips(), /Pin A v1/);                                       // the exact version is shown
  assert.match(a.d.querySelector('#appliedChips .chip').title, /Pinned v1, checksum [0-9a-f]{12}, applied by nurse1/);
  assert.ok(a.$('f_pa'), 'the pinned set shows its form');

  a.w.interimWrite();
  const im = JSON.parse(a.ls('vr_interim')); assert.ok(Object.keys(im.cases).length);
  Object.values(im.cases).forEach(c => assert.equal('applied' in c, false, 'no applied sets in vr_interim'));
  assert.doesNotMatch(a.ls('vr_interim'), /pin-a|Pin A/);
  assert.equal(a.ls('vr_traj'), null);

  const b = await openPage(); await b.login('doctor1'); await b.open(p);
  assert.equal(b.ev('CASE.applied.map(x=>x.setId+"@"+x.version).join()'), 'pin-a@1');
  assert.match(b.chips(), /Pin A v1/);
  await a.close(); await b.close();
});

test('a newer published version is only offered; the pin keeps its own fields from the server; the explicit update supersedes the old pin', async () => {
  const setId = await publishedSet('pin-b', def('Pin B', ['ba']));
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p);
  a.w.applySet('pin-b'); await until(() => a.ev('CASE.applied.length') === 1, 'pinned');
  await newVersion(setId, def('Pin B', ['ba', 'bb'])); await a.w.libLoad();
  assert.equal(a.ev('getSet("pin-b").version'), 2);
  a.w.renderAll();
  assert.match(a.chips(), /Pin B v1 ↑/);
  assert.ok(a.d.querySelector('[data-act="upgradeSet"]'), 'update is offered');
  assert.ok(a.$('f_ba') && !a.$('f_bb'), 'the case still shows version 1');
  assert.equal(a.posts(/\/applied-sets$/).length, 1, 'nothing was updated on its own');

  const b = await openPage(); await b.login('doctor1'); await b.open(p);      // a new session: library has v2, the pin is v1
  assert.equal(b.ev('getSet("pin-b").version'), 2);
  assert.equal(b.ev('resolve(CASE.applied[0]).fields.map(f=>f.id).join()'), 'ba', 'the old version is read from the server');
  assert.ok(b.$('f_ba') && !b.$('f_bb'));
  await b.close();

  a.w.upgradeSet('pin-b'); await until(() => a.ev('CASE.applied[0].version') === 2, 'updated');
  const rows = await pins(a);
  assert.deepEqual(rows.map(r => [r.version, r.state]), [[1, 'superseded'], [2, 'active']]);
  assert.equal(rows[1].supersedes_id, rows[0].id);
  assert.match(a.chips(), /Pin B v2/); assert.doesNotMatch(a.chips(), /↑/);
  assert.ok(a.$('f_bb'), 'the update shows the new field');
  assert.equal(a.d.querySelector('[data-act="upgradeSet"]'), null);
  await a.close();
});

test('a pathway pins each member that is in the server library; the others are skipped and said so; nothing is applied twice', async () => {
  await publishedSet('basic_emr', def('Basic EMR', ['pwa']));
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p);
  a.w.applySet('pw_basic'); await until(() => /skipped/.test(a.toast()), 'toast');
  assert.match(a.toast(), /Pathway applied: Basic admission.*1 set\(s\) are not in the server library/);
  assert.equal(a.posts(/\/applied-sets$/).length, 1);
  assert.deepEqual((await pins(a)).map(r => r.slug), ['basic_emr']);
  assert.match(a.$('pbanner').textContent, /Basic admission/);
  await publishedSet('vitals', def('Vitals', ['pwv'])); await a.w.libLoad();
  a.w.applySet('pw_basic'); await until(() => a.ev('CASE.applied.length') === 2, 'second member pinned');
  assert.equal(a.posts(/\/applied-sets$/).length, 2, 'basic_emr was not sent again');
  assert.deepEqual((await pins(a)).map(r => r.slug).sort(), ['basic_emr', 'vitals']);
  await a.close();
});

test('withdraw keeps the pin on the server; declining the confirmation changes nothing; the set can be applied again as a new pin', async () => {
  await publishedSet('pin-c', def('Pin C', ['pc']));
  const p = await patient(), a = await openPage(false); await a.login('nurse1'); await a.open(p);
  a.w.applySet('pin-c'); await until(() => a.ev('CASE.applied.length') === 1, 'pinned');
  await a.w.removeSet('pin-c');
  assert.equal(a.posts(/withdraw$/).length, 0); assert.equal(a.ev('CASE.applied.length'), 1);
  a.w.confirm = () => true;
  await a.w.removeSet('pin-c'); await until(() => a.ev('CASE.applied.length') === 0, 'withdrawn');
  assert.equal(a.posts(/withdraw$/).length, 1);
  assert.deepEqual((await pins(a)).map(r => r.state), ['withdrawn']);          // the pin row stays
  assert.ok(!a.$('f_pc'));
  a.w.applySet('pin-c'); await until(() => a.ev('CASE.applied.length') === 1, 'applied again');
  assert.deepEqual((await pins(a)).map(r => r.state), ['withdrawn', 'active']);
  await a.close();
});

test('refusals: no case open, a role that cannot write, a set that is not on the server, an archived case', async () => {
  await publishedSet('pin-d', def('Pin D', ['pd']));
  const p = await patient();
  // no case open
  const a = await openPage(); await a.login('nurse1');
  a.w.applySet('pin-d'); assert.match(a.toast(), /Open a patient/); assert.equal(a.posts(/applied-sets/).length, 0);
  await a.open(p);
  // a set that exists only in this browser (custom or generated) cannot be pinned
  a.ev('REGISTRY.push({id:"only_local",kind:"care",title:"Only local",fields:[{id:"ol",label:"OL",type:"text"}]})');
  a.w.applySet('only_local'); await until(() => /Not applied/.test(a.toast()), 'refusal toast');
  assert.equal(a.posts(/applied-sets/).length, 0); assert.equal(a.ev('CASE.applied.length'), 0);
  // an archived case: the server refuses and the page shows its message
  a.w.applySet('pin-d'); await until(() => a.ev('CASE.applied.length') === 1, 'pinned');
  const cid = a.ev('CASE.serverId'), cur = (await nurse.get(`/api/cases/${cid}`)).body.case;
  assert.equal((await nurse.patch(`/api/cases/${cid}/archive`, { rowVersion: cur.row_version, archived: true })).status, 200);
  await publishedSet('pin-e', def('Pin E', ['pe'])); await a.w.libLoad();
  a.w.applySet('pin-e'); await until(() => /Restore the case/.test(a.toast()), 'archived message');
  assert.equal(a.ev('CASE.applied.map(x=>x.setId).join()'), 'pin-d');
  await a.close();

  // a viewer reads the pins but has no apply, withdraw or update control, and the click does nothing
  const p2 = await patient(), w1 = await openPage(); await w1.login('nurse1'); await w1.open(p2);
  w1.w.applySet('pin-d'); await until(() => w1.ev('CASE.applied.length') === 1, 'pinned for viewer test'); await w1.close();
  const v = await openPage(); await v.login('viewer1'); await v.open(p2);
  assert.match(v.chips(), /Pin D v1/);
  assert.equal(v.d.querySelector('#appliedChips button'), null, 'no withdraw button for a viewer');
  v.w.applySet('pin-e'); assert.match(v.toast(), /cannot change cases/);
  await v.w.removeSet('pin-d'); assert.equal(v.posts(/applied-sets/).length, 0); assert.equal(v.ev('CASE.applied.length'), 1);
  await v.close();
});
