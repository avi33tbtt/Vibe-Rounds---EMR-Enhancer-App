'use strict';
// Row R6f-3: the Import tab (modules/89-bundles.js): choose a FHIR Bundle, see staged proposals, accept or reject each one. Server data only; the server decides, the page shows the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '89-bundles.js'), 'utf8');
const wire = fs.readFileSync(path.join(__dirname, '..', 'modules', '90-wire.js'), 'utf8');
const NAMES = ['bundlesLoad', 'renderBundles', 'bndSend', 'bndPick', 'bndAccept', 'bndReject', 'bndOpen'];

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const as = (w, username, perms) => w.eval(`Srv.user = ${JSON.stringify({ username, role: 'x', perms })}`);
const withChart = (w, patientId, serverId) => w.eval(`Srv.pts[7] = { name: 'Asha Rai', mrn: 'M-17' }; CASE.patientId = ${JSON.stringify(patientId)}; CASE.serverId = ${JSON.stringify(serverId)}; CASE.pinsOk = true;
  CASE.applied = [{ setId: 'vit', srvAs: 55, srvSet: 5, version: 1 }]; PIN.defs['5:1'] = { id: 'vit', title: 'Vitals', version: 1, fields: [{ id: 'hr', label: 'Heart rate', type: 'number', unit: '/min' }, { id: 'bmi', label: 'BMI', type: 'number', derived: true }] }`);
const fill = (w, id, v) => { w.document.getElementById(id).value = v; };
const sleep = () => new Promise(r => setTimeout(r, 20));
const ALL = ['import:write', 'cases:write', 'problems:write', 'allergies:write'];
const P = (o = {}) => ({ id: 11, bundle_id: 1, key: 'k', kind: 'Observation', entry_index: 0, fields: { label: 'Heart rate', valueType: 'number', value: 72, unit: '/min', effectiveAt: '2026-11-20T08:00:00Z' },
  blockers: [], warnings: [], ready: true, source_status: 'final', starts_as: 'preliminary', status: 'staged', row_version: 3, rejected_by: null, rejected_at: null, reject_reason: null, ...o });
const BUNDLE = (o = {}) => ({ id: 1, bundle_hash: 'abc', bundle_type: 'collection', summary: { entries: 7, byType: { Observation: 2, Condition: 2 } }, warnings: ['Two patients?'], rejected: [], staged_by: 'doc', staged_at: '2026-11-26T09:00:00Z',
  proposals: [P(), P({ id: 12, kind: 'Condition', fields: { label: '<b>Asthma</b>', onsetDate: '2020-01-01' }, starts_as: 'active' }),
    P({ id: 13, kind: 'AllergyIntolerance', fields: { substance: 'Penicillin', reaction: 'Rash', severity: 'mild', onsetDate: null }, starts_as: 'active' }),
    P({ id: 14, kind: 'MedicationRequest', ready: false, fields: { medication: 'Amoxicillin', dosageText: '500 mg three times a day' }, blockers: ['Review only: an imported bundle never creates an order.'] }),
    P({ id: 15, ready: false, blockers: ['There is no value.'], fields: { label: 'Temp', valueType: null, value: null, unit: null, effectiveAt: null } }),
    P({ id: 16, kind: 'Condition', status: 'rejected', rejected_by: 'doc', rejected_at: '2026-11-26T10:00:00Z', reject_reason: 'Wrong patient', fields: { label: 'Old', onsetDate: null } }),
    P({ id: 17, kind: 'Condition', status: 'accepted', fields: { label: 'Done', onsetDate: null } })], ...o });
