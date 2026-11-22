'use strict';
// Task B3b-2: values in the page are server observations. Scalar and repeat entries are typed, checked against the pinned set version and
// stored per set and field; trajectories are ordered by effective time and show the recorded time; derived fields are computed, never sent;
// entered-in-error goes through the server (the row stays, struck through with who and why); the browser keeps no values. Real page (jsdom) + real server + PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, client, PW, reviewers, approveVersion } = require('./helpers');

let env, R, admin, nurse, n = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(30); } throw new Error('timed out: ' + what); }

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
async function patient() {
  const r = await nurse.post('/api/patients', { name: 'Value Patient ' + (++n), mrn: 'VAL-' + n, dob: '1980-01-01', sex: 'F' });
  assert.equal(r.status, 201); return r.body.patient.id;
}
async function openPage() {
  const jar = {}, fetched = [], pr = { answer: 'wrong patient', asked: 0 };
  const dom = await JSDOM.fromURL(env.base + '/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.confirm = () => true; w.prompt = () => { pr.asked++; return pr.answer; };
      w.fetch = async (path, o = {}) => {
        fetched.push({ path: String(path), method: o.method || 'GET', body: o.body || '' });
        const res = await fetch(env.base + path, { ...o, headers: { ...(o.headers || {}), ...(jar.c ? { cookie: jar.c } : {}) } });
        const sc = res.headers.get('set-cookie'); if (sc) jar.c = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
        return res;
      };
    } });
  const w = dom.window, d = w.document;
  const ui = { w, d, fetched, pr, $: id => d.getElementById(id), ls: k => w.localStorage.getItem(k), ev: s => w.eval(s),
    posts: re => fetched.filter(f => f.method === 'POST' && re.test(f.path)),
    toast: () => ui.$('toast').textContent,
    async login(u) { ui.$('lg_u').value = u; ui.$('lg_p').value = PW; await w.srvLogin(); await until(() => w.eval('Srv.user'), 'login'); await until(() => w.eval('LIB.loaded'), 'library'); },
    async open(pid) { await w.ptOpenCase(pid); await until(() => w.eval('!!CASE.serverId && CASE.pinsOk === true'), 'case open'); },
    async apply(id, count) { w.applySet(id); await until(() => w.eval('CASE.applied.length') === count, 'pinned ' + id); },
    // type into a field the way a person does, then wait until the server answered and the form was drawn again
    async set(fid, val, setId) {
      const sel = `#forms [data-act="setVal"][data-arg="${fid}"]${setId ? `[data-arg2="${setId}"]` : ''}`, el = d.querySelector(sel); assert.ok(el, 'field ' + fid);
      const before = fetched.length; el.value = val; el.dispatchEvent(new w.Event('change', { bubbles: true }));
      await until(() => fetched.length > before || /Enter|Choose/.test(ui.toast()), 'value sent'); await wait(120);
    },
    async add(fid, val, setId) {
      const btn = d.querySelector(`#forms [data-act="addRowFrom"][data-arg="${fid}"]${setId ? `[data-arg2="${setId}"]` : ''}`); assert.ok(btn, 'repeat ' + fid);
      const before = fetched.length; btn.parentNode.querySelector('input').value = val; btn.click();
      await until(() => fetched.length > before || /Enter|Choose/.test(ui.toast()), 'row sent'); await wait(120);
    },
    async close() { await wait(250); w.close(); } };
  await until(() => w.eval('typeof Srv') === 'object', 'page ready'); await wait(100);
  return ui;
}
const obsOf = async ui => (await nurse.get(`/api/cases/${ui.ev('CASE.serverId')}/timeline?includeErrors=1`)).body.observations;
const typed = { title: 'Typed', fields: [
  { id: 'wt', label: 'Weight', type: 'number', unit: 'kg' }, { id: 'cnt', label: 'Count', type: 'integer' },
  { id: 'sev', label: 'Severity', type: 'select', options: ['mild', 'severe'] }, { id: 'ok', label: 'Fine', type: 'boolean' },
  { id: 'txt', label: 'Remark', type: 'text' }, { id: 'when', label: 'When', type: 'datetime' },
  { id: 'hr', label: 'Heart rate', type: 'number', unit: '/min', repeat: true }] };

