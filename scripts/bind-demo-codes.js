'use strict';
// Row R2f-4b: restore LOCAL codes on the demo vitals, glucose and DKA sets, as new versions through the real review rules.
//   npm run terms:bind     SYNTHETIC. No licensed vocabulary. Prototype, not for clinical use.
// Needs: `npm run seed` users, SEED_PASSWORD in .env, `npm run terms:seed` (terms published) and the demo library published.
// Talks to the app over HTTP as doctor1, informatician1 and admin1 (no SQL), like scripts/seed-terms.js. Safe to run again.
const { makePool } = require('../db');
const { migrate } = require('../migrate');
const { createApp } = require('../app');

const REASON = 'Local codes added to demo fields: plain words, no external vocabulary.';
// slug -> { field id -> example term code }. glu and dka_glu use the NEAREST example term (see the chunk file); the owner reviews this table.
const MAP = {
  vitals: { hr: 'demo.heart-rate', bp_sys: 'demo.blood-pressure', bp_dia: 'demo.blood-pressure', rr: 'demo.respiratory-rate', spo2: 'demo.oxygen-saturation' },
  glucose_ss: { glu: 'demo.raised-glucose' },
  dka_ctx: { dka_glu: 'demo.raised-glucose' },
};

function client(base) {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-emr': '1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
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
// Compare by field name: the database returns JSON keys in its own order.
const KEYS = ['system', 'code', 'display', 'version'];
const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x && KEYS.every(k => x[k] === b[i][k]) && Object.keys(x).length === KEYS.length);

// The published term for a code: { code, display, version }. Stops if it is not published.
async function publishedTerm(U, code) {
  const t = must(await U.doctor.get('/api/local-terms?q=' + encodeURIComponent(code)), [200], 'list terms').terms.find(x => x.code === code);
  if (!t || t.status !== 'published') throw new Error(`Term ${code} is not published. Run "npm run terms:seed" first.`);
  return { code, display: t.display, version: String(t.version) };
}

// Returns { bound, current, skipped } counts (sets). Safe to call again.
async function bindDemoCodes({ base, password, log = () => {} }) {
  const U = { doctor: client(base), admin: client(base), inf: client(base) };
  for (const [k, u] of [['doctor', 'doctor1'], ['admin', 'admin1'], ['inf', 'informatician1']]) {
    if ((await U[k].post('/api/login', { username: u, password })).status !== 200) throw new Error(`Login as ${u} failed. Run "npm run seed" first and set SEED_PASSWORD in .env to the same password.`);
  }
  const sets = must(await U.doctor.get('/api/element-sets'), [200], 'list sets').sets;
  const out = { bound: 0, current: 0, skipped: 0 };
  for (const [slug, fieldMap] of Object.entries(MAP)) {
    const s = sets.find(x => x.slug === slug);
    if (!s || !s.published_version) { out.skipped++; log(`${slug}: not in the published library, skipped.`); continue; }
    if (s.latest_version !== s.published_version) throw new Error(`${slug} has an open version ${s.latest_version}. Finish or reject it first; nothing was changed.`);
    const def = must(await U.doctor.get(`/api/element-sets/${s.id}/versions/${s.published_version}`), [200], 'read ' + slug).version.definition;
    const terms = {};
    for (const code of new Set(Object.values(fieldMap))) terms[code] = await publishedTerm(U, code);
    let changed = false;
    const next = JSON.parse(JSON.stringify(def));
    for (const f of next.fields) {
      const code = fieldMap[f.id]; if (!code) continue;
      const wanted = [{ system: 'local', code, display: terms[code].display, version: terms[code].version }];
      if (!same(f.bindings, wanted)) { f.bindings = wanted; changed = true; }
    }
    if (!changed) { out.current++; log(`${slug}: already has its local codes.`); continue; }
    const v = must(await U.doctor.post(`/api/element-sets/${s.id}/versions`, { definition: next }), [201], 'new version of ' + slug).version.version;
    const base_ = `/api/element-sets/${s.id}/versions/${v}`;
    must(await U.doctor.post(base_ + '/submit', {}), [200], 'submit ' + slug);
    const ap = must(await U.inf.post(base_ + '/approve', { reason: REASON }), [200], 'approve ' + slug);
    if (ap.status !== 'reviewed') throw new Error(`${slug} version ${v} needs ${ap.approvalsNeeded} approvals; this script has one informatician. It is left in review.`);
    must(await U.admin.post(base_ + '/publish', {}), [200], 'publish ' + slug);
    out.bound++; log(`${slug}: version ${v} published with local codes.`);
  }
  return out;
}

module.exports = { bindDemoCodes, MAP };

if (require.main === module) {
  (async () => {
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('Set SEED_PASSWORD in .env (the password the demo users were created with by "npm run seed").');
    const mpool = makePool(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL);
    await migrate(mpool); await mpool.end();
    const pool = makePool();
    const server = createApp(pool, { quiet: true, limits: { write: { max: 100000 }, loginIp: { max: 100000 }, loginUser: { max: 100000 } } }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try { const r = await bindDemoCodes({ base: `http://127.0.0.1:${server.address().port}`, password, log: console.log }); console.log(`Done: ${r.bound} bound, ${r.current} already current, ${r.skipped} skipped.`); }
    finally { await new Promise(r => server.close(r)); await pool.end(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
