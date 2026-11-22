'use strict';
// Task 8d-2: set version badges and Submit for review in the Library tab. Real page (jsdom) + real server + PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW, reviewers, approveVersion } = require('./helpers');

let env, R, admin, n = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }
const DEF = (title = 'Version me', extra = {}) => ({ title, fields: [{ id: 'a', label: 'A', type: 'text' }], ...extra });
test.after(async () => { if (env) await env.close(); });
async function reset() {
  if (env) await env.close();
  env = await setup(); R = await reviewers(env.base);
  admin = client(env.base); assert.equal((await admin.login('admin1')).status, 200);
}
async function mk(title, def = DEF(title)) {
  const r = await R.doctor.post('/api/element-sets', { slug: 'vp-' + (++n), kind: 'custom', definition: def });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.set.id;
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
  const ui = { w, d, fetched, $: id => d.getElementById(id), ev: s => w.eval(s),
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); },
    async openLib() { d.querySelector('[data-t=lib]').click(); await until(() => w.eval('VER.loaded'), 'versions loaded'); },
    box: () => ui.$('libVers'),
    rows: () => [...d.querySelectorAll('#libVers > .cd > div')].filter(r => r.querySelector('.bd')),
    rowOf: slugText => ui.rows().find(r => r.textContent.includes(slugText)),
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}

test('badges show each state; only a draft has a Submit button, and only for roles that can submit', async () => {
  await reset();
  const dr = await mk('A draft');
  const ir = await mk('In review'); assert.equal((await R.doctor.post(`/api/element-sets/${ir}/versions/1/submit`, {})).status, 200);
  const rj = await mk('Rejected'); await R.doctor.post(`/api/element-sets/${rj}/versions/1/submit`, {}); assert.equal((await R.inf1.post(`/api/element-sets/${rj}/versions/1/reject`, { reason: 'No' })).status, 200);
  const ap = await mk('Approved'); await approveVersion(R, ap, 1);
  const pb = await mk('Published'); await approveVersion(R, pb, 1); assert.equal((await admin.post(`/api/element-sets/${pb}/versions/1/publish`, {})).status, 200);
  const want = { 'A draft': ['local draft', 'draft'], 'In review': ['local draft', 'in review'], Rejected: ['local draft', 'rejected'], Approved: ['local reviewed', 'approved'], Published: ['local reviewed', 'published'] };
  for (const [user, canSubmit] of [['doctor1', true], ['admin1', true], ['nurse1', false], ['viewer1', false], ['informatician1', false]]) {
    const ui = await openPage(); await ui.login(user); await ui.openLib();
    assert.equal(ui.rows().length, 5, user);
    for (const [title, [tier, state]] of Object.entries(want)) {
      const r = ui.rowOf(title); assert.ok(r, user + ' ' + title);
      assert.ok(r.textContent.includes(tier) && r.textContent.includes('v1 · ' + state), `${user} ${title}: ${r.textContent}`);
      assert.equal(!!r.querySelector('button[data-act="verSubmit"]'), canSubmit && title === 'A draft', `${user} ${title} submit button`);
    }
    assert.match(ui.rowOf('Approved').textContent, /Approved and frozen/); assert.match(ui.rowOf('Published').textContent, /frozen/);
    await ui.close();
  }
  const out = await openPage(); await out.openLib().catch(() => {}); assert.equal(out.box().innerHTML, '', 'signed out: nothing'); await out.close();
});

test('Submit for review: sends an empty body; the server moves it to in review and records the submitter; the badge updates', async () => {
  await reset();
  const id = await mk('Submit me');
  const ui = await openPage(); await ui.login('doctor1'); await ui.openLib();
  const before = ui.fetched.length;
  ui.d.querySelector('#libVers button[data-act="verSubmit"]').click();
  await until(() => ui.fetched.slice(before).some(f => f.method === 'POST'), 'submit sent');
  const post = ui.fetched.slice(before).find(f => f.method === 'POST');
  assert.equal(post.path, `/api/element-sets/${id}/versions/1/submit`); assert.equal(post.body, '{}', 'no submitter, status or time is sent');
  await until(() => /v1 · in review/.test(ui.box().textContent), 'badge updated');
  assert.equal(ui.d.querySelector('#libVers button[data-act="verSubmit"]'), null);
  const v = (await env.pool.query(`SELECT v.status, u.username FROM element_set_versions v JOIN users u ON u.id = v.submitted_by WHERE v.element_set_id = $1`, [id])).rows[0];
  assert.deepEqual([v.status, v.username], ['in_review', 'doctor1']);
  await ui.close();
});

test('a set that fails the lint check is not submitted: the server findings are shown on the row, escaped; it stays a draft', async () => {
  await reset();
  const bad = 'Tom & "q" &amp; <b>';
  const id = await mk('Has a code', DEF('Has a code', { fields: [{ id: 'a', label: 'A', type: 'text', bindings: [{ system: 'loinc', code: '8867-4', display: bad.replace('<b>', '') }] }] }));
  const ui = await openPage(); await ui.login('doctor1'); await ui.openLib();
  ui.d.querySelector('#libVers button[data-act="verSubmit"]').click();
  await until(() => /unverified-code/.test(ui.box().textContent), 'findings shown');
  assert.match(ui.box().textContent, /must be fixed first/); assert.match(ui.box().textContent, /error unverified-code/);
  assert.ok(ui.d.querySelector('#libVers button[data-act="verSubmit"]'), 'still a draft with a Submit button');
  assert.equal((await env.pool.query('SELECT status FROM element_set_versions WHERE element_set_id = $1', [id])).rows[0].status, 'draft');
  await ui.close();
});

test('titles are shown as text; a viewer cannot submit (button absent, server also refuses)', async () => {
  await reset();
  const odd = 'Tom & "q" \'s\' &amp; &lt;b&gt;'; const id = await mk(odd);
  const ui = await openPage(); await ui.login('viewer1'); await ui.openLib();
  assert.ok(ui.box().textContent.includes(odd)); assert.ok(ui.box().innerHTML.includes('&amp;amp;'));
  assert.match(ui.box().textContent, /Your role cannot submit it/);
  assert.equal((await ui.w.verSubmit(`${id}:1`)), undefined);
  assert.equal(ui.fetched.filter(f => /submit/.test(f.path)).length, 0, 'no request is made');
  const v = await R.inf1.post(`/api/element-sets/${id}/versions/1/submit`, {}); assert.equal(v.status, 403);
  await ui.close();
});
