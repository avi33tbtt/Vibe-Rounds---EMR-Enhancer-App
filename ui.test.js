'use strict';
// Drives the real page (emr-enhancer.html) in jsdom against the real server + PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, PW } = require('./helpers');

let env;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }

async function openPage() {
  const jar = {};
  const dom = await JSDOM.fromURL(env.base + '/', { runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.confirm = () => true;
      w.fetch = async (path, o = {}) => {
        const res = await fetch(env.base + path, { ...o, headers: { ...(o.headers || {}), ...(jar.c ? { cookie: jar.c } : {}) } });
        const sc = res.headers.get('set-cookie'); if (sc) jar.c = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
        return res;
      };
    } });
  const w = dom.window, d = w.document;
  const ui = {
    w, d,
    S: () => w.eval('Srv'),
    $: id => d.getElementById(id),
    text: id => d.getElementById(id).textContent,
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => ui.S().user, 'login'); },
    tab: t => d.querySelector(`[data-t=${t}]`).click(),
  };
  await until(() => w.srvInit && w.eval('typeof Srv')==='object', 'page ready');
  return ui;
}

test('nurse: register, duplicate warning, open case, real banner, encounters, bed error', async () => {
  const ui = await openPage();
  ui.tab('patients');
  assert.equal(ui.$('ptLogin').style.display, 'block');
  await ui.login('nurse1');
  assert.match(ui.text('who'), /nurse1 \(nurse\)/);
  assert.equal(ui.$('ptRegBtn').style.display, '');

  ui.w.ptToggleForm(true);
  ui.$('r_name').value = 'Asha Verma'; ui.$('r_mrn').value = 'UI-001'; ui.$('r_dob').value = '1975-02-10'; ui.$('r_sex').value = 'F';
  await ui.w.ptRegister(false);
  await until(() => /Asha Verma/.test(ui.text('ptList')), 'patient listed');

  ui.w.ptToggleForm(true);
  ui.$('r_name').value = 'Asha Verma'; ui.$('r_mrn').value = 'UI-002'; ui.$('r_dob').value = '1975-02-10'; ui.$('r_sex').value = 'F';
  await ui.w.ptRegister(false);
  assert.match(ui.text('ptDup'), /Possible duplicate/);
  assert.match(ui.text('ptDup'), /UI-001/);
  await ui.w.ptRegister(true);
  await until(() => /UI-002/.test(ui.text('ptList')), 'override registered');

  ui.$('ptQ').value = 'ui-001'; await ui.w.ptLoad();
  assert.doesNotMatch(ui.text('ptList'), /UI-002/);
  const id1 = Object.values(ui.S().pts).find(p => p.mrn === 'UI-001').id;
  ui.w.ptOpenCase(id1);
  await until(() => /Asha Verma/.test(ui.text('pbanner')), 'banner');
  assert.match(ui.text('pbanner'), /MRN UI-001/);
  assert.match(ui.text('pbanner'), /Asha Verma/);
  assert.match(ui.text('pbanner'), /\d+ · F/);
  assert.doesNotMatch(ui.text('pbanner'), /Unnamed patient/);
  assert.equal(ui.$('legacyPt').style.display, 'none');
  const stored = JSON.parse(ui.w.localStorage.getItem('vr_traj'));
  assert.doesNotMatch(JSON.stringify(stored), /Asha|UI-001/);          // identity is not copied into the browser case

  ui.$('enc_bed').value = 'ICU-1'; await ui.w.encOpen();
  await until(() => /Encounter open/.test(ui.text('encPanel')), 'encounter open');
  assert.match(ui.text('pbanner'), /Bed ICU-1/);

  const id2 = Object.values(ui.S().pts).find(p => p.mrn === 'UI-002').id;
  ui.w.ptOpenCase(id2);
  await until(() => /UI-002/.test(ui.text('pbanner')), 'second banner');
  ui.$('enc_bed').value = 'icu-1'; await ui.w.encOpen();
  assert.match(ui.text('enc_err'), /already has an open encounter/);

  ui.w.ptOpenCase(id1);
  await until(() => /Encounter open/.test(ui.text('encPanel')), 'reopen');
  await ui.w.encClose(ui.S().pts[id1].open_encounter_id);
  await until(() => /No open encounter/.test(ui.text('encPanel')), 'closed');
  await wait(250); ui.w.close();
});

test('viewer: sees patients, cannot register or open encounters; server refuses anyway', async () => {
  const ui = await openPage();
  await ui.login('viewer1');
  ui.tab('patients');
  assert.equal(ui.$('ptRegBtn').style.display, 'none');
  await until(() => /UI-001/.test(ui.text('ptList')), 'list for viewer');
  assert.doesNotMatch(ui.$('ptList').innerHTML, />Archive</);
  const p = Object.values(ui.S().pts).find(x => x.mrn === 'UI-001');
  ui.w.ptOpenCase(p.id);
  await until(() => /UI-001/.test(ui.text('pbanner')), 'banner');
  assert.doesNotMatch(ui.text('encPanel'), /Open encounter/);
  ui.w.ptToggleForm(true);
  ui.$('r_name').value = 'Blocked Person'; ui.$('r_mrn').value = 'UI-999'; ui.$('r_dob').value = '1990-01-01'; ui.$('r_sex').value = 'M';
  await ui.w.ptRegister(false);
  assert.match(ui.text('pt_err'), /permission/i);
  await wait(250); ui.w.close();
});

test('server unreachable: demo case screen still works; sign-in says so', async () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:1/', pretendToBeVisual: true,
    beforeParse(w) { w.fetch = async () => { throw new Error('down'); }; } });
  const w = dom.window, d = w.document;
  await wait(100);
  assert.match(d.getElementById('pbanner').textContent, /Unnamed patient/);
  assert.notEqual(d.getElementById('legacyPt').style.display, 'none');
  d.querySelector('[data-t=patients]').click();
  assert.equal(d.getElementById('ptLogin').style.display, 'block');
  d.getElementById('lg_u').value = 'x'; d.getElementById('lg_p').value = 'y';
  await w.srvLogin();
  assert.match(d.getElementById('lg_err').textContent, /Cannot reach the server/);
  await wait(250); w.close();
});