const LIST = [{ id: 1, bundle_type: 'collection', staged_by: 'doc', staged_at: '2026-11-26T09:00:00Z', staged_count: 5, accepted_count: 1, rejected_count: 1, summary: {}, warnings: [], rejected: [] }];
function server(o = {}) {
  const calls = [];
  const f = async (u, opt) => { if (u === '/api/me') return res(401, {});   // boot probe: signed out, not counted
    const m = (opt && opt.method) || 'GET';
    calls.push({ u, m, b: opt && opt.body && JSON.parse(opt.body) });
    if (m === 'POST') return o.post ? o.post(u, calls[calls.length - 1].b) : res(200, {});
    if (u === '/api/import/bundles') return res(200, { bundles: o.list || LIST });
    if (/^\/api\/import\/bundles\/\d+$/.test(u)) return res(200, { bundle: o.bundle || BUNDLE() });
    return res(404, {}); };
  return { calls, f };
}
const box = w => w.document.getElementById('bundleBox').innerHTML;
const posts = s => s.calls.filter(c => c.m === 'POST');
const acts = (w, name) => [...w.document.querySelectorAll(`[data-act=${name}]`)].map(e => e.dataset.arg);
async function open(w, s) { as(w, 'doc', ALL); withChart(w, 7, 21); await w.eval('bundlesLoad()'); await w.eval("bndOpen('1')"); s.calls.length = 0; }

test('89-bundles.js loads after 89-followups.js and before 90-wire.js; nothing of it is inline; no inline handlers or storage; the Import tab, pane and file input exist; the tab loads it; every action is wired', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/89-bundles.js'), l.indexOf('modules/89-followups.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/89-bundles.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) { assert.ok(!new RegExp(`function ${n}\\(`).test(inline), 'still inline: ' + n); assert.ok(new RegExp(`function ${n}\\(`).test(mod), 'missing: ' + n); }
  assert.ok(!/\son(click|change|input)=/i.test(mod), 'no inline handlers'); assert.ok(!/localStorage|sessionStorage/.test(mod), 'no browser storage');
  assert.match(raw, /<button data-t="bundles" id="navBundles" style="display:none">Import<\/button>/);
  assert.match(raw, /<div class="pane" id="bundles">[\s\S]*id="bnd_file"[\s\S]*id="bundleBox"/);
  assert.match(raw, /if\(b\.dataset\.t==='bundles'\)bundlesLoad\(\)/, 'the tab loads the staged bundles');
  for (const a of new Set([...mod.matchAll(/data-act="(\w+)"/g)].map(m => m[1]).concat(['bndPick']))) assert.ok(new RegExp(`\\b${a}:`).test(wire), 'unwired: ' + a);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'modules', '40-patients.js'), 'utf8').includes('renderBundlesNav()'), 'nav refresh is called from renderWho');
});

