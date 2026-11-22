'use strict';
// Chunk 04b in the real page: switch off = nothing sent, preview shows the exact payload, the key is nowhere in the browser.
// Real page (jsdom) + real server + PostgreSQL + a local mock provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { JSDOM } = require('jsdom');
const { setup, PW } = require('./helpers');

const KEY = 'sk-ui-SECRET-9876543210';
let env, prov, seen, reply;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }

test.before(async () => {
  seen = []; reply = JSON.stringify({ title: 'Mock set', fields: [{ id: 'a', label: 'A', type: 'text' }] });
  prov = await new Promise(res => { const s = http.createServer((req, rsp) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body: b });
    rsp.writeHead(200, { 'content-type': 'application/json' }); rsp.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  }); }); s.listen(0, '127.0.0.1', () => res(s)); });
  env = await setup({ ai: { provider: 'openrouter', key: KEY, model: 'ui/model', baseUrl: `http://127.0.0.1:${prov.address().port}`, timeoutMs: 5000 } });
  await env.pool.query('UPDATE ai_settings SET enabled = false, model = NULL WHERE id = 1');
});
test.after(async () => { await env.close(); await new Promise(r => prov.close(r)); });
test.beforeEach(() => { seen.length = 0; });

async function openPage(store = {}) {
  const jar = {}, fetched = [];
  const dom = await JSDOM.fromURL(env.base + '/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
      w.confirm = () => true;
      w.fetch = async (path, o = {}) => {
        fetched.push({ path: String(path), method: o.method || 'GET', body: o.body || '', headers: o.headers || {} });
        const res = await fetch(env.base + path, { ...o, headers: { ...(o.headers || {}), ...(jar.c ? { cookie: jar.c } : {}) } });
        const sc = res.headers.get('set-cookie'); if (sc) jar.c = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
        return res;
      };
      // jsdom has no <dialog>.showModal: the test plays the user, who reads the dialog and clicks Send or Cancel.
      w.HTMLDialogElement.prototype.showModal = function () {
        w.__dialog = this.querySelector('pre').textContent;
        this.returnValue = w.__choice || 'cancel';
        setTimeout(() => this.dispatchEvent(new w.Event('close')), 0);
      };
    } });
  const w = dom.window, d = w.document;
  const ui = { w, d, fetched, $: id => d.getElementById(id), S: () => w.eval('Srv'), A: () => JSON.parse(JSON.stringify(w.eval('AI'))),
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => ui.S().user, 'login'); await until(() => w.eval('AI.on') !== undefined && ui.$('aiStatus').textContent, 'ai status'); } };
  await until(() => w.eval('typeof Srv') === 'object' && w.eval('typeof AI') === 'object', 'page ready');
  await wait(100);
  return ui;
}
const setServer = async (enabled, extra = '') => { await env.pool.query(`UPDATE ai_settings SET enabled = $1, model = 'ui/model'${extra} WHERE id = 1`, [enabled]); };

test('no API key, provider or model fields remain in the page; a key saved by an older version is purged', async () => {
  const ui = await openPage({ vr_set: JSON.stringify({ p: 'or', m: 'old/model', k: 'sk-legacy-LEAK', a: true, d: false }) });
  assert.equal(ui.$('key'), null); assert.equal(ui.$('prov'), null); assert.equal(ui.$('model'), null);
  const stored = JSON.stringify({ ...ui.w.localStorage });
  assert.ok(!stored.includes('sk-legacy-LEAK')); assert.ok(!/"k"|"m"|"p"|"a"/.test(ui.w.localStorage.getItem('vr_set')));
  assert.deepEqual(JSON.parse(ui.w.localStorage.getItem('vr_set')), { d: false });   // only the demo choice survives
  assert.ok(!ui.d.documentElement.outerHTML.includes('API key (browser only)'));
});

test('signed out, or switch off: AI buttons are disabled and nothing is requested', async () => {
  await setServer(false);
  const ui = await openPage();
  assert.equal(ui.$('genBtn').disabled, true); assert.match(ui.$('genBtn').title, /Sign in/);
  await ui.login('doctor1');
  assert.equal(ui.A().on, false);
  assert.equal(ui.$('genBtn').disabled, true); assert.match(ui.$('genBtn').title, /off/i);
  assert.match(ui.$('aiStatus').textContent, /OFF/);
  ui.$('gen_dx').value = 'Sepsis'; await ui.w.generate();
  await assert.rejects(() => ui.w.callAI('gen', { diagnosis: 'Sepsis', systems: [] }), /AI is off/);
  assert.equal(seen.length, 0);
  assert.ok(!ui.fetched.some(f => f.path.startsWith('/api/ai/preview') || f.path.startsWith('/api/ai/run')));
});

