'use strict';
// Task DM2b: the CCIS insights panel in the case screen. Real page (jsdom) + real server + PostgreSQL.
// The page shows a stored run record as received, lets a clinician acknowledge it, and never edits a result.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW } = require('./helpers');
const { SECRET, caseWithExport, runRecord } = require('./ccis-helpers');

let env, doc, seq = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }
test.before(async () => { env = await setup({ contextSecret: SECRET }); doc = client(env.base); assert.equal((await doc.login('doctor1')).status, 200); });
test.after(async () => { await env.close(); });

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
    async open(patientId) { await w.ptOpenCase(patientId); await until(() => w.eval('!!CASE.serverId && CASE.notesOk === true'), 'case open'); await until(() => w.eval('CCIS.caseId === CASE.serverId'), 'ccis loaded'); await wait(80); },
    list: () => ui.$('ccisList'),
    async close() { await wait(200); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}
// A registered patient with a case that has an exported envelope. Returns what a run record needs, plus the patient id for the page.
async function story() {
  const k = await caseWithExport(doc, env.pool);
  const pid = (await env.pool.query('SELECT patient_id FROM clinical_cases WHERE id = $1', [k.caseId])).rows[0].patient_id;
  return { ...k, pid };
}
const importVia = async (ui, rec) => { await ui.w.ccisImportText(JSON.stringify(rec)); await wait(150); };

test('doctor imports a run record file, opens it, sees values, states, parameters and both banners, then acknowledges it', async () => {
  const k = await story(), a = await openPage(); await a.login('doctor1'); await a.open(k.pid);
  assert.notEqual(a.$('ccisBox').style.display, 'none');
  assert.match(a.list().textContent, /No CCIS run has been imported/);
  assert.match(a.$('ccisBox').textContent, /Synthetic data, prototype/);
  const rec = runRecord(k);
  await importVia(a, rec);
  assert.match(a.$('ccis_info').textContent, /Imported/);
  const t = a.list().textContent;
  assert.match(t, /synthetic\.demo-analytics/); assert.match(t, /v0\.1\.0/); assert.match(t, /engine 0\.1\.0/); assert.match(t, /imported .* by doctor1/); assert.match(t, /not acknowledged/);
  assert.match(t, /Synthetic data, prototype/, 'on every shown run');
  // the new run is opened: results by kind, declared states, parameters, banner for enabled parameters
  assert.match(t, /value outputs/);
  assert.match(t, /syntheticOutput: 1\.5 h/);
  assert.match(t, /Not enabled \(needs parameter: syntheticTarget\)/);
  assert.match(t, /syntheticTarget: disabled/);
  assert.match(t, /syntheticWindow: enabled, value 2 h, supplied by synthetic-clinician-role/);
  assert.match(t, /Demo parameters are test-only placeholders, not clinical values/);
  assert.match(t, /Limitations: Synthetic limitation/);
  // acknowledge with a note
  a.$('ccis_note_' + a.ev('CCIS.runs[0].id')).value = 'Seen on rounds';
  a.d.querySelector('#ccisList button[data-act="ccisAck"]').click();
  await until(async () => (await env.pool.query('SELECT 1 FROM ccis_run_acks')).rows.length === 1, 'ack stored');
  await until(() => /Acknowledged by doctor1 at .*: Seen on rounds/.test(a.list().textContent), 'ack shown');
  assert.equal(a.d.querySelector('#ccisList button[data-act="ccisAck"]'), null, 'no second acknowledge button for the same person');
  await a.close();
});

test('the page sends the record exactly as read, and keeps nothing in the browser', async () => {
  const k = await story(), a = await openPage(); await a.login('doctor1'); await a.open(k.pid);
  const rec = runRecord(k); await importVia(a, rec);
  const post = a.fetched.filter(f => f.method === 'POST' && /\/ccis-runs$/.test(f.path));
  assert.equal(post.length, 1);
  assert.deepEqual(JSON.parse(post[0].body), rec, 'not edited by the page');
  const store = JSON.stringify({ ...a.w.localStorage }) + JSON.stringify({ ...a.w.sessionStorage });
  assert.doesNotMatch(store, /synthetic\.demo-analytics|syntheticOutput|run-synthetic/);
  await a.close();
});

test('hostile text in warnings, limitations, ids and notes is shown as text, never as markup or script', async () => {
  const k = await story(), a = await openPage(); await a.login('doctor1'); await a.open(k.pid);
  const BAD = '<img src=x onerror="window.__pwned=1">';
  const rec = runRecord(k, r => {
    r.warnings = [BAD]; r.limitations = ['<script>window.__pwned=2</script>'];
    r.results[0].warnings = [BAD]; r.results[0].missingDataNotes = ['"><b id=injected>x</b>'];
    r.parameters[1].suppliedBy = BAD;   // ids and keys are pattern-restricted by the schema; free text is where markup could arrive
  });
  await importVia(a, rec);
  const t = a.list().textContent;
  assert.ok(t.includes(BAD), 'the text is visible as typed');
  assert.equal(a.list().querySelector('img, script, b#injected'), null, 'no element was created from it');
  assert.equal(a.w.__pwned, undefined);
  a.$('ccis_note_' + a.ev('CCIS.runs[0].id')).value = BAD;
  a.d.querySelector('#ccisList button[data-act="ccisAck"]').click();
  await until(() => a.list().textContent.includes('Acknowledged by'), 'ack shown');
  assert.equal(a.list().querySelector('img'), null); assert.equal(a.w.__pwned, undefined);
  await a.close();
});