test('the Import tab shows only with import:write; signing out clears everything and returns to the Case tab', async () => {
  const s = server(), w = await page(s.f), nav = w.document.getElementById('navBundles');
  as(w, 'v', ['cases:read']); w.eval('renderBundlesNav()'); assert.equal(nav.style.display, 'none');
  await w.eval('bundlesLoad()'); assert.deepEqual(s.calls, [], 'no call without the permission'); assert.equal(box(w), '');
  as(w, 'doc', ALL); w.eval('renderBundlesNav()'); assert.equal(nav.style.display, '');
  await w.eval('bundlesLoad()'); assert.match(box(w), /Bundle #1/);
  nav.click(); await sleep(); assert.ok(nav.classList.contains('on'));
  w.eval('Srv.user = null; renderBundlesNav()'); assert.equal(nav.style.display, 'none'); assert.equal(w.eval('BND.list.length'), 0); assert.equal(box(w), '');
  assert.ok(w.document.querySelector('[data-t=case]').classList.contains('on'), 'back on the Case tab');
});

test('the list shows counts; opening a bundle shows kinds, fields, blockers, warnings; all text is escaped; final proposals say so', async () => {
  const s = server(), w = await page(s.f); await open(w, s);
  const h = box(w);
  assert.ok(!h.includes('<b>Asthma</b>') && h.includes('&lt;b&gt;Asthma'), 'escaped');
  for (const x of ['Bundle #1', 'Heart rate', '72 /min', 'Penicillin', 'Amoxicillin', 'Blocker: There is no value.', 'Two patients?', 'Wrong patient', 'Accepted into a chart. Final.', 'entries: 7', 'Observation 2']) assert.ok(h.includes(x), x);
  assert.ok(h.includes('Asha Rai') && h.includes('M-17'), 'the open chart is named');
  await w.eval('bndClose()'); assert.match(box(w), /1 accepted/); assert.match(box(w), /5 to review/);
});

test('accept is offered only for a staged, ready Observation, Condition or Allergy; never for a medication request, a blocked, rejected or accepted proposal; reject only for staged ones', async () => {
  const s = server(), w = await page(s.f); await open(w, s);
  assert.deepEqual(acts(w, 'bndAccept'), ['11', '12', '13']);
  assert.deepEqual(acts(w, 'bndReject'), ['11', '12', '13', '14', '15']);
  assert.match(box(w), /never creates a medication order/); assert.match(box(w), /has blockers and cannot be accepted/);
  as(w, 'doc', ['import:write', 'cases:write']); await w.eval('renderBundles()');
  assert.deepEqual(acts(w, 'bndAccept'), ['11'], 'no problems:write or allergies:write: only the observation'); assert.match(box(w), /Your role cannot add this kind of record/);
  as(w, 'doc', ['import:write']); await w.eval('renderBundles()'); assert.deepEqual(acts(w, 'bndAccept'), []);
  as(w, 'doc', ALL); withChart(w, null, null); await w.eval('renderBundles()');
  assert.deepEqual(acts(w, 'bndAccept'), [], 'no chart open: nothing to accept into'); assert.match(box(w), /Open the registered patient.s chart/);
  withChart(w, 7, null); await w.eval('renderBundles()'); assert.deepEqual(acts(w, 'bndAccept'), ['12', '13'], 'a patient chart without a loaded case still takes problems and allergies, not values');
});

test('accepting an Observation sends exactly rowVersion, caseId, appliedSetId and fieldKey; derived fields are not offered; the confirm box names the chart', async () => {
  let asked = ''; const s = server(), w = await page(s.f); await open(w, s);
  const opts = [...w.document.querySelectorAll('#bnd_t_11 option')].map(o => [o.value, o.textContent]);
  assert.deepEqual(opts, [['55|hr', 'Vitals \u00b7 Heart rate']], 'the derived BMI field is not offered');
  w.confirm = m => { asked = m; return false; }; await w.eval("bndAccept('11')");
  assert.match(asked, /Asha Rai/); assert.match(asked, /M-17/); assert.match(asked, /preliminary, source imported/); assert.deepEqual(posts(s), [], 'declined: nothing sent');
  w.confirm = () => true; await w.eval("bndAccept('11')");
  assert.deepEqual(posts(s), [{ u: '/api/import/proposals/11/accept', m: 'POST', b: { rowVersion: 3, caseId: 21, appliedSetId: 55, fieldKey: 'hr' } }]);
  await sleep(); assert.ok(s.calls.some(c => c.u === '/api/import/bundles/1' && c.m === 'GET'), 'reloaded after success');
});

test('accepting a Condition or Allergy sends only rowVersion, patientId and the open case as originCaseId; a bad id sends nothing', async () => {
  const s = server(), w = await page(s.f); await open(w, s);
  await w.eval("bndAccept('12')"); await w.eval("bndAccept('13')");
  assert.deepEqual(posts(s).map(c => [c.u, c.b]), [['/api/import/proposals/12/accept-to-patient', { rowVersion: 3, patientId: 7, originCaseId: 21 }], ['/api/import/proposals/13/accept-to-patient', { rowVersion: 3, patientId: 7, originCaseId: 21 }]]);
  withChart(w, 7, null); s.calls.length = 0; await w.eval("bndAccept('12')"); assert.deepEqual(posts(s)[0].b, { rowVersion: 3, patientId: 7 }, 'no case: no originCaseId key');
  s.calls.length = 0; for (const a of ["bndAccept('14')", "bndAccept('15')", "bndAccept('16')", "bndAccept('17')", "bndAccept('99')", "bndAccept('1; DROP')", "bndAccept('')"]) await w.eval(a);
  assert.deepEqual(posts(s), [], 'medication, blocked, rejected, accepted, unknown and malformed ids send nothing');
  assert.ok(!/username|recorded_by|status|accepted_by/.test(JSON.stringify(posts(s))), 'no user or status is ever sent');
});

test('reject needs a reason, then sends only reason and the loaded rowVersion; a refusal or stale version shows the server message and a 409 reloads', async () => {
  let status = 409; const s = server({ post: () => res(status, status === 200 ? {} : { error: 'version_conflict', message: 'Changed by someone else.' }) }), w = await page(s.f); await open(w, s);
  await w.eval("bndReject('14')"); assert.deepEqual(posts(s), []); assert.match(box(w), /A reason is required/);
  fill(w, 'bnd_r_14', '  Not needed  '); await w.eval("bndReject('14')");
  assert.deepEqual(posts(s)[0], { u: '/api/import/proposals/14/reject', m: 'POST', b: { reason: 'Not needed', rowVersion: 3 } });
  await sleep(); assert.match(box(w), /Changed by someone else/); assert.ok(s.calls.some(c => c.m === 'GET' && c.u === '/api/import/bundles/1'), 'a 409 reloads');
  status = 200; s.calls.length = 0; fill(w, 'bnd_r_14', 'Not needed'); await w.eval("bndReject('14')"); await sleep(); await sleep();
  assert.ok(s.calls.some(c => c.m === 'GET' && c.u === '/api/import/bundles'), 'success reloads the list');
  s.calls.length = 0; await w.eval("bndReject('16')"); await w.eval("bndReject('x')"); assert.deepEqual(posts(s), [], 'a rejected proposal is final');
});

test('a refused accept shows the server message under that proposal; a typed reason survives a re-draw', async () => {
  const s = server({ post: () => res(409, { error: 'blocked', message: 'A proposal with blockers cannot be accepted.' }) }), w = await page(s.f); await open(w, s);
  fill(w, 'bnd_r_12', 'half typed'); await w.eval("bndAccept('12')"); await sleep();
  assert.match(box(w), /A proposal with blockers cannot be accepted/); assert.equal(w.document.getElementById('bnd_r_12').value, 'half typed');
});

test('uploading sends the parsed bundle and nothing else; invalid JSON, an array or an oversized file send nothing; a bundle staged before opens the first copy; a refusal shows the message', async () => {
  let reply = () => res(201, { bundle: { id: 1 } }); const s = server({ post: () => reply() }), w = await page(s.f); as(w, 'doc', ALL); withChart(w, 7, 21);
  const b = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'Condition' } }] };
  await w.eval("bndSend('not json')"); await w.eval("bndSend('[1]')"); assert.deepEqual(posts(s), []); assert.match(box(w), /A FHIR Bundle is a JSON object/);
  await w.eval(`bndSend(${JSON.stringify(JSON.stringify(b))})`); await sleep(); await sleep();
  assert.deepEqual(posts(s), [{ u: '/api/import/bundles', m: 'POST', b }]); assert.match(box(w), /Bundle #1/, 'the new bundle is opened');
  reply = () => res(409, { error: 'already_staged', message: 'This bundle was staged before.', bundleId: 1 }); await w.eval(`bndSend(${JSON.stringify(JSON.stringify(b))})`); await sleep(); await sleep();
  assert.match(box(w), /staged before; showing the first copy/); assert.match(box(w), /Bundle #1/);
  reply = () => res(400, { error: 'invalid_bundle', message: 'Not a readable bundle.' }); await w.eval(`bndSend(${JSON.stringify(JSON.stringify(b))})`); await sleep(); assert.match(box(w), /Not a readable bundle/);
  s.calls.length = 0; await w.eval("bndPick({ files: [{ size: 3 * 1024 * 1024 }], value: 'x' })"); assert.deepEqual(s.calls, []); assert.match(box(w), /too large/);
  await w.eval(`bndPick({ files: [new File([${JSON.stringify(JSON.stringify(b))}], 'b.json')], value: 'x' })`); await sleep(); await sleep(); await sleep();
  assert.equal(posts(s).length, 1, 'a real file read goes through the same path');
});
