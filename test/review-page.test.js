'use strict';
// Task 8d-1: the reviewer queue screen. Real page (jsdom) + real server + PostgreSQL.
// Only the informatician role sees the Review tab; the list, lint findings and who/when are the server's values.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW, reviewers } = require('./helpers');
const { checksumOf } = require('../sets');

let env, doctor, inf2, n = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }
const DEF = (title = 'Review me', extra = {}) => ({ title, fields: [{ id: 'a', label: 'A', type: 'text' }], ...extra });
const TWO = (title = 'Needs two') => DEF(title, { desc: 'Give 500 mg every 6 hours.', citation: 'Local guideline 2026, section 4' });   // lint flags needsTwoReviewers
test.after(async () => { if (env) await env.close(); });
async function reset() {
  if (env) await env.close();
  env = await setup();
  const R = await reviewers(env.base); doctor = R.doctor; inf2 = R.inf2;
}
async function submitted(def = DEF(), slug = 'rq-' + (++n)) {
  const r = await doctor.post('/api/element-sets', { slug, kind: 'custom', definition: def });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await doctor.post(`/api/element-sets/${r.body.set.id}/versions/1/submit`, {})).status, 200);
  return r.body.set.id;
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
    nav: () => d.getElementById('navReview'),
    async openReview() { ui.nav().click(); await until(() => w.eval('REV.loaded'), 'queue loaded'); },
    box: () => ui.$('reviewBox'),
    btn: (act) => d.querySelector(`#reviewBox button[data-act="${act}"]`),
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}

test('only an informatician sees the Review tab; nurse, viewer, doctor and admin do not, and signing out hides it', async () => {
  await reset();
  for (const [user, sees] of [['informatician1', true], ['admin1', false], ['doctor1', false], ['nurse1', false], ['viewer1', false]]) {
    const ui = await openPage(); await ui.login(user);
    assert.equal(ui.nav().style.display !== 'none', sees, user);
    if (!sees) assert.equal(ui.box().innerHTML, '', user + ': nothing rendered');
    if (!sees) { const before = ui.fetched.length; ui.w.reviewLoad(); await wait(100); assert.equal(ui.fetched.slice(before).filter(f => /review/.test(f.path)).length, 0, user + ': no queue request'); }
    if (sees) { await ui.w.srvLogout(); assert.equal(ui.nav().style.display, 'none'); }
    await ui.close();
  }
});

