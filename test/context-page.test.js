'use strict';
// Task B5b: the "Download context envelope" button in the page. Real page (jsdom) + real server + PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW } = require('./helpers');

const SECRET = 'test-secret-test-secret-test-secret-1234';
let env, seq = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }
test.before(async () => { env = await setup({ contextSecret: SECRET }); });
test.after(async () => { await env.close(); });

async function openPage(user) {
  const jar = {}, fetched = [], downloads = [];
  const dom = await JSDOM.fromURL(env.base + '/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.confirm = () => true;
      w.fetch = async (path, o = {}) => {
        fetched.push({ path: String(path), method: o.method || 'GET' });
        const res = await fetch(env.base + path, { ...o, headers: { ...(o.headers || {}), ...(jar.c ? { cookie: jar.c } : {}) } });
        const sc = res.headers.get('set-cookie'); if (sc) jar.c = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
        return res;
      };
      w.URL.createObjectURL = blob => { const u = 'blob:test-' + downloads.length; downloads.push({ url: u, blob }); return u; };
      w.HTMLAnchorElement.prototype.click = function () { const d = downloads.find(x => x.url === this.href); if (d) d.name = this.download; };
    } });
  const w = dom.window;
  const ui = { w, $: id => w.document.getElementById(id), fetched, downloads,
    async login() { ui.$('lg_u').value = user; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); },
    async open(patientId) { await w.ptOpenCase(patientId); await until(() => w.eval('!!CASE.serverId'), 'case open'); },
    read: blob => new Promise(res => { const fr = new w.FileReader(); fr.onload = () => res(fr.result); fr.readAsText(blob); }),
    async close() { await wait(200); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}
async function newPatient() {
  const d = client(env.base); assert.equal((await d.login('doctor1')).status, 200);
  const p = await d.post('/api/patients', { name: 'Ctx Page Zelda ' + (++seq), mrn: 'CXP-' + seq, dob: '1975-05-05', sex: 'F' });
  assert.equal(p.status, 201); return p.body.patient.id;
}

test('doctor: the button shows, downloads the envelope file once, and the export is logged', async () => {
  const pid = await newPatient(), ui = await openPage('doctor1');
  await ui.login(); await ui.open(pid);
  assert.equal(ui.$('ctxBox').style.display, '', 'visible for a role with context:read');
  const caseId = ui.w.eval('CASE.serverId');
  await ui.w.ctxDownload();
  assert.deepEqual(ui.fetched.filter(f => f.path.endsWith('/context')).map(f => f.path), [`/api/cases/${caseId}/context`]);
  assert.equal(ui.downloads.length, 1);
  assert.match(ui.downloads[0].name, /^context-envelope-cx_[0-9a-f]{32}\.json$/);
  const text = await ui.read(ui.downloads[0].blob), e = JSON.parse(text);
  assert.deepEqual(e.inclusions, { identity: false, narrative: false, enteredInError: false });
  assert.equal(text.includes('Ctx Page Zelda') || text.includes('CXP-'), false, 'no name or record number in the file');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM context_exports WHERE case_id = $1', [caseId])).rows[0].n, 1);
  assert.match(ui.$('ctx_info').textContent, /logged/);
  await ui.close();
});

test('nurse: the button is hidden, and calling the handler anyway sends nothing', async () => {
  const pid = await newPatient(), ui = await openPage('nurse1');
  await ui.login(); await ui.open(pid);
  assert.equal(ui.$('ctxBox').style.display, 'none');
  await ui.w.ctxDownload();
  assert.equal(ui.fetched.some(f => f.path.endsWith('/context')), false);
  assert.equal(ui.downloads.length, 0);
  await ui.close();
});

test('a refusal from the server is shown as text, not downloaded', async () => {
  const pid = await newPatient(), ui = await openPage('doctor1');
  await ui.login(); await ui.open(pid);
  ui.w.eval('CASE.serverId = 99999999');
  await ui.w.ctxDownload();
  assert.equal(ui.downloads.length, 0);
  assert.ok(ui.$('ctx_info').textContent.length > 0);
  assert.equal(ui.$('ctx_info').innerHTML.includes('<'), false, 'shown as text');
  await ui.close();
});
