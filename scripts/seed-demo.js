'use strict';
// Row DM1: one-command demo seed and reset. SYNTHETIC DATA ONLY. Prototype, not for clinical use.
//   npm run demo:seed    makes (once) the synthetic patient "DEMO, Patient A" and one demo case
//   npm run demo:reset   archives the previous demo case (never deletes) and makes a fresh one
// It runs the app in this process and talks to it over HTTP as the demo users, so every write goes through the
// same routes, permission checks, review rules, database triggers and audit log as the page. No SQL into clinical tables.
// It needs the demo users (npm run seed) and SEED_PASSWORD in .env (the password those users were created with).
const { makePool } = require('../db');
const { migrate } = require('../migrate');
const { createApp } = require('../app');

const PATIENT = { name: 'DEMO, Patient A', mrn: 'DEMO-0001', dob: '1990-01-01', sex: 'U' };
const CASE_TITLE = 'DEMO snake bite case (synthetic)';
const SET_SLUG = 'snake-envenomation-timing', PATHWAY_SLUG = 'snake-envenomation-documentation';

// Same field names as the CCIS snake slice, as plain EMR fields. No doses, no thresholds, no codes.
const SET_DEF = {
  title: 'Snake envenomation: timing',
  desc: 'Demo set for the CCIS slice: times and statuses only. Synthetic. Not for clinical use.',
  fields: [
    { id: 'bite_time', label: 'Time of bite', type: 'datetime' },
    { id: 'bite_time_certainty', label: 'How sure is the bite time', type: 'select', options: ['Exact', 'Estimated'] },
    { id: 'arrival_time', label: 'Arrival at hospital', type: 'datetime' },
    { id: 'clotting_test_status', label: '20-minute clotting test', type: 'select', options: ['Performed', 'Not performed'] },
    { id: 'clotting_test_start_time', label: 'Clotting test started', type: 'datetime' },
    { id: 'clotting_result_read_time', label: 'Clotting test read', type: 'datetime' },
    { id: 'clotting_result', label: 'Clotting test result', type: 'select', options: ['Clotted', 'Unclotted'] },
    { id: 'antivenom_status', label: 'Antivenom', type: 'select', options: ['Given', 'Not given'] },
    { id: 'antivenom_start_time', label: 'Antivenom started', type: 'datetime' },
  ],
};

// Tiny HTTP client with its own session cookie (the app wants the x-emr header on every call).
function client(base) {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-emr': '1', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch (_) { /* no body */ }
    return { status: res.status, body: json };
  }
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b = {}) => call('PATCH', p, b), call };
}
const must = (r, okStatuses, what) => {
  if (!okStatuses.includes(r.status)) throw new Error(`${what} failed (${r.status}): ${(r.body && (r.body.message || r.body.error)) || 'no message'}`);
  return r.body;
};

// Take a set version through the real review rules: doctor submits, informaticians approve, admin publishes.
async function publishedSetVersion(U, def) {
  let list = must(await U.doctor.get('/api/element-sets'), [200], 'list sets').sets.find(s => s.slug === SET_SLUG);
  if (!list) { must(await U.doctor.post('/api/element-sets', { slug: SET_SLUG, kind: 'disease', definition: def }), [201], 'create set'); list = must(await U.doctor.get('/api/element-sets'), [200], 'list sets').sets.find(s => s.slug === SET_SLUG); }
  if (list.published_version) return { id: list.id, version: list.published_version };
  const v = list.latest_version, base = `/api/element-sets/${list.id}/versions/${v}`;
  for (let i = 0; i < 6; i++) {
    const cur = must(await U.doctor.get(base), [200], 'read set version').version.status;
    if (cur === 'published') return { id: list.id, version: v };
    if (cur === 'draft') must(await U.doctor.post(base + '/submit', {}), [200], 'submit set for review');
    else if (cur === 'in_review') { for (const inf of [U.inf1, U.inf2]) { const r = await inf.post(base + '/approve', { reason: 'Demo set: timing fields only, no doses or codes.' }); if (r.status === 200 && r.body.status === 'reviewed') break; if (![200, 409].includes(r.status)) must(r, [200], 'approve set'); } }
    else if (cur === 'reviewed') must(await U.admin.post(base + '/publish', {}), [200], 'publish set');
    else throw new Error(`The demo set version is ${cur}; expected draft, in review, reviewed or published.`);
  }
  throw new Error('The demo set did not reach published.');
}
async function publishedPathway(U, set) {
  let p = must(await U.doctor.get('/api/pathways'), [200], 'list pathways').pathways.find(x => x.slug === PATHWAY_SLUG);
  if (!p) {
    must(await U.doctor.post('/api/pathways', { slug: PATHWAY_SLUG, title: 'Snake envenomation documentation', description: 'Demo pathway: documents the timing set. Synthetic.', steps: [{ setId: set.id, version: set.version }] }), [201], 'create pathway');
    p = must(await U.doctor.get('/api/pathways'), [200], 'list pathways').pathways.find(x => x.slug === PATHWAY_SLUG);
  }
  if (!p.published_version) { must(await U.admin.post(`/api/pathways/${p.id}/versions/${p.latest_version}/publish`, {}), [200], 'publish pathway'); p.published_version = p.latest_version; }
  return { id: p.id, version: p.published_version };
}