test('a failed run shows why and no result; a table result and a classification are shown; opening and closing works', async () => {
  const k = await story(), a = await openPage(); await a.login('doctor1'); await a.open(k.pid);
  await importVia(a, runRecord(k, null, 'run-record-good-failed.json'));
  assert.match(a.list().textContent, /This run failed \(steps\): step limit exceeded; no result presented\. No result was produced/);
  assert.doesNotMatch(a.list().textContent, /outputs/);
  const rec = runRecord(k, r => {
    r.results = [{ outputId: 'tbl', kind: 'table', value: { columns: ['a', 'b'], rows: [['x', 1], ['y', 2]] }, warnings: [], limitations: [], missingDataNotes: [] },
      { outputId: 'cls', kind: 'classification', value: { label: 'documented' }, warnings: [], limitations: [], missingDataNotes: [] },
      { outputId: 'unk', kind: 'value', state: 'indeterminate', warnings: [], limitations: [], missingDataNotes: ['no clotting result'] }];
  });
  await importVia(a, rec);
  assert.equal(a.list().querySelectorAll('table tr').length, 3, 'header plus two rows');
  assert.match(a.list().textContent, /cls: documented/); assert.match(a.list().textContent, /unk: indeterminate/); assert.match(a.list().textContent, /Missing data: no clotting result/);
  const btn = () => a.d.querySelector('#ccisList .cd button[data-act="ccisToggle"]');
  btn().click(); assert.doesNotMatch(a.list().textContent, /classification outputs/, 'closed');
  btn().click(); assert.match(a.list().textContent, /classification outputs/, 'open again');
  await a.close();
});

test('refusals are shown in words and list nothing: not JSON, not a record, another case\'s record, a record the server finds invalid', async () => {
  const k = await story(), other = await story(), a = await openPage(); await a.login('doctor1'); await a.open(k.pid);
  const before = a.fetched.length;
  await a.w.ccisImportText('not json'); assert.match(a.$('ccis_info').textContent, /not JSON/);
  await a.w.ccisImportText('[1]'); assert.match(a.$('ccis_info').textContent, /not a CCIS run record/);
  assert.equal(a.fetched.length, before, 'nothing was sent for those two');
  await importVia(a, runRecord(other)); assert.match(a.$('ccis_info').textContent, /not made from an envelope of this case/);
  await importVia(a, { hello: 1 }); assert.match(a.$('ccis_info').textContent, /not a valid CCIS run record/);
  assert.match(a.list().textContent, /No CCIS run has been imported/);
  assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM ccis_runs WHERE case_id = $1', [k.caseId])).rows[0].n, 0);
  await a.close();
});

test('a nurse and a viewer can read runs but have no import or acknowledge control; an informatician and a signed-out page see no panel', async () => {
  const k = await story();
  await importVia(await (async () => { const a = await openPage(); await a.login('doctor1'); await a.open(k.pid); return a; })(), runRecord(k));
  for (const u of ['nurse1', 'viewer1']) {
    const a = await openPage(); await a.login(u); await a.open(k.pid);
    assert.notEqual(a.$('ccisBox').style.display, 'none', u);
    assert.equal(a.$('ccis_imp').style.display, 'none', u + ': no import button');
    assert.match(a.list().textContent, /synthetic\.demo-analytics/, u + ': sees the run');
    a.d.querySelector('#ccisList button[data-act="ccisToggle"]').click();
    assert.equal(a.d.querySelector('#ccisList button[data-act="ccisAck"]'), null, u + ': no acknowledge');
    await a.close();
  }
  const inf = await openPage(); await inf.login('informatician1');
  assert.equal(inf.$('ccisBox').style.display, 'none');
  assert.equal(inf.fetched.filter(f => /ccis-runs/.test(f.path)).length, 0);
  await inf.close();
  const anon = await openPage();
  assert.equal(anon.$('ccisBox').style.display, 'none', 'signed out: nothing');
  assert.equal(anon.fetched.filter(f => /ccis-runs/.test(f.path)).length, 0);
  await anon.close();
});

test('the markup has no inline handlers for the panel (CSP): every control uses data-act', async () => {
  const a = await openPage();
  for (const el of a.d.querySelectorAll('#ccisBox *')) for (const at of el.getAttributeNames()) assert.ok(!/^on/i.test(at), `${el.tagName} has ${at}`);
  for (const act of ['ccisImportOpen', 'ccisPick', 'ccisToggle', 'ccisAck']) assert.ok(a.ev(`Object.hasOwn(ACT, '${act}')`), act);
  await a.close();
});