test('scalar values go to the server typed, per field; recorded by and recorded time come from the server; a new session reads them back; the browser keeps none', async () => {
  await publishedSet('val-typed', typed);
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-typed', 1);
  await a.set('wt', '72.5'); await a.set('cnt', '3'); await a.set('sev', 'severe'); await a.set('ok', 'Yes'); await a.set('txt', '  fine today ');
  await a.set('when', '2026-11-20T08:30');
  const sent = a.posts(/\/observations$/); assert.equal(sent.length, 6);
  const first = JSON.parse(sent[0].body).observations[0];
  assert.deepEqual(Object.keys(first).sort(), ['appliedSetId', 'effectiveAt', 'fieldKey', 'sourceType', 'value'], 'no user, no recorded time, no unit in the body');
  assert.equal(first.value, 72.5); assert.equal(typeof first.value, 'number'); assert.equal(first.sourceType, 'clinician');
  const rows = await obsOf(a); const by = k => rows.find(r => r.field_key === k);
  assert.equal(rows.length, 6);
  assert.deepEqual([by('wt').value, by('wt').unit_display, by('wt').value_type], [72.5, 'kg', 'number']);
  assert.deepEqual([by('cnt').value, by('cnt').value_type], [3, 'integer']);
  assert.equal(by('sev').value, 'severe'); assert.equal(by('ok').value, true); assert.equal(by('txt').value, 'fine today');
  assert.equal(by('when').value_type, 'datetime'); assert.equal(by('wt').recorded_by, 'nurse1'); assert.ok(by('wt').recorded_at);
  assert.match(a.$('forms').textContent, /Effective .* recorded .* by nurse1/);
  assert.match(a.w.snapshotText(), /- Weight: 72.5 kg/); assert.match(a.w.snapshotText(), /- Fine: Yes/);

  a.w.interimWrite();   // nothing of the values is in the browser
  assert.equal(a.ls('vr_traj'), null);
  assert.doesNotMatch(a.ls('vr_interim') || '', /72\.5|severe|fine today|"values"/);
  const b = await openPage(); await b.login('doctor1'); await b.open(p);
  assert.equal(b.$('f_wt').value, '72.5'); assert.equal(b.$('f_cnt').value, '3'); assert.equal(b.$('f_sev').value, 'severe');
  assert.equal(b.$('f_ok').value, 'Yes'); assert.equal(b.$('f_txt').value, 'fine today'); assert.equal(b.$('f_when').value, '2026-11-20T08:30');
  await a.close(); await b.close();
});