test('switch on: preview shows the exact payload; Cancel sends nothing; Send goes through the server only', async () => {
  await setServer(true);
  const ui = await openPage({ vr_set: JSON.stringify({ d: false }) });
  await ui.login('doctor1');
  assert.equal(ui.A().on, true); assert.equal(ui.A().configured, true);
  assert.equal(ui.$('genBtn').disabled, false);
  assert.match(ui.$('aiStatus').textContent, /ui\/model/);
  ui.$('gen_dx').value = 'Sepsis'; ui.$('gen_ins').value = 'focus on timing';
  // Cancel: the user reads the preview and declines
  ui.w.__choice = 'cancel';
  await ui.w.generate();
  assert.match(ui.w.__dialog, /Nothing is sent from this browser to the provider/);
  assert.equal(seen.length, 0);
  assert.equal(ui.w.eval('LAST_GENERATED'), null);
  // Send
  ui.w.__choice = 'send';
  ui.fetched.length = 0;
  await ui.w.generate();
  await until(() => ui.w.eval('LAST_GENERATED') !== null, 'generated');
  assert.equal(seen.length, 1);
  const shown = JSON.parse(ui.w.__dialog.split('\n\n').pop());
  assert.deepEqual(shown, JSON.parse(seen[0].body), 'the dialog showed exactly what the provider received');
  assert.equal(shown.messages[1].content, 'Diagnosis: Sepsis\nExtra: focus on timing');
  assert.match(ui.w.__dialog, /never shown and never sent to your browser/);
  // network from the browser: only this server, never a provider, never a key
  assert.ok(ui.fetched.length >= 2 && ui.fetched.every(f => f.path.startsWith('/api/')), JSON.stringify(ui.fetched.map(f => f.path)));
  assert.ok(!JSON.stringify(ui.fetched).includes(KEY));
  assert.ok(!JSON.stringify({ ...ui.w.localStorage }).includes(KEY));
  assert.ok(!ui.d.documentElement.outerHTML.includes(KEY));
  assert.equal(ui.w.eval('LAST_GENERATED').title, 'Mock set');
  assert.equal(ui.w.eval('LAST_GENERATED.provenance.by'), 'llm');
  assert.match(ui.$('aiStatus').textContent, /requests left/);
});

test('names typed into the diagnosis are removed before the preview and are not what the provider receives', async () => {
  await setServer(true);
  const ui = await openPage({ vr_set: JSON.stringify({ d: false }) });
  await ui.login('doctor1');
  const reg = await ui.w.api('POST', '/api/patients', { name: 'Ibrahim Nazari', mrn: 'UI-9001', dob: '1990-01-02', sex: 'M' });
  assert.equal(reg.status, 201);
  ui.$('gen_dx').value = 'Sepsis in Ibrahim Nazari MRN UI-9001'; ui.w.__choice = 'send';
  await ui.w.generate(); await until(() => ui.w.eval('LAST_GENERATED') !== null, 'generated');
  assert.ok(!ui.w.__dialog.includes('Ibrahim') && !ui.w.__dialog.includes('Nazari') && !ui.w.__dialog.includes('UI-9001'));
  assert.match(ui.w.__dialog, /Identifying details removed before sending: .*name/);
  assert.ok(!seen[0].body.includes('Nazari'));
});

test('AI rank end to end: ranked ids come back through the server and apply to the case', async () => {
  await setServer(true);
  const ui = await openPage({ vr_set: JSON.stringify({ d: false }) });
  await ui.login('doctor1');
  const id = ui.w.eval('REGISTRY[0].id');
  reply = JSON.stringify({ ranked: [id, 'not_in_candidates'] });
  const asked = []; ui.w.prompt = m => { asked.push(m); return asked.length === 1 ? 'Sepsis' : '1'; };
  ui.w.__choice = 'send';
  await ui.w.aiRank();
  assert.equal(seen.length, 1);
  const body = JSON.parse(seen[0].body);
  const payload = JSON.parse(body.messages[1].content);
  assert.deepEqual(Object.keys(payload).sort(), ['applied_pathways', 'applied_sets', 'candidates', 'diagnosis']);
  assert.ok(ui.w.eval(`CASE.applied.some(a=>a.setId==='${id}')`));
  reply = JSON.stringify({ title: 'Mock set', fields: [{ id: 'a', label: 'A', type: 'text' }] });
});

test('admin panel controls the switch, model and limits on the server; a doctor does not see it', async () => {
  await setServer(false, ', hourly_limit_per_user = 20, daily_limit_total = 200');
  const doc = await openPage();
  await doc.login('doctor1');
  assert.equal(doc.$('aiAdmin').style.display, 'none');
  const ui = await openPage();
  await ui.login('admin1');
  assert.equal(ui.$('aiAdmin').style.display, 'block');
  assert.equal(ui.$('aiOn').checked, false);
  ui.$('aiOn').checked = true; ui.$('aiModel').value = 'other/model'; ui.$('aiHourly').value = '7'; ui.$('aiDaily').value = '70';
  await ui.w.saveSet();
  const row = (await env.pool.query('SELECT * FROM ai_settings')).rows[0];
  assert.equal(row.enabled, true); assert.equal(row.model, 'other/model'); assert.equal(row.hourly_limit_per_user, 7); assert.equal(row.daily_limit_total, 70);
  assert.match(ui.$('aiStatus').textContent, /other\/model/);
  assert.ok(!JSON.stringify(ui.fetched).includes(KEY));
  // an invalid value is refused by the server and nothing changes
  ui.$('aiHourly').value = '0'; await ui.w.saveSet();
  assert.equal((await env.pool.query('SELECT hourly_limit_per_user h FROM ai_settings')).rows[0].h, 7);
  await setServer(false, ", hourly_limit_per_user = 20, daily_limit_total = 200");
});
