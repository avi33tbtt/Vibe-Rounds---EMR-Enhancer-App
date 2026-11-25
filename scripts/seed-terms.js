'use strict';
// Row R2f-3: example local terms. SYNTHETIC, our own words, no licensed vocabulary, no numbers or thresholds. Prototype, not for clinical use.
//   npm run terms:seed    makes the example terms and takes each through the real review rules (safe to run again)
//   npm run terms:reset   retires the published example terms (never deletes) and seeds fresh published versions
// Like scripts/seed-demo.js it talks to the app over HTTP as the demo users, so every write passes the same routes, permission checks,
// review rules, database triggers and audit log as the page. No SQL into the terms tables. Needs `npm run seed` and SEED_PASSWORD in .env.
const { makePool } = require('../db');
const { migrate } = require('../migrate');
const { createApp } = require('../app');

const REVIEW_REASON = 'Example term: plain words only, no external vocabulary, no thresholds.';
const T = (code, display, category, definition) => ({ code: 'demo.' + code, display, category, definition });
const EXAMPLES = [
  T('fang-marks', 'Fang marks seen', 'finding', 'Puncture marks seen at the site of a snake bite. Example term.'),
  T('bite-site-swelling', 'Swelling at the bite site', 'finding', 'Swelling of the skin and tissue around a bite. Example term.'),
  T('bleeding-gums', 'Bleeding from the gums', 'finding', 'Blood seen coming from the gums without injury. Example term.'),
  T('clotting-test', 'Whole blood clotting test', 'test', 'A bedside test that looks at whether a small blood sample clots. Example term.'),
  T('antivenom-given', 'Antivenom given', 'procedure', 'Antivenom has been started for the patient. Example term.'),
  T('raised-glucose', 'Raised blood glucose', 'finding', 'A blood glucose reading that the clinician records as raised. Example term.'),
  T('dka', 'Diabetic ketoacidosis', 'condition', 'A serious complication of diabetes recorded by the clinician. Example term.'),
  T('ketones-present', 'Ketones present', 'finding', 'Ketones found in a urine or blood test. Example term.'),
  T('heart-rate', 'Heart rate', 'observation', 'How fast the heart is beating, as recorded. Example term.'),
  T('blood-pressure', 'Blood pressure', 'observation', 'Blood pressure as recorded. Example term.'),
  T('respiratory-rate', 'Respiratory rate', 'observation', 'How fast the patient is breathing, as recorded. Example term.'),
  T('oxygen-saturation', 'Oxygen saturation', 'observation', 'Oxygen level in the blood as measured by a finger sensor. Example term.'),
];

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
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}
const must = (r, ok, what) => {
  if (!ok.includes(r.status)) throw new Error(`${what} failed (${r.status}): ${(r.body && (r.body.message || r.body.error)) || 'no message'}`);
  return r.body;
};

async function login(base, password) {
  const U = { doctor: client(base), admin: client(base), inf: client(base) };
  for (const [k, u] of [['doctor', 'doctor1'], ['admin', 'admin1'], ['inf', 'informatician1']]) {
    if ((await U[k].post('/api/login', { username: u, password })).status !== 200) throw new Error(`Login as ${u} failed. Run "npm run seed" first and set SEED_PASSWORD in .env to the same password.`);
  }
  return U;
}
// The latest version of one code (the list shows each code once; q matches part of a code, so pick the exact one).
const latest = async (U, code) => must(await U.doctor.get('/api/local-terms?q=' + encodeURIComponent(code)), [200], 'list terms').terms.find(t => t.code === code);

// Take one example to published through the real rules. Returns 'published' (already was), 'made' (new version taken to published) or 'resumed'.
async function publishExample(U, ex) {
  let t = await latest(U, ex.code), outcome = 'resumed';
  if (t && t.status === 'published' && t.display === ex.display) return 'published';
  if (!t || ['retired', 'rejected', 'published'].includes(t.status)) { t = must(await U.doctor.post('/api/local-terms', ex), [201], 'add term ' + ex.code).term; outcome = 'made'; }
  for (let i = 0; i < 5 && t.status !== 'published'; i++) {
    const base = `/api/local-terms/${t.id}`;
    if (t.status === 'draft') t = must(await U.doctor.post(base + '/submit', {}), [200], 'submit ' + ex.code).term;
    else if (t.status === 'in_review') t = must(await U.inf.post(base + '/approve', { reason: REVIEW_REASON }), [200], 'approve ' + ex.code).term;
    else if (t.status === 'reviewed') t = must(await U.admin.post(base + '/publish', {}), [200], 'publish ' + ex.code).term;
    else throw new Error(`${ex.code} is ${t.status}; expected draft, in review, reviewed or published.`);
  }
  if (t.status !== 'published') throw new Error(ex.code + ' did not reach published.');
  return outcome;
}

// Returns { published, made, resumed, retired } counts. Safe to call again.
async function seedTerms({ base, password, reset = false, log = () => {} }) {
  const U = await login(base, password);
  let retired = 0;
  if (reset) for (const ex of EXAMPLES) {
    const t = await latest(U, ex.code);
    if (t && t.status === 'published') { must(await U.admin.post(`/api/local-terms/${t.id}/retire`, {}), [200], 'retire ' + ex.code); retired++; }
  }
  const out = { published: 0, made: 0, resumed: 0, retired };
  for (const ex of EXAMPLES) out[await publishExample(U, ex)]++;
  log(`Example local terms: ${out.made} made, ${out.resumed} carried on, ${out.published} already published, ${out.retired} retired first. ${EXAMPLES.length} in all.`);
  return out;
}

module.exports = { seedTerms, EXAMPLES };

if (require.main === module) {
  (async () => {
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('Set SEED_PASSWORD in .env (the password the demo users were created with by "npm run seed").');
    const mpool = makePool(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL);
    await migrate(mpool); await mpool.end();
    const pool = makePool();
    const server = createApp(pool, { quiet: true, limits: { write: { max: 100000 }, loginIp: { max: 100000 }, loginUser: { max: 100000 } } }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try { await seedTerms({ base: `http://127.0.0.1:${server.address().port}`, password, reset: process.argv.includes('--reset'), log: console.log }); }
    finally { await new Promise(r => server.close(r)); await pool.end(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
