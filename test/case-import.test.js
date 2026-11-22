'use strict';
// Task B1b-2: importing local demo cases. API: POST /api/patients/:id/cases/import. Page: explicit, previewed, once per case.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW } = require('./helpers');

let env, nurse, pid, pidArch;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }

test.before(async () => {
  env = await setup();
  nurse = client(env.base); await nurse.login('nurse1');
  pid = (await nurse.post('/api/patients', { name: 'Import Patient', mrn: 'IM-1', dob: '1960-05-05', sex: 'M' })).body.patient.id;
  pidArch = (await nurse.post('/api/patients', { name: 'Archived Patient', mrn: 'IM-2', dob: '1961-05-05', sex: 'F' })).body.patient.id;
  const doctor = client(env.base); await doctor.login('doctor1');
  assert.equal((await doctor.patch(`/api/patients/${pidArch}/archive`, { archived: true })).status, 200);
});
test.after(async () => { await env.close(); });

const audits = async action => (await env.pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;

test('API: creates the case and one narrative entry, audits an import (length only), links no encounter', async () => {
  assert.equal((await nurse.post(`/api/patients/${pid}/encounters`, { bed: 'IMP-1' })).status, 201);   // an open encounter must NOT be linked
  const r = await nurse.post(`/api/patients/${pid}/cases/import`, { title: '  Imported   demo ', narrative: ' Old synthetic narrative ', localId: 'c_abc123' });
  assert.equal(r.status, 201); assert.equal(r.body.case.title, 'Imported demo'); assert.equal(r.body.case.status, 'active');
  const id = r.body.case.id;
  const got = (await nurse.get(`/api/cases/${id}`)).body;
  assert.equal(got.narrative.body, 'Old synthetic narrative'); assert.equal(got.narrative.author, 'nurse1');
  assert.deepEqual(got.encounters, [], 'a historical demo case is not linked to the open encounter');
  const a = (await audits('case.import')).find(x => x.entity_id === String(id));
  assert.ok(a); assert.equal(a.username, 'nurse1');
  assert.deepEqual(a.detail, { patientId: pid, source: 'local-demo', localId: 'c_abc123', narrativeLength: 'Old synthetic narrative'.length });
  assert.ok(!JSON.stringify(await audits('case.import')).includes('Old synthetic'), 'the narrative text never goes into the audit log');
  assert.equal((await audits('case.create')).filter(x => x.entity_id === String(id)).length, 0, 'recorded as an import, not as a create');
});

test('API: no narrative is fine (no entry); bad input, forged fields, unknown or archived patient and a viewer are refused', async () => {
  const none = await nurse.post(`/api/patients/${pid}/cases/import`, { title: 'No narrative' });
  assert.equal(none.status, 201);
  assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM case_narrative_entries WHERE case_id = $1', [none.body.case.id])).rows[0].n, 0);
  const before = (await env.pool.query('SELECT count(*)::int AS n FROM clinical_cases')).rows[0].n;
  const bad = async (b, code) => assert.equal((await nurse.post(`/api/patients/${pid}/cases/import`, b)).status, code, JSON.stringify(b).slice(0, 80));
  await bad({}, 400); await bad({ title: '   ' }, 400); await bad({ title: 'x'.repeat(201) }, 400);
  await bad({ title: 'T', narrative: 5 }, 400); await bad({ title: 'T', narrative: 'x'.repeat(20001) }, 400);
  await bad({ title: 'T', localId: '../etc' }, 400); await bad({ title: 'T', localId: 'a'.repeat(65) }, 400);
  await bad({ title: 'T', createdBy: 1 }, 400); await bad({ title: 'T', patientId: pid }, 400); await bad({ title: 'T', status: 'closed' }, 400);
  assert.equal((await nurse.post('/api/patients/999999/cases/import', { title: 'T' })).status, 404);
  const arch = await nurse.post(`/api/patients/${pidArch}/cases/import`, { title: 'T' });
  assert.equal(arch.status, 409); assert.equal(arch.body.error, 'patient_archived');
  const viewer = client(env.base); await viewer.login('viewer1');
  assert.equal((await viewer.post(`/api/patients/${pid}/cases/import`, { title: 'T' })).status, 403);
  assert.equal((await client(env.base).post(`/api/patients/${pid}/cases/import`, { title: 'T' })).status, 401);
  assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM clinical_cases')).rows[0].n, before, 'refused imports created nothing');
});

// ---------- page ----------
const DEMO = JSON.stringify({ current: 'c_d1', customs: [], cases: [
  { id: 'c_d1', patient: { name: 'Typed Demo Name', mrn: 'TYPED-77', age: '61', sex: 'F' }, narrative: 'Demo narrative with chest pain', applied: [{ setId: 'dm_ctx', version: 1, addedAt: '2026-01-01T00:00:00.000Z', fromPathway: null }],
    values: { glu: 7.4 }, notes: [{ id: 'n_1', kind: 'free', title: 'Demo note', body: 'Body', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', amendments: [] }], status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
  { id: 'c_d2', patient: { name: '<img src=x onerror="window.__x=1">', mrn: '<b>M</b>', age: '', sex: '' }, narrative: '', applied: [{ setId: 'gone_custom', version: 1 }], values: {}, notes: [], status: 'open', createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' },
] });

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
  const ui = { w, d, fetched, $: id => d.getElementById(id), ls: k => w.localStorage.getItem(k), ev: s => w.eval(s),
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); },
    async openImport() { d.querySelector('[data-t=cases]').click(); await until(() => w.eval('Object.keys(Srv.pts).length') > 0, 'patients loaded'); await w.importOpen(); },
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}

test('page: the import button exists only for signed-in roles that may write cases', async () => {
  const a = await openPage({ vr_traj: DEMO });
  assert.equal(a.$('impBtn').style.display, 'none');
  await a.login('viewer1'); assert.equal(a.$('impBtn').style.display, 'none');
  await a.w.srvLogout(); await until(() => !a.ev('Srv.user'), 'logout');
  await a.login('nurse1'); assert.equal(a.$('impBtn').style.display, '');
  await a.close();
});

test('page: preview shows exactly what is sent; one click imports once; vr_traj is untouched; interim data follows', async () => {
  const a = await openPage({ vr_traj: DEMO }); await a.login('nurse1');
  await a.openImport();
  assert.equal(a.$('importBox').style.display, 'block');
  const pre = () => a.$('imp_pre_c_d1').textContent;
  assert.match(pre(), /choose a patient/);
  a.$('imp_t_c_d1').value = 'Chest pain (imported)'; a.$('imp_t_c_d1').dispatchEvent(new a.w.Event('input', { bubbles: true }));
  a.$('imp_p_c_d1').value = String(pid); a.$('imp_p_c_d1').dispatchEvent(new a.w.Event('change', { bubbles: true }));
  const shown = pre();
  assert.match(shown, new RegExp(`^POST /api/patients/${pid}/cases/import\\n`));
  assert.deepEqual(JSON.parse(shown.slice(shown.indexOf('\n') + 1)), { title: 'Chest pain (imported)', narrative: 'Demo narrative with chest pain', localId: 'c_d1' });
  assert.doesNotMatch(shown, /Typed Demo Name|TYPED-77/);
  assert.match(a.$('importBox').textContent, /1 applied set\(s\) are not copied/);   // applied sets are server pins since B3b-1: the import does not copy them

  // nothing is sent without a click; no patient chosen = no request
  const posts = () => a.fetched.filter(f => f.method === 'POST' && /import/.test(f.path));
  assert.equal(posts().length, 0);
  const other = a.$('imp_p_c_d2'); await a.w.importSend('c_d2'); assert.equal(posts().length, 0, 'no patient chosen: nothing sent'); assert.equal(other.value, '');

  await a.w.importSend('c_d1');
  assert.equal(posts().length, 1);
  const sent = JSON.parse(posts()[0].body); assert.deepEqual(Object.keys(sent).sort(), ['localId', 'narrative', 'title']);
  assert.doesNotMatch(posts()[0].body, /Typed Demo Name|TYPED-77|glu|Demo note/, 'identity, values and notes are not sent');
  const row = (await env.pool.query(`SELECT c.id, c.title, c.patient_id FROM clinical_cases c WHERE c.title = 'Chest pain (imported)'`)).rows[0];
  assert.equal(row.patient_id, pid);
  assert.equal((await env.pool.query('SELECT body FROM case_narrative_entries WHERE case_id = $1', [row.id])).rows[0].body, 'Demo narrative with chest pain');
  assert.equal((await audits('case.import')).filter(x => x.detail.localId === 'c_d1').length, 1);

  assert.equal(a.ls('vr_traj'), DEMO, 'vr_traj is only read, never written');
  const im = JSON.parse(a.ls('vr_interim'));
  assert.equal(im.imported.c_d1, row.id);
  assert.equal('applied' in im.cases[row.id], false); assert.equal(im.cases[row.id].values.glu, 7.4); assert.equal(im.cases[row.id].notes[0].title, 'Demo note');
  assert.doesNotMatch(a.ls('vr_interim'), /Typed Demo Name|TYPED-77|Import Patient/);
  assert.match(a.$('importBox').textContent, new RegExp(`Imported as server case #${row.id}`));
  assert.equal(a.$('imp_t_c_d1'), null, 'no second import from this browser');
  await a.w.importSend('c_d1'); assert.equal(posts().length, 1);
  assert.match(a.$('caseList').textContent, /Chest pain \(imported\)/);
  const keep = a.ls('vr_interim'); await a.close();

  // a later session remembers the import, and the case opens with its values and notes (applied sets are not copied)
  const b = await openPage({ vr_traj: DEMO, vr_interim: keep }); await b.login('nurse1'); await b.openImport();
  assert.match(b.$('importBox').textContent, new RegExp(`Imported as server case #${row.id}`));
  await until(() => b.ev(`CASES.some(c => c.id === 's${row.id}')`), 'case list loaded');   // the list loads after the patients; opening before it arrives does nothing
  await b.w.openCase('s' + row.id);
  assert.equal(b.ev('CASE.narrative'), 'Demo narrative with chest pain');
  assert.equal(b.ev('CASE.applied.length'), 0); assert.equal(b.ev('CASE.values.glu'), 7.4); assert.equal(b.ev('CASE.notes.length'), 1);
  assert.equal(b.ls('vr_traj'), DEMO);
  await b.close();
});

test('page: a server refusal is shown and the case is not marked imported; hostile demo text stays text', async () => {
  const a = await openPage({ vr_traj: DEMO }); await a.login('nurse1'); await a.openImport();
  assert.equal(a.$('importBox').querySelector('img'), null); assert.equal(a.w.__x, undefined);
  assert.match(a.$('importBox').textContent, /<img src=x onerror=/);
  a.$('imp_t_c_d2').value = '   '; a.$('imp_p_c_d2').value = String(pid);
  await a.w.importSend('c_d2');                                       // blank title: the server says 400
  assert.equal(a.ev(`interimRead().imported.c_d2`), undefined);
  assert.notEqual(a.$('imp_t_c_d2'), null, 'still importable after a refusal');
  assert.equal(a.ls('vr_traj'), DEMO);
  await a.close();
});