test('a blank is never stored; Unknown is an explicit value; a changed value is a new row and the latest by time is shown; nothing is overwritten', async () => {
  await publishedSet('val-blank', { title: 'Blank', fields: [{ id: 'bw', label: 'BW', type: 'number' }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-blank', 1);
  await a.set('bw', '60'); await wait(20); await a.set('bw', '61');
  assert.equal((await obsOf(a)).length, 2, 'a second entry is a new row, the first stays'); assert.equal(a.$('f_bw').value, '61');
  const before = a.posts(/\/observations$/).length;
  await a.set('bw', ''); assert.match(a.toast(), /blank is not stored/i);
  const A = a.ev('CASE.applied[0].setId');   // a number box in a real browser refuses letters itself; the page checks again
  for (const bad of ['abc', '0x10', '1e999']) { await a.w.obsSave('bw', bad, A); assert.match(a.toast(), /Enter a number/, bad); }
  assert.equal(a.posts(/\/observations$/).length, before, 'nothing was sent'); assert.equal(a.$('f_bw').value, '61', 'the form shows the stored value again');
  a.d.querySelector('[data-act="markUnknown"]').click(); await until(() => a.ev('CASE.vunk["' + a.ev('CASE.applied[0].srvSet') + ':bw"]') === true, 'unknown');
  assert.deepEqual(JSON.parse(a.posts(/\/observations$/).pop().body).observations[0], { appliedSetId: Number(a.ev('CASE.applied[0].srvAs')), fieldKey: 'bw', unknown: true, effectiveAt: JSON.parse(a.posts(/\/observations$/).pop().body).observations[0].effectiveAt, sourceType: 'clinician' });
  assert.equal(a.$('f_bw').value, ''); assert.match(a.$('forms').textContent, /Recorded as unknown/);
  const rows = await obsOf(a); assert.deepEqual(rows.map(r => r.value_type), ['number', 'number', 'unknown']); assert.deepEqual(rows.slice(0, 2).map(r => r.value), [60, 61]);
  await a.close();
});

test('repeat rows: each add is a server row; the list is newest first by effective time and shows when it was recorded and by whom; a new session sees them all', async () => {
  await publishedSet('val-rep', { title: 'Rep', fields: [{ id: 'rhr', label: 'HR', type: 'number', unit: '/min', repeat: true }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-rep', 1);
  await a.add('rhr', '80'); await wait(15); await a.add('rhr', '95'); await wait(15); await a.add('rhr', '70');
  const rows = await obsOf(a); assert.equal(rows.length, 3); assert.deepEqual(rows.map(r => r.value), [80, 95, 70], 'server order is by effective time');
  assert.equal(a.ev('allRows("rhr", CASE.applied[0]).map(r => r.value).join()'), '70,95,80', 'newest first on screen');
  const cells = [...a.d.querySelectorAll('#forms .rep-table tr')].slice(1).map(tr => tr.cells[1].textContent); assert.deepEqual(cells, ['70', '95', '80']);
  assert.match(a.d.querySelector('#forms .rep-table').textContent, /Recorded/); assert.match(a.d.querySelector('#forms .rep-table').textContent, /nurse1/);
  assert.equal(a.$('forms').querySelector('.rep-add input').value, '', 'the box is cleared once the server answered');
  a.w.interimWrite(); assert.doesNotMatch(a.ls('vr_interim') || '', /"rhr"|95/);
  const b = await openPage(); await b.login('doctor1'); await b.open(p);
  assert.equal(b.ev('allRows("rhr", CASE.applied[0]).map(r => r.value).join()'), '70,95,80');
  await a.close(); await b.close();
});

test('two sets that share a field id keep separate values; an explicit update to a newer version keeps what was recorded under the old pin', async () => {
  const s1 = await publishedSet('val-share-a', { title: 'Share A', fields: [{ id: 'glu', label: 'Glucose A', type: 'number' }] });
  await publishedSet('val-share-b', { title: 'Share B', fields: [{ id: 'glu', label: 'Glucose B', type: 'number' }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-share-a', 1); await a.apply('val-share-b', 2);
  const [A, B] = a.ev('CASE.applied.map(x => x.setId)');
  await a.set('glu', '5.5', A); await a.set('glu', '9.9', B);
  const rows = await obsOf(a); assert.equal(rows.length, 2); assert.notEqual(rows[0].applied_set_id, rows[1].applied_set_id);
  const vals = () => [...a.d.querySelectorAll('#forms [data-act="setVal"]')].map(e => e.value);
  assert.deepEqual(vals(), ['5.5', '9.9']);

  const v2 = await R.doctor.post(`/api/element-sets/${s1}/versions`, { definition: { title: 'Share A', fields: [{ id: 'glu', label: 'Glucose A', type: 'number' }, { id: 'ket', label: 'Ketones', type: 'number' }] } });
  assert.equal(v2.status, 201); await approveVersion(R, s1, 2); assert.equal((await admin.post(`/api/element-sets/${s1}/versions/2/publish`, {})).status, 200);
  await a.w.libLoad(); a.w.upgradeSet(A); await until(() => a.ev('CASE.applied[0].version') === 2, 'updated');
  assert.deepEqual(vals().slice(0, 1), ['5.5'], 'the value recorded under version 1 still shows');
  await a.set('glu', '6.1', A); assert.deepEqual(vals().slice(0, 1), ['6.1']);
  assert.equal((await obsOf(a)).length, 3, 'old and new pin rows are all kept'); assert.equal(vals().slice(-1)[0], '9.9');
  await a.close();
});

test('a derived field is computed from the stored values and never sent', async () => {
  await publishedSet('val-derived', { title: 'Fluids', fields: [{ id: 'intake', label: 'Intake', type: 'integer', unit: 'mL' }, { id: 'output', label: 'Output', type: 'integer', unit: 'mL' },
    { id: 'balance', label: 'Net balance', type: 'integer', unit: 'mL', derived: true }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-derived', 1);
  await a.set('intake', '500'); await a.set('output', '180');
  assert.equal(a.$('f_balance').value, '320'); assert.ok(a.$('f_balance').readOnly);
  assert.equal(a.posts(/\/observations$/).map(f => JSON.parse(f.body).observations[0].fieldKey).join(), 'intake,output', 'balance was never sent');
  assert.equal(a.d.querySelector('[data-act="markUnknown"][data-arg="balance"]'), null, 'a derived field has no Unknown button');
  const b = await openPage(); await b.login('doctor1'); await b.open(p); assert.equal(b.$('f_balance').value, '320');
  await a.close(); await b.close();
});

test('the server decides: a refused entry changes nothing on screen or in the browser; a viewer cannot record', async () => {
  await publishedSet('val-refuse', { title: 'Refuse', fields: [{ id: 'rf', label: 'RF', type: 'number' }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-refuse', 1);
  await a.set('rf', '1');
  const cid = a.ev('CASE.serverId'), asid = a.ev('CASE.applied[0].srvAs');
  assert.equal((await nurse.post(`/api/cases/${cid}/applied-sets/${asid}/withdraw`, {})).status, 200);   // out of band: the set no longer takes values
  await a.set('rf', '2');
  assert.match(a.toast(), /withdrawn|takes no new values/i); assert.equal(a.$('f_rf').value, '1', 'the stored value is shown again, not the refused one');
  assert.equal((await obsOf(a)).length, 1);
  a.w.interimWrite(); assert.doesNotMatch(a.ls('vr_interim') || '', /"rf"/);
  await a.close();

  const v = await openPage(); await v.login('viewer1'); await v.open(p).catch(() => {});
  if (v.ev('CASE.applied.length')) {
    assert.equal(v.d.querySelectorAll('#forms [data-act="setVal"]:not([disabled])').length, 0);
    const before = v.fetched.length; await v.w.obsSave('rf', '5', v.ev('CASE.applied[0].setId')); assert.match(v.toast(), /role cannot/i);
    assert.equal(v.posts(/\/observations$/).length, 0); assert.ok(v.fetched.length >= before);
  }
  await v.close();
});

const bundle = ui => { ui.w.buildBundle(); return JSON.parse(ui.$('bj').textContent).entry.map(e => e.resource); };
const click = async (ui, sel) => { const el = ui.d.querySelector(sel); assert.ok(el, sel); const before = ui.fetched.length; el.click(); await wait(250); return ui.fetched.length - before; };

test('entered in error goes through the server: the reason is required, who and when come from the session, the row stays struck through, a new session sees it', async () => {
  await publishedSet('val-err', { title: 'Err', fields: [{ id: 'er', label: 'ER', type: 'number', repeat: true }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-err', 1);
  await a.add('er', '10'); await wait(15); await a.add('er', '20');
  const rowBtn = v => [...a.d.querySelectorAll('#forms .rep-table tr')].find(tr => tr.cells[1] && tr.cells[1].textContent === v).querySelector('[data-act="markRowError"]');
  assert.ok(!rowBtn('10').disabled);
  a.pr.answer = '   '; rowBtn('10').click(); await wait(150);                                // no reason: nothing is sent
  assert.equal(a.posts(/entered-in-error/).length, 0); assert.match(a.toast(), /No reason given/);
  a.pr.answer = null; rowBtn('10').click(); await wait(150); assert.equal(a.posts(/entered-in-error/).length, 0, 'cancelling the prompt changes nothing');
  a.pr.answer = 'wrong patient'; rowBtn('10').click(); await until(() => a.posts(/entered-in-error/).length === 1, 'sent'); await wait(200);
  const sent = a.posts(/entered-in-error/)[0]; assert.deepEqual(JSON.parse(sent.body), { reason: 'wrong patient' }, 'only the reason is sent: no user, no time');
  const rows = await obsOf(a), bad = rows.find(r => r.value === 10);
  assert.deepEqual([bad.status, bad.error_by, bad.error_reason], ['entered_in_error', 'nurse1', 'wrong patient']); assert.ok(bad.error_at); assert.equal(rows.length, 2, 'the row is kept');
  assert.equal(a.ev('getRows("er", CASE.applied[0]).map(r => r.value).join()'), '20', 'rows in use leave out the wrong one');
  assert.doesNotMatch(a.$('forms').textContent, /wrong patient/, 'hidden until asked for');
  a.d.querySelector('[data-act="toggleShowErr"]').click(); a.w.renderForms();
  const struck = a.d.querySelector('#forms tr.err'); assert.match(struck.textContent, /entered in error · nurse1/); assert.match(struck.textContent, /wrong patient/); assert.ok(struck.querySelector('s'));
  assert.equal(a.d.querySelectorAll('#forms [data-act="markRowError"]').length, 1, 'only rows not in error can be marked');
  const b = await openPage(); await b.login('doctor1'); await b.open(p); b.ev('SHOW_ERR = true'); b.w.renderForms();
  assert.match(b.d.querySelector('#forms tr.err').textContent, /wrong patient/); assert.equal(b.ev('getRows("er", CASE.applied[0]).length'), 1);
  assert.ok(![...a.fetched, ...b.fetched].some(f => f.method === 'DELETE'), 'no request deletes anything');
  assert.doesNotMatch(a.w.eval('String(obsError)+String(markRowError)+String(markValError)+String(valuesRebuild)'), /splice|api\('DELETE'/);
  await a.close(); await b.close();
});

test('a scalar entered in error falls back to the previous value; the wrong one is listed on request; a second marking (another session) is refused and the screen is reloaded', async () => {
  await publishedSet('val-err-s', { title: 'ErrS', fields: [{ id: 'es', label: 'ES', type: 'number', unit: 'mL' }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-err-s', 1);
  await a.set('es', '7'); await wait(15); await a.set('es', '800');
  assert.equal(a.$('f_es').value, '800');
  a.pr.answer = 'typo'; assert.equal(await click(a, '#forms [data-act="markValError"]') > 0, true); await until(() => a.$('f_es').value === '7', 'falls back');
  assert.match(a.$('forms').textContent, /Show 1 entered in error/); assert.doesNotMatch(a.$('forms').textContent, /typo/);
  a.ev('SHOW_ERR = true'); a.w.renderForms(); assert.match(a.d.querySelector('#forms .mu.err').textContent, /800.*entered in error · nurse1.*typo/);
  const other = (await obsOf(a)).find(r => r.value === 7);                                           // someone else marks the other row first
  assert.equal((await nurse.post(`/api/observations/${other.id}/entered-in-error`, { reason: 'also wrong' })).status, 200);
  await click(a, '#forms [data-act="markValError"]');
  assert.match(a.toast(), /already|entered in error/i); assert.equal(a.$('f_es').value, '', 'reloaded: no valid value is left');
  assert.equal((await obsOf(a)).length, 2, 'both rows are kept'); await a.close();
});

test('export: the pinned set\'s values are exported; wrong entries are exported as entered-in-error with who, when and why; nothing is dropped', async () => {
  await publishedSet('val-exp', { title: 'Exp', fields: [{ id: 'xw', label: 'XW', type: 'number', unit: 'kg' }, { id: 'xr', label: 'XR', type: 'number', unit: '/min', repeat: true }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-exp', 1);
  await a.set('xw', '44'); await wait(15); await a.set('xw', '440'); await a.add('xr', '88'); await wait(15); await a.add('xr', '880');
  const all = await obsOf(a);
  for (const v of [440, 880]) assert.equal((await nurse.post(`/api/observations/${all.find(r => r.value === v).id}/entered-in-error`, { reason: 'extra zero' })).status, 200);
  await a.w.pinsLoad(a.ev('CASE')); a.w.renderForms();
  const obs = bundle(a).filter(r => r.resourceType === 'Observation');
  const show = o => [o.code.text, o.status, (o.valueQuantity || {}).value];
  assert.deepEqual(obs.map(show).sort(), [['XR', 'entered-in-error', 880], ['XR', 'final', 88], ['XW', 'entered-in-error', 440], ['XW', 'final', 44]]);
  obs.filter(o => o.status === 'entered-in-error').forEach(o => { assert.match(o.note[0].text, /nurse1.*extra zero/); assert.ok(o.effectiveDateTime); });
  assert.ok(obs.find(o => o.status === 'final' && o.code.text === 'XW').effectiveDateTime, 'a value carries when it was true');
  const qr = JSON.stringify(a.w.buildQR(a.ev('resolve(CASE.applied[0])'), 'urn:uuid:x', 'nurse1', a.ev('CASE.applied[0]')));
  assert.match(qr, /44/); assert.doesNotMatch(qr, /440|880/, 'the Questionnaire response has only the rows in use');
  assert.match(a.$('forms').textContent, /Show 1 entered in error/);
  await a.close();
});

test('a viewer sees no Error buttons; the Error action is refused for a role that cannot change cases', async () => {
  await publishedSet('val-err-v', { title: 'ErrV', fields: [{ id: 'ev', label: 'EV', type: 'number', repeat: true }, { id: 'sv', label: 'SV', type: 'number' }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-err-v', 1); await a.add('ev', '1'); await a.set('sv', '2');
  const v = await openPage(); await v.login('viewer1'); await v.open(p);
  assert.equal(v.d.querySelectorAll('#forms [data-act="markValError"]').length, 0);
  assert.ok([...v.d.querySelectorAll('#forms [data-act="markRowError"]')].every(b => b.disabled));
  await v.w.obsError(1); assert.match(v.toast(), /role cannot/i); assert.equal(v.posts(/entered-in-error/).length, 0);
  await a.close(); await v.close();
});

test('the Questionnaire response and the FHIR bundle read the server values of their own set', async () => {
  await publishedSet('val-fhir', { title: 'Fhir', fields: [{ id: 'fw', label: 'FW', type: 'number', unit: 'kg' }, { id: 'fr', label: 'FR', type: 'number', unit: '/min', repeat: true }] });
  const p = await patient(), a = await openPage(); await a.login('nurse1'); await a.open(p); await a.apply('val-fhir', 1);
  await a.set('fw', '44'); await a.add('fr', '88');
  const s = a.ev('resolve(CASE.applied[0])'), a0 = a.ev('CASE.applied[0]');
  const qr = a.w.buildQR(s, 'urn:uuid:x', 'nurse1', a0), txt = JSON.stringify(qr);
  assert.match(txt, /44/); assert.match(txt, /88/);
  const text = JSON.stringify(bundle(a)); assert.match(text, /44/); assert.match(text, /88/);
  await a.close();
});
