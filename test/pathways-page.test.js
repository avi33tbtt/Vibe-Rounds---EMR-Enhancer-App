'use strict';
// Task B4b: pathways in the page. Signed in, the pathway library is the PUBLISHED pathways on the server (each step an exact set version);
// applying one is a single server call; every pin keeps its source pathway (the server's record) and can be withdrawn on its own;
// the admin can import the demo pathways once. Real page (jsdom) + real server + PostgreSQL.
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

async function publishedSet(slug, title = slug) {
  const made = await R.doctor.post('/api/element-sets', { slug, kind: 'custom', definition: def(title, ['f' + (++n)]) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await approveVersion(R, made.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${made.body.set.id}/versions/1/publish`, {})).status, 200);
  return made.body.set.id;
}
async function newSetVersion(setId) {
  const v = await R.doctor.post(`/api/element-sets/${setId}/versions`, { definition: def('Newer', ['g' + (++n)]) });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  await approveVersion(R, setId, v.body.version.version);
  assert.equal((await admin.post(`/api/element-sets/${setId}/versions/${v.body.version.version}/publish`, {})).status, 200);
}
async function pathway(slug, title, setIds, publish = true) {
  const made = await R.doctor.post('/api/pathways', { slug, title, description: 'About ' + title, steps: setIds.map(s => ({ setId: s, version: 1 })) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  if (publish) assert.equal((await admin.post(`/api/pathways/${made.body.pathway.id}/versions/1/publish`, {})).status, 200);
  return made.body.pathway.id;
}
async function patient() {
  const r = await nurse.post('/api/patients', { name: 'PwPage Patient ' + (++n), mrn: 'PWP-' + n, dob: '1980-01-01', sex: 'F' });
  assert.equal(r.status, 201); return r.body.patient.id;
}
async function openPage() {
  const jar = {}, fetched = [];
  const dom = await JSDOM.fromURL(env.base + '/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.confirm = () => true;
      w.fetch = async (path, o = {}) => {
        fetched.push({ path: String(path), method: o.method || 'GET', body: o.body || '' });
        const res = await fetch(env.base + path, { ...o, headers: { ...(o.headers || {}), ...(jar.c ? { cookie: jar.c } : {}) } });
        const sc = res.headers.get('set-cookie'); if (sc) jar.c = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
        return res;
      };
    } });
  const w = dom.window, d = w.document;
  const ui = { w, d, fetched, $: id => d.getElementById(id), ev: s => w.eval(s), evj: s => JSON.parse(w.eval('JSON.stringify(' + s + ')')),
    posts: re => fetched.filter(f => f.method === 'POST' && re.test(f.path)),
    toast: () => ui.$('toast').textContent,
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); await until(() => w.eval('LIB.loaded'), 'library'); },
    async open(pid) { await w.ptOpenCase(pid); await until(() => w.eval('!!CASE.serverId && CASE.pinsOk === true'), 'case open'); },
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}
const pins = async ui => (await nurse.get(`/api/cases/${ui.ev('CASE.serverId')}/timeline`)).body.appliedSets;

test('signed in, the library lists only published pathways with their exact set versions; sign-out brings back the demo list', async () => {
  const a = await publishedSet('pg-a', 'Set A'), b = await publishedSet('pg-b', 'Set B');
  await pathway('pg_pub', 'Published one', [a, b]);
  await pathway('pg_draft', 'Draft one', [a], false);
  const ui = await openPage();
  assert.ok(ui.ev('PATHWAYS.some(p=>p.id==="pw_dm")'), 'signed out: the demo pathways');
  await ui.login('viewer1');
  assert.deepEqual(ui.evj('PATHWAYS.map(p=>p.id)'), ['pg_pub'], 'a draft pathway is not in the library');
  assert.deepEqual(ui.evj('PATHWAYS[0].srvPw.steps'), [{ slug: 'pg-a', version: 1 }, { slug: 'pg-b', version: 1 }]);
  ui.w.renderLib();
  assert.match(ui.$('libList').textContent, /Published one/); assert.match(ui.$('libList').textContent, /pg-a v1, pg-b v1/);
  assert.equal(ui.d.querySelector('[data-act="libPwImport"]'), null, 'a viewer is not offered the import');
  await ui.w.srvLogout();
  assert.ok(ui.ev('PATHWAYS.some(p=>p.id==="pw_dm")'), 'demo pathways are back when signed out');
  await ui.close();
});

test('the pathway pins the exact versions it names, even after a set has a newer published version; the source survives a reload and a withdraw', async () => {
  const a = await publishedSet('pe-a', 'Exact A'), b = await publishedSet('pe-b', 'Exact B');
  await pathway('pe_path', 'Exact path', [a, b]);
  await newSetVersion(a);                                      // a is now at v2; the pathway version still names v1
  const p = await patient(), ui = await openPage(); await ui.login('nurse1'); await ui.open(p);
  ui.w.applySet('pe_path'); await until(() => ui.ev('CASE.applied.length') === 2, 'applied');
  assert.deepEqual(ui.evj('CASE.applied.map(x=>[x.setId,x.version,x.fromPathway,x.fromPathwayTitle,x.fromPathwayVersion])'),
    [['pe-a', 1, 'pe_path', 'Exact path', 1], ['pe-b', 1, 'pe_path', 'Exact path', 1]]);
  assert.equal(ui.posts(/\/applied-pathways$/).length, 1); assert.equal(ui.posts(/\/applied-sets$/).length, 0);
  assert.match(ui.$('forms').textContent, /via pathway Exact path v1/);
  // withdraw one set on its own: the other stays, and the server still records where both came from
  ui.w.removeSet('pe-b'); await until(() => ui.ev('CASE.applied.length') === 1, 'withdrawn');
  const rows = await pins(ui);
  assert.deepEqual(rows.map(r => [r.slug, r.state, r.from_pathway_slug]), [['pe-a', 'active', 'pe_path'], ['pe-b', 'withdrawn', 'pe_path']]);
  // a new page session reads the source back from the server
  const again = await openPage(); await again.login('nurse1'); await again.open(p);
  assert.deepEqual(again.evj('CASE.applied.map(x=>[x.setId,x.fromPathway,x.fromPathwayVersion])'), [['pe-a', 'pe_path', 1]]);
  // applying again adds only the withdrawn set and says what it left alone
  again.w.applySet('pe_path'); await until(() => again.ev('CASE.applied.length') === 2, 'reapplied');
  assert.match(again.toast(), /1 set\(s\) already on the case were left as they are: pe-a/);
  await ui.close(); await again.close();
});

test('a refusal from the server is shown and nothing is pinned: a retired member set, and a pathway that is not on the server', async () => {
  const a = await publishedSet('pr-a'), b = await publishedSet('pr-b');
  await pathway('pr_path', 'Retire path', [a, b]);
  const p = await patient(), ui = await openPage(); await ui.login('nurse1'); await ui.open(p);
  assert.equal((await admin.post(`/api/element-sets/${b}/versions/1/retire`, {})).status, 200);
  ui.w.applySet('pr_path'); await until(() => /Not applied/.test(ui.toast()), 'refused');
  assert.match(ui.toast(), /no longer published/); assert.equal(ui.ev('CASE.applied.length'), 0);
  assert.equal((await pins(ui)).length, 0);
  ui.w.applySet('pw_opd'); await until(() => /not in the server library/.test(ui.toast()), 'demo pathway not on the server');
  assert.equal(ui.posts(/\/applied-pathways$/).length, 1, 'the unknown pathway sent nothing');
  await ui.close();
});

test('a role that cannot write cannot apply a pathway; pathway text from the server is shown as text', async () => {
  const bad = 'Tom & "q" &amp; &lt;b&gt;';
  const a = await publishedSet('px-a');
  await pathway('px_path', bad, [a]);
  const p = await patient(), ui = await openPage(); await ui.login('viewer1');
  ui.w.renderLib(); ui.w.renderAll();
  assert.ok(ui.$('libList').textContent.includes(bad)); assert.ok(ui.$('libList').innerHTML.includes('&amp;amp;'), 'a typed &amp; is escaped, not decoded');
  assert.ok(ui.$('pathwayList').textContent.includes(bad));
  ui.w.applySet('px_path'); await wait(150);
  assert.equal(ui.posts(/applied-pathways/).length, 0, 'a viewer sends nothing');
  await ui.close(); void p;
});

test('only an admin is offered the demo pathway import; it publishes v1 of the ready ones only, once', async () => {
  await publishedSet('basic_emr', 'Basic EMR'); await publishedSet('vitals', 'Vitals');      // the sets of the demo pathway pw_basic; no other demo pathway has all its sets
  for (const user of ['doctor1', 'nurse1', 'viewer1']) {
    const ui = await openPage(); await ui.login(user);
    assert.equal(ui.d.querySelector('[data-act="libPwImport"]'), null, user + ' is not offered the import');
    await ui.close();
  }
  const ui = await openPage(); await ui.login('admin1');
  const btn = () => ui.d.querySelector('[data-act="libPwImport"]');
  assert.ok(btn()); assert.match(ui.$('libSrv').textContent, /Ready: Basic admission/);
  const before = ui.fetched.length; btn().click();
  await until(() => ui.ev('LIB.busy') === false && btn() === null, 'import');
  const sent = ui.fetched.slice(before).filter(f => f.method === 'POST');
  assert.deepEqual(sent.map(f => f.path.replace(/\/\d+\//, '/N/')), ['/api/pathways', '/api/pathways/N/versions/1/publish']);
  assert.doesNotMatch(sent.map(f => f.body).join(''), /createdBy|publishedBy|published_by|author/i, 'no actor is sent');
  assert.ok(ui.ev('PATHWAYS.some(p=>p.id==="pw_basic"&&p.srvPw.version===1)'));
  assert.equal((await admin.get('/api/pathways')).body.pathways.find(x => x.slug === 'pw_basic').published_version, 1);
  const calls = ui.fetched.length; await ui.w.libPwImport();
  assert.equal(ui.fetched.length, calls, 'a second import does nothing');
  await ui.close();
});