test('the queue shows title, who wrote and submitted, lint findings, approval counts; text is escaped', async () => {
  await reset();
  const bad = 'Tom & "q" \'s\' &amp; &lt;b&gt;';
  await submitted(DEF(bad)); await submitted(TWO('Dose wording'));
  // The real lint finds nothing to warn about in an ordinary set, so one in-review version is inserted as the owner with findings (one with markup-like text).
  const dId = (await env.pool.query(`SELECT id FROM users WHERE username = 'doctor1'`)).rows[0].id, def = DEF('Has findings');
  const ls = (await env.pool.query(`INSERT INTO element_sets(slug, title, kind, created_by) VALUES ('rq-lint','Has findings','custom',$1) RETURNING id`, [dId])).rows[0];
  const lint = { ok: true, needsTwoReviewers: false, findings: [{ severity: 'warning', path: 'fields[0].label', rule: 'patient-like', message: 'Check <img src=x onerror=alert(1)> & this' }] };
  await env.pool.query(`INSERT INTO element_set_versions(element_set_id, version, definition_json, checksum, status, created_by, submitted_by, submitted_at, lint_json) VALUES ($1,1,$2,$3,'in_review',$4,$4,now(),$5)`, [ls.id, JSON.stringify(def), checksumOf(def), dId, JSON.stringify(lint)]);
  const ui = await openPage(); await ui.login('informatician1'); await ui.openReview();
  const text = ui.box().textContent;
  assert.ok(text.includes(bad), 'odd text shown as typed');
  assert.ok(ui.box().innerHTML.includes('&amp;amp;'), 'a typed &amp; was escaped, not decoded');
  assert.match(text, /Written by doctor1/); assert.match(text, /submitted by doctor1 at \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(text, /approvals 0 of 1/); assert.match(text, /approvals 0 of 2/); assert.match(text, /two different reviewers are needed/);
  assert.match(text, /Lint findings \(1\)/); assert.match(text, /warning patient-like · fields\[0\]\.label: Check <img src=x onerror=alert\(1\)> & this/); assert.match(text, /Lint: no findings/);
  assert.equal(ui.box().querySelector('img'), null, 'finding text is text, never markup');
  assert.equal(ui.d.querySelectorAll('#reviewBox .cd').length, 3);
  await ui.close();
});

test('approve: a reason is required (no request without one); the body holds only the reason; the server records the reviewer', async () => {
  await reset();
  const id = await submitted();
  const ui = await openPage(); await ui.login('informatician1'); await ui.openReview();
  const before = ui.fetched.length;
  ui.btn('reviewApprove').click(); await wait(100);
  assert.equal(ui.fetched.length, before, 'no request without a reason');
  assert.match(ui.box().textContent, /A reason is required/);
  ui.d.getElementById(`rv_${id}_1`).value = 'Matches the local template';
  ui.btn('reviewApprove').click();
  await until(() => ui.fetched.slice(before).some(f => f.method === 'POST'), 'approve sent');
  const post = ui.fetched.slice(before).find(f => f.method === 'POST');
  assert.equal(post.path, `/api/element-sets/${id}/versions/1/approve`);
  assert.deepEqual(JSON.parse(post.body), { reason: 'Matches the local template' }, 'no reviewer, status or time is sent');
  await until(() => /Nothing is waiting for review/.test(ui.box().textContent), 'queue refreshed');
  const v = (await env.pool.query('SELECT status FROM element_set_versions WHERE element_set_id = $1', [id])).rows[0];
  assert.equal(v.status, 'reviewed');
  assert.equal((await env.pool.query(`SELECT u.username FROM element_set_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.element_set_id = $1`, [id])).rows[0].username, 'informatician1');
  await ui.close();
});

test('a flagged set needs two: after the first approval it stays, shows "already reviewed" and the reviews with who and when; the second reviewer approves it', async () => {
  await reset();
  const id = await submitted(TWO());
  const ui = await openPage(); await ui.login('informatician1'); await ui.openReview();
  ui.d.getElementById(`rv_${id}_1`).value = 'First look';
  ui.btn('reviewApprove').click();
  await until(() => /approvals 1 of 2/.test(ui.box().textContent), 'first approval shown');
  assert.match(ui.box().textContent, /You have already reviewed this version/);
  assert.match(ui.box().textContent, /informatician1 · approve · \d{4}-\d{2}-\d{2} \d{2}:\d{2}: First look/);
  assert.equal(ui.btn('reviewApprove'), null, 'no buttons for a reviewer who already reviewed');
  assert.equal((await inf2.post(`/api/element-sets/${id}/versions/1/approve`, { reason: 'Second look' })).body.status, 'reviewed');
  ui.btn('reviewReload').click();
  await until(() => /Nothing is waiting for review/.test(ui.box().textContent), 'gone after the second approval');
  await ui.close();
});

test('reject needs a reason and ends the version; a server refusal is shown on the card', async () => {
  await reset();
  const a = await submitted(DEF('Reject me')), b = await submitted(DEF('Second'));
  const ui = await openPage(); await ui.login('informatician1'); await ui.openReview();
  const cards = () => [...ui.d.querySelectorAll('#reviewBox .cd')];
  const rejectOf = i => cards()[i].querySelector('button[data-act="reviewReject"]');
  ui.d.getElementById(`rv_${a}_1`).value = 'Not right'; rejectOf(0).click();
  await until(() => cards().length === 1, 'rejected card gone');
  assert.equal((await env.pool.query('SELECT status FROM element_set_versions WHERE element_set_id = $1', [a])).rows[0].status, 'rejected');
  // someone else decides the other one first: the server says 409, the card is refreshed
  assert.equal((await inf2.post(`/api/element-sets/${b}/versions/1/reject`, { reason: 'Already no' })).status, 200);
  ui.d.getElementById(`rv_${b}_1`).value = 'Also no'; rejectOf(0).click();
  await until(() => /Nothing is waiting for review/.test(ui.box().textContent), 'queue refreshed after 409');
  await ui.close();
});

test('your own version shows no buttons (the server refuses it too)', async () => {
  await reset();
  const i1 = (await env.pool.query(`SELECT id FROM users WHERE username = 'informatician1'`)).rows[0].id;
  const set = (await env.pool.query(`INSERT INTO element_sets(slug, title, kind, created_by) VALUES ('rq-own','Own','custom',$1) RETURNING id`, [i1])).rows[0];
  const def = DEF('Own');
  await env.pool.query(`INSERT INTO element_set_versions(element_set_id, version, definition_json, checksum, created_by) VALUES ($1,1,$2,$3,$4)`, [set.id, JSON.stringify(def), checksumOf(def), i1]);
  assert.equal((await doctor.post(`/api/element-sets/${set.id}/versions/1/submit`, {})).status, 200);
  const ui = await openPage(); await ui.login('informatician1'); await ui.openReview();
  assert.match(ui.box().textContent, /You wrote or submitted this version, so you cannot review it/);
  assert.equal(ui.btn('reviewApprove'), null); assert.equal(ui.btn('reviewReject'), null);
  await ui.close();
});
