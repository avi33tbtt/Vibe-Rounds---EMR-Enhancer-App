'use strict';
// Approve and publish every set that is waiting, through the real rules (no SQL):
//   informatician1 approves, informatician2 approves too when a second reviewer is needed, admin1 publishes.
//   node scripts/publish-demo-library.js        (needs SEED_PASSWORD; safe to run again)
// SYNTHETIC demo content only. Prototype, not for clinical use. Pathways are still imported by admin1 on the Library tab.
const { makePool } = require('../db');
const { migrate } = require('../migrate');
const { createApp } = require('../app');

const REASON = 'Demo library: synthetic plain-word fields, no doses or thresholds.';
function client(base) {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-emr': '1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch (_) { /* no body */ }
    return { status: res.status, body: json || {} };
  }
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}

async function publishLibrary({ base, password, log = () => {} }) {
  const U = { inf1: client(base), inf2: client(base), admin: client(base) };
  for (const [k, u] of [['inf1', 'informatician1'], ['inf2', 'informatician2'], ['admin', 'admin1']]) {
    if ((await U[k].post('/api/login', { username: u, password })).status !== 200) throw new Error(`Login as ${u} failed. Run seed.js first and use the same SEED_PASSWORD.`);
  }
  const out = { approved: 0, published: 0, problems: [] };
  const queue = (await U.inf1.get('/api/review-queue')).body.queue || [];
  for (const q of queue) {
    const path = `/api/element-sets/${q.set_id}/versions/${q.version}/approve`;
    let r = await U.inf1.post(path, { reason: REASON });
    if (r.status === 200 && r.body.status !== 'reviewed') r = await U.inf2.post(path, { reason: REASON });   // flagged sets need two different reviewers
    if (r.status === 200 && r.body.status === 'reviewed') out.approved++;
    else out.problems.push(`${q.slug} v${q.version}: ${r.body.message || r.body.error || r.status}`);
  }
  const sets = (await U.admin.get('/api/element-sets')).body.sets || [];
  for (const s of sets) {
    const versions = (await U.admin.get('/api/element-sets/' + s.id)).body.versions || [];
    for (const v of versions.filter(x => x.status === 'reviewed')) {
      const r = await U.admin.post(`/api/element-sets/${s.id}/versions/${v.version}/publish`, {});
      if (r.status === 200) out.published++; else out.problems.push(`${s.slug} v${v.version}: ${r.body.message || r.body.error || r.status}`);
    }
  }
  log(`Demo library: ${out.approved} approved, ${out.published} published.` + (out.problems.length ? ' Problems: ' + out.problems.join(' | ') : ''));
  return out;
}

module.exports = { publishLibrary };

if (require.main === module) {
  (async () => {
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('Set SEED_PASSWORD (the password the demo users were created with).');
    const mpool = makePool(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL);
    await migrate(mpool); await mpool.end();
    const pool = makePool();
    const server = createApp(pool, { quiet: true, limits: { write: { max: 100000 }, loginIp: { max: 100000 }, loginUser: { max: 100000 } } }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try { await publishLibrary({ base: `http://127.0.0.1:${server.address().port}`, password, log: console.log }); }
    finally { await new Promise(r => server.close(r)); await pool.end(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