// Times are relative to now so they are never "in the future" (the server refuses that). Whole minutes, offset +00:00 as Z.
const at = (now, minutesAgo) => new Date(Math.floor(now / 60000) * 60000 - minutesAgo * 60000).toISOString();

// Returns { created, patientId, caseId, appliedSetId, observationIds }. Safe to call again: with an active demo case it changes nothing.
async function seedDemo({ base, password, reset = false, now = Date.now(), log = () => {} }) {
  const U = { doctor: client(base), admin: client(base), inf1: client(base), inf2: client(base) };
  for (const [k, u] of [['doctor', 'doctor1'], ['admin', 'admin1'], ['inf1', 'informatician1'], ['inf2', 'informatician2']]) {
    const r = await U[k].post('/api/login', { username: u, password });
    if (r.status !== 200) throw new Error(`Login as ${u} failed. Run "npm run seed" first and set SEED_PASSWORD in .env to the same password.`);
  }
  const D = U.doctor;
  // 1. the synthetic patient (found by its MRN; never a second one)
  let pat = must(await D.get('/api/patients?archived=1&q=' + encodeURIComponent(PATIENT.mrn)), [200], 'search patient').patients.find(p => p.mrn === PATIENT.mrn);
  if (!pat) pat = must(await D.post('/api/patients', PATIENT), [201], 'register patient').patient;
  if (pat.archived) throw new Error('The demo patient is archived. Restore it in the page, then run this again.');
  // 2. the active demo case, if there is one
  const cases = must(await D.get(`/api/patients/${pat.id}/cases`), [200], 'list cases').cases.filter(c => c.title === CASE_TITLE);
  if (cases.length && !reset) { log(`Demo case ${cases[0].id} already exists; nothing changed. Use "npm run demo:reset" for a fresh one.`); return { created: false, patientId: pat.id, caseId: cases[0].id }; }
  for (const c of cases) must(await D.patch(`/api/cases/${c.id}/archive`, { archived: true, rowVersion: c.row_version }), [200], 'archive previous demo case');
  // 3. content: one published set and one published pathway, reviewed by the real rules
  const set = await publishedSetVersion(U, SET_DEF);
  const pw = await publishedPathway(U, set);
  // 4. the case, the pathway pinned at its published version, then the timed values
  const cs = must(await D.post(`/api/patients/${pat.id}/cases`, { title: CASE_TITLE }), [201], 'create case').case;
  must(await D.post(`/api/cases/${cs.id}/applied-pathways`, { pathwayId: pw.id, version: pw.version }), [201], 'apply pathway');
  const applied = must(await D.get(`/api/cases/${cs.id}/timeline`), [200], 'read timeline');
  const appliedSetId = ((applied.appliedSets || applied.applied_sets || []).find(a => a.element_set_id === set.id) || {}).id;
  if (!appliedSetId) throw new Error('The pathway was applied but its set pin was not found.');
  const o = (fieldKey, minutesAgo, extra) => ({ appliedSetId, fieldKey, effectiveAt: at(now, minutesAgo), sourceType: 'clinician', ...extra });
  // Eight values. `antivenom_start_time` is deliberately never recorded (a missing item), and `clotting_result` is an explicit Unknown.
  const list = [
    o('bite_time', 300, { value: at(now, 300), sourceType: 'patient' }),
    o('bite_time_certainty', 300, { value: 'Estimated', sourceType: 'patient' }),
    o('arrival_time', 255, { value: at(now, 255) }),
    o('clotting_test_status', 240, { value: 'Performed' }),
    o('clotting_test_start_time', 240, { value: at(now, 240) }),
    o('clotting_result_read_time', 220, { value: at(now, 220) }),
    o('clotting_result', 220, { unknown: true }),
    o('antivenom_status', 210, { value: 'Given' }),
  ];
  const obs = must(await D.post(`/api/cases/${cs.id}/observations`, { observations: list }), [201], 'record observations').observations;
  log(`Demo ready: patient ${pat.id} (${PATIENT.name}), case ${cs.id}, ${obs.length} observations, pathway v${pw.version} pinned.`);
  return { created: true, patientId: pat.id, caseId: cs.id, appliedSetId, observationIds: obs.map(x => x.id) };
}

module.exports = { seedDemo, PATIENT, CASE_TITLE, SET_SLUG, PATHWAY_SLUG };

if (require.main === module) {
  (async () => {
    const reset = process.argv.includes('--reset');
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('Set SEED_PASSWORD in .env (the password the demo users were created with by "npm run seed").');
    const mpool = makePool(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL);
    await migrate(mpool); await mpool.end();
    const pool = makePool();
    const server = createApp(pool, { quiet: true, limits: { write: { max: 100000 }, loginIp: { max: 100000 }, loginUser: { max: 100000 } } }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try { await seedDemo({ base: `http://127.0.0.1:${server.address().port}`, password, reset, log: console.log }); }
    finally { await new Promise(r => server.close(r)); await pool.end(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
