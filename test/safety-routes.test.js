'use strict';
// Chunk 05, checks 1, 3 and 7 (routes part):
//   1. permission matrix: every route x every role (and signed-out)
//   3. audit coverage: every write route leaves an audit row made from the SESSION
//   7. no hard-delete route exists
// The route list is read from the running app, so a new route that is not in the tables below FAILS here.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, client, PW } = require('./helpers');
const { PERMS } = require('../permissions');
const { ROLES, listRoutes, isWrite, fill } = require('./safety-helpers');
const { SECRET, caseWithExport, runRecord } = require('./ccis-helpers');

// ---------- the matrix (written by hand on purpose: it is the spec, permissions.js is the implementation) ----------
// guard: 'public' (no sign-in), 'login' (any signed-in user) or a permission name.
const MATRIX = {
  'GET /':                          { guard: 'public' },
  'GET /emr-enhancer.html':         { guard: 'public' },
  'GET /sdc.js':                    { guard: 'public' },
  'GET /pathway-form.js':           { guard: 'public' },
  'GET /modules/:file':            { guard: 'public' },
  'POST /api/login':                { guard: 'public' },
  'POST /api/logout':               { guard: 'login' },
  'GET /api/me':                    { guard: 'login' },
  'GET /api/ai/status':             { guard: 'login' },
  'GET /api/patients':              { guard: 'patients:read' },
  'GET /api/patients/:id':          { guard: 'patients:read' },
  'POST /api/patients':             { guard: 'patients:register' },
  'PATCH /api/patients/:id/archive': { guard: 'patients:archive' },
  'GET /api/patients/:id/encounters': { guard: 'patients:read' },
  'POST /api/patients/:id/encounters': { guard: 'encounters:write' },
  'POST /api/encounters/:id/close': { guard: 'encounters:write' },
  'GET /api/patients/:id/cases':    { guard: 'cases:read' },
  'POST /api/patients/:id/cases':   { guard: 'cases:write' },
  'POST /api/patients/:id/cases/import': { guard: 'cases:write' },
  'GET /api/cases/:id':             { guard: 'cases:read' },
  'PATCH /api/cases/:id':           { guard: 'cases:write' },
  'PATCH /api/cases/:id/archive':   { guard: 'cases:write' },
  'POST /api/cases/:id/encounters': { guard: 'cases:write' },
  'POST /api/cases/:id/narrative':  { guard: 'cases:write' },
  'POST /api/cases/:id/applied-sets': { guard: 'cases:write' },
  'POST /api/cases/:id/applied-sets/:asid/withdraw': { guard: 'cases:write' },
  'POST /api/cases/:id/applied-pathways': { guard: 'cases:write' },
  'POST /api/cases/:id/observations': { guard: 'cases:write' },
  'GET /api/cases/:id/timeline':    { guard: 'cases:read' },
  'GET /api/patients/:id/timeline': { guard: 'cases:read' },
  'GET /api/patients/:id/longitudinal': { guard: 'cases:read' },
  'GET /api/cases/:id/context':     { guard: 'context:read' },
  'GET /api/cases/:id/ccis-runs':   { guard: 'ccis:read' },
  'POST /api/cases/:id/ccis-runs':  { guard: 'ccis:import' },
  'POST /api/ccis-runs/:id/ack':    { guard: 'ccis:ack' },
  'POST /api/observations/:id/correct': { guard: 'cases:write' },
  'POST /api/observations/:id/entered-in-error': { guard: 'cases:write' },
  'GET /api/cases/:id/notes':       { guard: 'cases:read' },
  'POST /api/cases/:id/notes':      { guard: 'cases:write' },
  'PATCH /api/notes/:id':           { guard: 'cases:write' },
  'POST /api/notes/:id/discard':    { guard: 'cases:write' },
  'POST /api/notes/:id/sign':       { guard: 'cases:write' },
  'POST /api/notes/:id/amend':      { guard: 'cases:write' },
  'GET /api/patients/:id/problems': { guard: 'problems:read' },
  'POST /api/patients/:id/problems': { guard: 'problems:write' },
  'GET /api/problems/:id':          { guard: 'problems:read' },
  'POST /api/problems/:id/resolve': { guard: 'problems:write' },
  'POST /api/problems/:id/entered-in-error': { guard: 'problems:write' },
  'GET /api/patients/:id/allergies': { guard: 'allergies:read' },
  'POST /api/patients/:id/allergies': { guard: 'allergies:write' },
  'GET /api/allergies/:id':         { guard: 'allergies:read' },
  'POST /api/allergies/:id/resolve': { guard: 'allergies:write' },
  'POST /api/allergies/:id/entered-in-error': { guard: 'allergies:write' },
  'GET /api/patients/:id/medications': { guard: 'medications:read' },
  'POST /api/patients/:id/medications': { guard: 'medications:write' },
  'GET /api/medications/:id':       { guard: 'medications:read' },
  'POST /api/medications/:id/stop': { guard: 'medications:write' },
  'POST /api/medications/:id/entered-in-error': { guard: 'medications:write' },
  'GET /api/patients/:id/medication-orders': { guard: 'orders:read' },
  'POST /api/patients/:id/medication-orders': { guard: 'orders:write' },
  'GET /api/medication-orders/:id': { guard: 'orders:read' },
  'POST /api/medication-orders/:id/change': { guard: 'orders:write' },
  'POST /api/medication-orders/:id/stop': { guard: 'orders:write' },
  'POST /api/medication-orders/:id/entered-in-error': { guard: 'orders:write' },
  'GET /api/patients/:id/medication-reconciliation': { guard: 'orders:read' },
  'POST /api/patients/:id/medication-reconciliation': { guard: 'orders:write' },
  'GET /api/patients/:id/investigation-orders': { guard: 'orders:read' },
  'POST /api/patients/:id/investigation-orders': { guard: 'orders:write' },
  'GET /api/investigation-orders/:id': { guard: 'orders:read' },
  'POST /api/investigation-orders/:id/cancel': { guard: 'orders:write' },
  'POST /api/investigation-orders/:id/entered-in-error': { guard: 'orders:write' },
  'GET /api/investigation-orders/:id/results': { guard: 'results:read' },
  'POST /api/investigation-orders/:id/specimens': { guard: 'results:write' },
  'POST /api/investigation-orders/:id/results': { guard: 'results:write' },
  'POST /api/investigation-results/:id/correct': { guard: 'results:write' },
  'GET /api/patients/:id/referrals': { guard: 'orders:read' },
  'POST /api/patients/:id/referrals': { guard: 'orders:write' },
  'GET /api/referrals/:id': { guard: 'orders:read' },
  'POST /api/referrals/:id/cancel': { guard: 'orders:write' },
  'POST /api/referrals/:id/entered-in-error': { guard: 'orders:write' },
  'GET /api/patients/:id/procedures': { guard: 'orders:read' },
  'POST /api/patients/:id/procedures': { guard: 'orders:write' },
  'GET /api/procedures/:id': { guard: 'orders:read' },
  'POST /api/procedures/:id/cancel': { guard: 'orders:write' },
  'POST /api/procedures/:id/entered-in-error': { guard: 'orders:write' },
  'GET /api/patients/:id/administrations': { guard: 'mar:read' },
  'POST /api/patients/:id/administrations': { guard: 'mar:write' },
  'GET /api/administrations/:id': { guard: 'mar:read' },
  'POST /api/administrations/:id/entered-in-error': { guard: 'mar:write' },
  'GET /api/patients/:id/admissions': { guard: 'orders:read' },
  'POST /api/patients/:id/admissions': { guard: 'orders:write' },
  'GET /api/admissions/:id': { guard: 'orders:read' },
  'POST /api/admissions/:id/discharge': { guard: 'orders:write' },
  'GET /api/patients/:id/followups': { guard: 'orders:read' },
  'GET /api/followups/:id': { guard: 'orders:read' },
  'POST /api/admissions/:id/followups': { guard: 'orders:write' },
  'POST /api/followups/:id/cancel': { guard: 'orders:write' },
  'GET /api/import/bundles': { guard: 'import:write' },
  'POST /api/import/bundles': { guard: 'import:write' },
  'GET /api/import/bundles/:id': { guard: 'import:write' },
  'POST /api/import/proposals/:id/reject': { guard: 'import:write' },
  'GET /api/import/packages': { guard: 'import:write' },
  'POST /api/import/packages': { guard: 'import:write' },
  'GET /api/import/packages/:id': { guard: 'import:write' },
  'POST /api/import/package-proposals/:id/reject': { guard: 'import:write' },
  'POST /api/import/package-proposals/:id/accept': { guard: 'import:write' },   // D7: also needs sets:write (admin and doctor hold both)
  'POST /api/import/package-proposals/:id/accept-pathway': { guard: 'import:write' },   // D8: also needs sets:write (admin and doctor hold both)
  'POST /api/import/proposals/:id/accept': { guard: 'import:write' },   // R6f-2b: also needs cases:write (admin and doctor hold both)
  'POST /api/import/proposals/:id/accept-to-patient': { guard: 'import:write' },   // R6f-2c: also needs problems:write or allergies:write (admin and doctor hold both)
  'POST /api/followups/:id/entered-in-error': { guard: 'orders:write' },
  'POST /api/admissions/:id/cancel': { guard: 'orders:write' },
  'POST /api/admissions/:id/entered-in-error': { guard: 'orders:write' },
  'GET /api/patients/:id/abnormal-results': { guard: 'results:read' },
  'POST /api/investigation-results/:id/acknowledge': { guard: 'results:ack' },
  'GET /api/local-terms':           { guard: 'terms:read' },
  'POST /api/local-terms':          { guard: 'terms:write' },
  'GET /api/local-terms/:id':       { guard: 'terms:read' },
  'POST /api/local-terms/:id/submit':  { guard: 'terms:submit' },
  'POST /api/local-terms/:id/approve': { guard: 'terms:review' },
  'POST /api/local-terms/:id/reject':  { guard: 'terms:review' },
  'POST /api/local-terms/:id/publish': { guard: 'terms:publish' },
  'POST /api/local-terms/:id/retire':  { guard: 'terms:publish' },
  'GET /api/element-sets':          { guard: 'sets:read' },
  'POST /api/element-sets':         { guard: 'sets:write' },
  'GET /api/element-sets/:id':      { guard: 'sets:read' },
  'GET /api/element-sets/:id/versions/:version': { guard: 'sets:read' },
  'POST /api/element-sets/:id/versions': { guard: 'sets:write' },
  'POST /api/element-sets/:id/versions/:version/submit': { guard: 'sets:submit' },
  'GET /api/element-sets/:id/versions/:version/review': { guard: 'sets:read' },
  'GET /api/review-queue':          { guard: 'sets:read' },
  'POST /api/element-sets/:id/versions/:version/approve': { guard: 'sets:review' },
  'POST /api/element-sets/:id/versions/:version/reject': { guard: 'sets:review' },
  'POST /api/element-sets/:id/versions/:version/publish': { guard: 'sets:publish' },
  'POST /api/element-sets/:id/versions/:version/retire': { guard: 'sets:publish' },
  'GET /api/pathways':              { guard: 'sets:read' },
  'POST /api/pathways':             { guard: 'sets:write' },
  'GET /api/pathways/:id':          { guard: 'sets:read' },
  'GET /api/pathways/:id/versions/:version': { guard: 'sets:read' },
  'POST /api/pathways/:id/versions': { guard: 'sets:write' },
  'POST /api/pathways/:id/versions/:version/publish': { guard: 'sets:publish' },
  'GET /api/audit':                 { guard: 'audit:read' },
  'PUT /api/ai/settings':           { guard: 'ai:admin' },
  'POST /api/ai/preview':           { guard: 'ai:use' },
  'POST /api/ai/run':               { guard: 'ai:use' },
};

// Who may hold each permission. Independent copy: widening permissions.js must break this test on purpose.
const EXPECTED_ROLES = {
  'patients:read':     ['admin', 'doctor', 'nurse', 'viewer'],
  'patients:register': ['admin', 'doctor', 'nurse'],
  'patients:archive':  ['admin', 'doctor'],
  'encounters:write':  ['admin', 'doctor', 'nurse'],
  'cases:read':        ['admin', 'doctor', 'nurse', 'viewer'],
  'cases:write':       ['admin', 'doctor', 'nurse'],
  'sets:read':         ['admin', 'doctor', 'nurse', 'viewer', 'informatician'],
  'sets:write':        ['admin', 'doctor'],
  'sets:submit':       ['admin', 'doctor'],
  'sets:review':       ['informatician'],
  'sets:publish':      ['admin'],
  'terms:read':        ['admin', 'doctor', 'nurse', 'viewer', 'informatician'],
  'terms:write':       ['admin', 'doctor'],
  'terms:submit':      ['admin', 'doctor'],
  'terms:review':      ['informatician'],
  'terms:publish':     ['admin'],
  'problems:read':     ['admin', 'doctor', 'nurse', 'viewer'],
  'problems:write':    ['admin', 'doctor', 'nurse'],
  'allergies:read':    ['admin', 'doctor', 'nurse', 'viewer'],
  'allergies:write':   ['admin', 'doctor', 'nurse'],
  'medications:read':  ['admin', 'doctor', 'nurse', 'viewer'],
  'medications:write': ['admin', 'doctor', 'nurse'],
  'orders:read':       ['admin', 'doctor', 'nurse', 'viewer'],
  'orders:write':      ['admin', 'doctor'],
  'mar:read':          ['admin', 'doctor', 'nurse', 'viewer'],
  'mar:write':         ['admin', 'doctor', 'nurse'],
  'results:read':      ['admin', 'doctor', 'nurse', 'viewer'],
  'results:write':     ['admin', 'doctor', 'nurse'],
  'results:ack':       ['admin', 'doctor'],
  'import:write':      ['admin', 'doctor'],
  'audit:read':        ['admin'],
  'context:read':      ['admin', 'doctor'],
  'ccis:import':       ['admin', 'doctor'],
  'ccis:read':         ['admin', 'doctor', 'nurse', 'viewer'],
  'ccis:ack':          ['admin', 'doctor'],
  'ai:use':            ['admin', 'doctor'],
  'ai:admin':          ['admin'],
};

let env, routes;
test.before(async () => { env = await setup(); routes = listRoutes(env.pool); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); const r = await c.login(user); assert.equal(r.status, 200, user); return c; };
const roleUser = role => role + '1';
const auditRows = async () => (await env.pool.query('SELECT * FROM audit_log ORDER BY id')).rows;
const allowed = guard => (guard === 'public' || guard === 'login' ? ROLES : EXPECTED_ROLES[guard]);
const blockedBy = r => r.body && (r.body.error === 'login_required' || r.body.error === 'forbidden');
const call = (c, key, { body = {}, headers } = {}) => {
  const [method, path] = key.split(' ');
  return c.raw(method, fill(path), isWrite(key) ? body : undefined, headers);
};

// ---------- 1. permission matrix ----------
test('matrix covers exactly the routes the app registers (a new route must be added to the matrix)', () => {
  assert.deepEqual(routes, Object.keys(MATRIX).sort());
});

test('permissions.js grants exactly the roles in the spec, and no permission is unused', () => {
  const actual = Object.fromEntries(Object.entries(PERMS).map(([k, v]) => [k, [...v].sort()]));
  const spec = Object.fromEntries(Object.entries(EXPECTED_ROLES).map(([k, v]) => [k, [...v].sort()]));
  assert.deepEqual(actual, spec);
  const used = new Set(Object.values(MATRIX).map(m => m.guard).filter(g => g.includes(':')));
  assert.deepEqual([...used].sort(), Object.keys(PERMS).sort(), 'every permission guards at least one route');
});

test('signed out: every guarded route says login_required (401); public routes do not', async () => {
  const anon = client(env.base);
  const bad = [];
  for (const [key, { guard }] of Object.entries(MATRIX)) {
    const r = await call(anon, key);
    const blocked = r.body && r.body.error === 'login_required';
    if (guard === 'public' ? blocked || r.status === 403 : !(r.status === 401 && blocked)) bad.push(`${key} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(bad, []);
});

test('every route x every role: allowed roles get past the guard, all others get 403 and the denial is audited', async () => {
  const before = (await auditRows()).length;
  const bad = []; let denied = 0;
  for (const role of ROLES) {
    const c = await as(roleUser(role));
    // logout last, it ends this session
    const keys = Object.keys(MATRIX).sort((a, b) => (a === 'POST /api/logout') - (b === 'POST /api/logout'));
    for (const key of keys) {
      const { guard } = MATRIX[key];
      const r = await call(c, key);
      const ok = allowed(guard).includes(role);
      if (ok) {
        if (blockedBy(r) || r.status >= 500) bad.push(`${role} ${key} should pass the guard, got ${r.status} ${JSON.stringify(r.body)}`);
      } else {
        denied++;
        if (r.status !== 403 || !r.body || r.body.error !== 'forbidden' || r.body.perm !== guard) bad.push(`${role} ${key} should be 403 forbidden(${guard}), got ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(denied >= 10, 'the matrix really exercises denials');
  const denials = (await auditRows()).slice(before).filter(r => r.action === 'permission.denied');
  assert.equal(denials.length, denied, 'every 403 is in the audit log');
  for (const d of denials) { assert.ok(d.username && d.role && d.detail.perm && d.detail.path, JSON.stringify(d)); assert.equal(d.username, roleUser(d.role)); }
});

test('dead sessions never pass a guard: forged cookie, expired session, deactivated user', async () => {
  const guarded = Object.entries(MATRIX).filter(([, m]) => m.guard !== 'public').map(([k]) => k);
  const sweep = async (c, why, headers) => {
    for (const key of guarded) { const r = await call(c, key, { headers }); assert.equal(r.status, 401, `${why}: ${key} -> ${r.status}`); }
  };
  await sweep(client(env.base), 'forged cookie', { cookie: 'sid=forged-token' });

  const exp = await as('nurse1');
  assert.equal((await exp.get('/api/me')).status, 200);
  await env.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE username = 'nurse1')`);
  await sweep(exp, 'expired');

  const off = await as('viewer1');
  assert.equal((await off.get('/api/me')).status, 200);
  await env.pool.query(`UPDATE users SET active = false WHERE username = 'viewer1'`);
  await sweep(off, 'deactivated');
  assert.equal((await client(env.base).login('viewer1')).status, 401, 'a deactivated user cannot sign in either');
  await env.pool.query(`UPDATE users SET active = true WHERE username = 'viewer1'`);
});

test('every write route refuses a request without the X-EMR header, and writes nothing', async () => {
  const lr = await fetch(env.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-emr': '1' },
    body: JSON.stringify({ username: 'admin1', password: PW }) });
  assert.equal(lr.status, 200);
  const cookie = lr.headers.get('set-cookie').split(';')[0];
  const before = (await auditRows()).length;
  const bad = [];
  for (const key of Object.keys(MATRIX).filter(isWrite)) {
    const [method, path] = key.split(' ');
    const res = await fetch(env.base + fill(path), { method, headers: { 'content-type': 'application/json', cookie }, body: '{}' });
    if (res.status !== 400) bad.push(`${key} -> ${res.status}`);
  }
  assert.deepEqual(bad, []);
  assert.equal((await auditRows()).length, before, 'refused requests wrote no audit rows and changed nothing');
});

// ---------- 3. audit coverage ----------
// One real, successful write per write route, in dependency order. Each lists the audit actions it must leave.
// POST /api/ai/preview stores nothing (the request lives in memory until it is sent); its refusal is audited
// at once and the call itself is audited when it is sent (ai.request / ai.result via POST /api/ai/run).
let prov, provUrl;
function startProvider() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"title":"x","fields":[]}' } }] })); });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('audit coverage: every write route leaves an audit row, written from the session, never from the body', async () => {
  prov = await startProvider();
  provUrl = `http://127.0.0.1:${prov.address().port}`;
  const aenv = await setup({ contextSecret: SECRET, ai: { provider: 'openrouter', key: 'k-test', model: 'test/m', baseUrl: provUrl, timeoutMs: 5000 } });
  try {
    const aroutes = listRoutes(aenv.pool);
    const writeRoutes = aroutes.filter(isWrite);
    const fake = { username: 'mallory', role: 'admin', user: 'mallory', userId: 1, actor: 'mallory', createdBy: 1, signedBy: 'mallory' };
    const S = {};   // shared state between steps
    const who = (u, c) => ({ u, c });
    const nurse = who('nurse1', client(aenv.base)), reviewer = who('informatician1', client(aenv.base)), doctor = who('doctor1', client(aenv.base)), admin = who('admin1', client(aenv.base));
    const rows = async () => (await aenv.pool.query('SELECT * FROM audit_log ORDER BY id')).rows;

    const steps = [
      ['POST /api/login', null, async () => {                        // login is public: success and failure are both audited
        assert.equal((await nurse.c.login('nurse1', 'wrong-password')).status, 401);
        for (const w of [nurse, doctor, admin, reviewer]) assert.equal((await w.c.login(w.u)).status, 200);
        return ['login.failed', 'login'];
      }],
      ['POST /api/patients', nurse, async () => {
        const r = await nurse.c.post('/api/patients', { name: 'Audit Patient', mrn: 'AUD-1', dob: '1980-01-01', sex: 'F', ...fake });
        assert.equal(r.status, 201); S.pid = r.body.patient.id; return ['patient.register'];
      }],
      ['POST /api/patients/:id/encounters', nurse, async () => {
        const r = await nurse.c.post(`/api/patients/${S.pid}/encounters`, { bed: 'AUD-BED', ...fake });
        assert.equal(r.status, 201); S.eid = r.body.encounter.id; return ['encounter.open'];
      }],
      ['POST /api/encounters/:id/close', nurse, async () => {
        const r = await nurse.c.post(`/api/encounters/${S.eid}/close`, { ...fake });
        assert.equal(r.status, 200); return ['encounter.close'];
      }],
      ['POST /api/patients/:id/cases', nurse, async () => {          // cases refuse forged actor fields, so no `...fake` here (see test/cases.test.js)
        const r = await nurse.c.post(`/api/patients/${S.pid}/cases`, { title: 'Audit case' });
        assert.equal(r.status, 201); S.cid = r.body.case.id; S.crv = r.body.case.row_version; return ['case.create'];
      }],
      ['POST /api/patients/:id/cases/import', nurse, async () => {   // like create: no `...fake` (unknown body keys are refused)
        const r = await nurse.c.post(`/api/patients/${S.pid}/cases/import`, { title: 'Imported demo case', narrative: 'Imported narrative', localId: 'c_demo1' });
        assert.equal(r.status, 201); return ['case.import'];
      }],
      ['POST /api/cases/:id/narrative', nurse, async () => {
        assert.equal((await nurse.c.post(`/api/cases/${S.cid}/narrative`, { body: 'Audit narrative' })).status, 201);
        return ['case.narrative_add'];
      }],
      ['POST /api/cases/:id/encounters', nurse, async () => {
        const r = await nurse.c.post(`/api/cases/${S.cid}/encounters`, { encounterId: S.eid, relationType: 'reviewed' });
        assert.equal(r.status, 201, JSON.stringify(r.body)); return ['case.link_encounter'];
      }],
      ['PATCH /api/cases/:id', nurse, async () => {
        const r = await nurse.c.patch(`/api/cases/${S.cid}`, { status: 'resolved', rowVersion: S.crv });
        assert.equal(r.status, 200, JSON.stringify(r.body)); S.crv = r.body.case.row_version; return ['case.update'];
      }],
      ['PATCH /api/cases/:id/archive', doctor, async () => {
        const a = await doctor.c.patch(`/api/cases/${S.cid}/archive`, { archived: true, rowVersion: S.crv });
        assert.equal(a.status, 200, JSON.stringify(a.body));
        assert.equal((await doctor.c.patch(`/api/cases/${S.cid}/archive`, { archived: false, rowVersion: a.body.case.row_version })).status, 200);
        return ['case.archive', 'case.restore'];
      }],
      ['POST /api/element-sets', doctor, async () => {              // like cases: no `...fake` (unknown body keys are refused)
        const r = await doctor.c.post('/api/element-sets', { slug: 'audit-set', kind: 'custom', definition: { title: 'Audit set', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
        assert.equal(r.status, 201, JSON.stringify(r.body)); S.setId = r.body.set.id; return ['set.create'];
      }],
      ['POST /api/element-sets/:id/versions', doctor, async () => {
        const r = await doctor.c.post(`/api/element-sets/${S.setId}/versions`, { definition: { title: 'Audit set v2', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
        assert.equal(r.status, 201, JSON.stringify(r.body)); S.setV = r.body.version.version; return ['set.version_create'];
      }],
      ['POST /api/element-sets/:id/versions/:version/submit', doctor, async () => {
        const v = await doctor.c.post(`/api/element-sets/${S.setId}/versions`, { definition: { title: 'Audit set v3', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
        assert.equal(v.status, 201, JSON.stringify(v.body));
        const r = await doctor.c.post(`/api/element-sets/${S.setId}/versions/${v.body.version.version}/submit`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); S.revV = v.body.version.version; return ['set.submit'];
      }],
      ['POST /api/element-sets/:id/versions/:version/approve', reviewer, async () => {
        const r = await reviewer.c.post(`/api/element-sets/${S.setId}/versions/${S.revV}/approve`, { reason: 'Audit approval' });
        assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'reviewed'); return ['set.approve'];
      }],
      ['POST /api/element-sets/:id/versions/:version/reject', reviewer, async () => {
        const v = await doctor.c.post(`/api/element-sets/${S.setId}/versions`, { definition: { title: 'Audit set v4', fields: [{ id: 'a', label: 'A', type: 'text' }] } });
        assert.equal(v.status, 201, JSON.stringify(v.body));
        assert.equal((await doctor.c.post(`/api/element-sets/${S.setId}/versions/${v.body.version.version}/submit`, {})).status, 200);
        const r = await reviewer.c.post(`/api/element-sets/${S.setId}/versions/${v.body.version.version}/reject`, { reason: 'Audit rejection' });
        assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'rejected'); return ['set.reject'];
      }],
      ['POST /api/element-sets/:id/versions/:version/publish', admin, async () => {
        const r = await admin.c.post(`/api/element-sets/${S.setId}/versions/${S.revV}/publish`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['set.publish'];
      }],
      ['POST /api/element-sets/:id/versions/:version/retire', admin, async () => {
        const r = await admin.c.post(`/api/element-sets/${S.setId}/versions/${S.revV}/retire`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['set.retire'];
      }],
      ['POST /api/cases/:id/applied-sets', nurse, async () => {      // B3a: a published set is needed, so it is made, reviewed and published first (those routes have their own steps above)
        const def = { title: 'Audit obs set', fields: [{ id: 'hr', label: 'Heart rate', type: 'number', unit: 'bpm' }] };
        const made = await doctor.c.post('/api/element-sets', { slug: 'audit-obs-set', kind: 'custom', definition: def });
        assert.equal(made.status, 201, JSON.stringify(made.body)); S.obsSet = made.body.set.id;
        assert.equal((await doctor.c.post(`/api/element-sets/${S.obsSet}/versions/1/submit`, {})).status, 200);
        assert.equal((await reviewer.c.post(`/api/element-sets/${S.obsSet}/versions/1/approve`, { reason: 'Audit approval' })).status, 200);
        assert.equal((await admin.c.post(`/api/element-sets/${S.obsSet}/versions/1/publish`, {})).status, 200);
        const r = await nurse.c.post(`/api/cases/${S.cid}/applied-sets`, { setId: S.obsSet, version: 1 });
        assert.equal(r.status, 201, JSON.stringify(r.body)); S.asid = r.body.appliedSet.id; return ['case.set_apply'];
      }],
      ['POST /api/pathways', doctor, async () => {                  // B4a: pathway steps name published set versions (S.obsSet is published above)
        const r = await doctor.c.post('/api/pathways', { slug: 'audit-pathway', title: 'Audit pathway', steps: [{ setId: S.obsSet, version: 1 }] });
        assert.equal(r.status, 201, JSON.stringify(r.body)); S.pwId = r.body.pathway.id; return ['pathway.create'];
      }],
      ['POST /api/pathways/:id/versions', doctor, async () => {
        const r = await doctor.c.post(`/api/pathways/${S.pwId}/versions`, { title: 'Audit pathway v2', steps: [{ setId: S.obsSet, version: 1 }] });
        assert.equal(r.status, 201, JSON.stringify(r.body)); return ['pathway.version_create'];
      }],
      ['POST /api/pathways/:id/versions/:version/publish', admin, async () => {
        const r = await admin.c.post(`/api/pathways/${S.pwId}/versions/1/publish`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['pathway.publish'];
      }],
      ['POST /api/cases/:id/applied-pathways', nurse, async () => {   // a second case, so the set pinned above is not already on it
        const p = await nurse.c.post('/api/patients', { name: 'Audit Pathway Patient', mrn: 'AUD-PW-1', dob: '1980-01-01', sex: 'F' });
        assert.equal(p.status, 201, JSON.stringify(p.body));
        const k = await nurse.c.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Audit pathway case' });
        assert.equal(k.status, 201, JSON.stringify(k.body));
        const r = await nurse.c.post(`/api/cases/${k.body.case.id}/applied-pathways`, { pathwayId: S.pwId, version: 1 });
        assert.equal(r.status, 201, JSON.stringify(r.body)); return ['case.pathway_apply'];
      }],
      ['POST /api/local-terms', doctor, async () => {              // R2f-1: a draft local term (audited with its code and version)
        const r = await doctor.c.post('/api/local-terms', { code: 'audit.term', display: 'Audit term' });
        assert.equal(r.status, 201, JSON.stringify(r.body)); return ['term.create'];
      }],
      ['POST /api/local-terms/:id/submit', doctor, async () => {   // R2f-2: the whole local-term path, one scenario per route
        S.tid = (await doctor.c.post('/api/local-terms', { code: 'audit.flow', display: 'Audit flow' })).body.term.id;
        const r = await doctor.c.post(`/api/local-terms/${S.tid}/submit`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['term.create', 'term.submit'];
      }],
      ['POST /api/local-terms/:id/approve', reviewer, async () => {
        const r = await reviewer.c.post(`/api/local-terms/${S.tid}/approve`, { reason: 'Audit approval' });
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['term.approve'];
      }],
      ['POST /api/local-terms/:id/reject', reviewer, async () => {
        const t = (await doctor.c.post('/api/local-terms', { code: 'audit.rej', display: 'Audit reject' })).body.term.id;
        assert.equal((await doctor.c.post(`/api/local-terms/${t}/submit`, {})).status, 200);
        const r = await reviewer.c.post(`/api/local-terms/${t}/reject`, { reason: 'Audit rejection' });
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['term.reject'];
      }],
      ['POST /api/local-terms/:id/publish', admin, async () => {
        const r = await admin.c.post(`/api/local-terms/${S.tid}/publish`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['term.publish'];
      }],
      ['POST /api/local-terms/:id/retire', admin, async () => {
        const r = await admin.c.post(`/api/local-terms/${S.tid}/retire`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['term.retire'];
      }],
      ['POST /api/cases/:id/ccis-runs', doctor, async () => {       // DM2a: needs a real export of the same case; the body is a CCIS record, so unknown keys are refused (no `...fake`)
        const k = await caseWithExport(doctor.c, aenv.pool);
        const r = await doctor.c.post(`/api/cases/${k.caseId}/ccis-runs`, runRecord(k));
        assert.equal(r.status, 201, JSON.stringify(r.body)); S.runId = r.body.run.id; return ['ccis.import'];
      }],
      ['POST /api/ccis-runs/:id/ack', doctor, async () => {
        const r = await doctor.c.post(`/api/ccis-runs/${S.runId}/ack`, { note: 'Audit acknowledgement' });
        assert.equal(r.status, 201, JSON.stringify(r.body)); return ['ccis.ack'];
      }],
      ['POST /api/cases/:id/observations', nurse, async () => {
        const r = await nurse.c.post(`/api/cases/${S.cid}/observations`, { observations: [{ appliedSetId: S.asid, fieldKey: 'hr', value: 72, effectiveAt: '2020-01-01T10:00:00Z', sourceType: 'clinician' }] });
        assert.equal(r.status, 201, JSON.stringify(r.body)); S.oid = r.body.observations[0].id; return ['observation.record'];
      }],
      ['POST /api/import/proposals/:id/accept', doctor, async () => {      // R6f-2b: needs the applied set of the observations step above (still active here)
        const b = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'Observation', status: 'final', code: { text: 'Audit accept sample' }, valueQuantity: { value: 71, unit: 'bpm' }, effectiveDateTime: '2020-01-02T10:00:00Z' } }] };
        const st = await doctor.c.post('/api/import/bundles', b);
        assert.equal(st.status, 201, JSON.stringify(st.body)); const p = st.body.bundle.proposals[0];
        const mine = { caseId: S.cid, appliedSetId: S.asid, fieldKey: 'hr', rowVersion: p.row_version };
        assert.equal((await doctor.c.post(`/api/import/proposals/${p.id}/accept`, { ...mine, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/import/proposals/${p.id}/accept`, mine);
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.observation.recorded_by, 'doctor1');
        return ['import.proposal_accept', 'observation.record', 'import.stage'];
      }],
      ['POST /api/import/proposals/:id/accept-to-patient', doctor, async () => {      // R6f-2c: a problem and an allergy go to the patient of the audit scenario
        const b = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'Condition', code: { text: 'Audit imported problem' }, clinicalStatus: { coding: [{ code: 'active' }] } } },
          { resource: { resourceType: 'AllergyIntolerance', code: { text: 'Audit imported substance' }, clinicalStatus: { coding: [{ code: 'active' }] } } }] };
        const st = await doctor.c.post('/api/import/bundles', b);
        assert.equal(st.status, 201, JSON.stringify(st.body)); const [pc, pa] = st.body.bundle.proposals;
        assert.equal((await doctor.c.post(`/api/import/proposals/${pc.id}/accept-to-patient`, { rowVersion: pc.row_version, patientId: S.pid, ...fake })).status, 400, 'a body that names a user is refused');
        for (const p of [pc, pa]) { const ok = await doctor.c.post(`/api/import/proposals/${p.id}/accept-to-patient`, { rowVersion: p.row_version, patientId: S.pid }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); }
        return ['import.proposal_accept', 'problem.add', 'allergy.add', 'import.stage'];
      }],
      ['POST /api/observations/:id/correct', nurse, async () => {
        const r = await nurse.c.post(`/api/observations/${S.oid}/correct`, { value: 74, sourceType: 'clinician', reason: 'Audit correction' });
        assert.equal(r.status, 201, JSON.stringify(r.body)); S.oid2 = r.body.observation.id; return ['observation.correct'];
      }],
      ['POST /api/observations/:id/entered-in-error', nurse, async () => {
        const r = await nurse.c.post(`/api/observations/${S.oid2}/entered-in-error`, { reason: 'Audit entered in error' });
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['observation.entered_in_error'];
      }],
      ['POST /api/cases/:id/applied-sets/:asid/withdraw', nurse, async () => {
        const r = await nurse.c.post(`/api/cases/${S.cid}/applied-sets/${S.asid}/withdraw`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['case.set_withdraw'];
      }],
      ['POST /api/cases/:id/notes', nurse, async () => {
        const r = await nurse.c.post(`/api/cases/${S.cid}/notes`, { body: 'Audit note' });
        assert.equal(r.status, 201, JSON.stringify(r.body)); S.nid = r.body.note.id; return ['note.create'];
      }],
      ['PATCH /api/notes/:id', nurse, async () => {
        const r = await nurse.c.patch(`/api/notes/${S.nid}`, { body: 'Audit note edited', rowVersion: 1 });
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['note.update'];
      }],
      ['POST /api/notes/:id/discard', nurse, async () => {
        const k = await nurse.c.post(`/api/cases/${S.cid}/notes`, { body: 'Audit discard' });
        assert.equal(k.status, 201, JSON.stringify(k.body));
        const r = await nurse.c.post(`/api/notes/${k.body.note.id}/discard`, { rowVersion: 1 });
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['note.create', 'note.discard'];
      }],
      ['POST /api/notes/:id/sign', nurse, async () => {
        const r = await nurse.c.post(`/api/notes/${S.nid}/sign`, { rowVersion: 2 });
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['note.sign'];
      }],
      ['POST /api/notes/:id/amend', nurse, async () => {
        const r = await nurse.c.post(`/api/notes/${S.nid}/amend`, { body: 'Audit note amended', reason: 'Audit amendment', amendmentCount: 0 });
        assert.equal(r.status, 201, JSON.stringify(r.body)); return ['note.amend'];
      }],
      ['POST /api/patients/:id/problems', nurse, async () => {
        const r = await nurse.c.post(`/api/patients/${S.pid}/problems`, { label: 'Audit problem', ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/patients/${S.pid}/problems`, { label: 'Audit problem' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); return ['problem.add'];
      }],
      ['POST /api/problems/:id/resolve', nurse, async () => {
        const a = await nurse.c.post(`/api/patients/${S.pid}/problems`, { label: 'Audit resolve' });
        const r = await nurse.c.post(`/api/problems/${a.body.problem.id}/resolve`, { reason: 'Audit resolution', rowVersion: 1, ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/problems/${a.body.problem.id}/resolve`, { reason: 'Audit resolution', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); S.prid = a.body.problem.id; return ['problem.add', 'problem.resolve'];
      }],
      ['POST /api/problems/:id/entered-in-error', nurse, async () => {
        const ok = await nurse.c.post(`/api/problems/${S.prid}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['problem.error'];
      }],
      ['POST /api/patients/:id/allergies', nurse, async () => {
        const r = await nurse.c.post(`/api/patients/${S.pid}/allergies`, { substance: 'Audit allergy', ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/patients/${S.pid}/allergies`, { substance: 'Audit allergy' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); return ['allergy.add'];
      }],
      ['POST /api/allergies/:id/resolve', nurse, async () => {
        const a = await nurse.c.post(`/api/patients/${S.pid}/allergies`, { substance: 'Audit resolve' });
        const r = await nurse.c.post(`/api/allergies/${a.body.allergy.id}/resolve`, { reason: 'Audit resolution', rowVersion: 1, ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/allergies/${a.body.allergy.id}/resolve`, { reason: 'Audit resolution', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); S.alid = a.body.allergy.id; return ['allergy.add', 'allergy.resolve'];
      }],
      ['POST /api/allergies/:id/entered-in-error', nurse, async () => {
        const ok = await nurse.c.post(`/api/allergies/${S.alid}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['allergy.error'];
      }],
      ['POST /api/patients/:id/medications', nurse, async () => {
        const r = await nurse.c.post(`/api/patients/${S.pid}/medications`, { medication: 'Audit medication', ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/patients/${S.pid}/medications`, { medication: 'Audit medication' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); return ['medication.add'];
      }],
      ['POST /api/medications/:id/stop', nurse, async () => {
        const a = await nurse.c.post(`/api/patients/${S.pid}/medications`, { medication: 'Audit stop' });
        const r = await nurse.c.post(`/api/medications/${a.body.medication.id}/stop`, { reason: 'Audit stop reason', rowVersion: 1, ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/medications/${a.body.medication.id}/stop`, { reason: 'Audit stop reason', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); S.mdid = a.body.medication.id; return ['medication.add', 'medication.stop'];
      }],
      ['POST /api/medications/:id/entered-in-error', nurse, async () => {
        const ok = await nurse.c.post(`/api/medications/${S.mdid}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['medication.error'];
      }],
      ['POST /api/patients/:id/medication-orders', doctor, async () => {
        const body = { medication: 'Audit order', doseText: 'as typed', routeText: 'as typed', frequencyText: 'as typed' };
        const r = await doctor.c.post(`/api/patients/${S.pid}/medication-orders`, { ...body, ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/patients/${S.pid}/medication-orders`, body);
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.moid = ok.body.order.id; return ['medication_order.add'];
      }],
      ['POST /api/medication-orders/:id/change', doctor, async () => {
        const body = { medication: 'Audit order 2', doseText: 'as typed', routeText: 'as typed', frequencyText: 'as typed', reason: 'Audit change', rowVersion: 1 };
        assert.equal((await doctor.c.post(`/api/medication-orders/${S.moid}/change`, { ...body, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/medication-orders/${S.moid}/change`, body);
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); S.moid2 = ok.body.newOrder.id; return ['medication_order.change'];
      }],
      ['POST /api/medication-orders/:id/stop', doctor, async () => {
        assert.equal((await doctor.c.post(`/api/medication-orders/${S.moid2}/stop`, { reason: 'Audit stop', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/medication-orders/${S.moid2}/stop`, { reason: 'Audit stop', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['medication_order.stop'];
      }],
      ['POST /api/medication-orders/:id/entered-in-error', doctor, async () => {
        const ok = await doctor.c.post(`/api/medication-orders/${S.moid2}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['medication_order.error'];
      }],
      ['POST /api/patients/:id/medication-reconciliation', doctor, async () => {
        const m = await doctor.c.post(`/api/patients/${S.pid}/medications`, { medication: 'Audit reconcile' });
        const body = { medicationId: m.body.medication.id, decision: 'not_taken', reason: 'Audit reason' };
        assert.equal((await doctor.c.post(`/api/patients/${S.pid}/medication-reconciliation`, { ...body, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/patients/${S.pid}/medication-reconciliation`, body);
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); return ['medication.add', 'medication_reconciliation.record'];
      }],
      ['POST /api/patients/:id/investigation-orders', doctor, async () => {
        const r = await doctor.c.post(`/api/patients/${S.pid}/investigation-orders`, { testName: 'Audit test', ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/patients/${S.pid}/investigation-orders`, { testName: 'Audit test' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.ioid = ok.body.order.id; return ['investigation_order.add'];
      }],
      ['POST /api/investigation-orders/:id/cancel', doctor, async () => {
        assert.equal((await doctor.c.post(`/api/investigation-orders/${S.ioid}/cancel`, { reason: 'Audit cancel', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/investigation-orders/${S.ioid}/cancel`, { reason: 'Audit cancel', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['investigation_order.cancel'];
      }],
      ['POST /api/investigation-orders/:id/specimens', nurse, async () => {
        const o = await doctor.c.post(`/api/patients/${S.pid}/investigation-orders`, { testName: 'Audit result order' }); S.irid = o.body.order.id;
        const r = await nurse.c.post(`/api/investigation-orders/${S.irid}/specimens`, { specimenType: 'Audit specimen', ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/investigation-orders/${S.irid}/specimens`, { specimenType: 'Audit specimen' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); return ['investigation_order.add', 'investigation_specimen.add'];
      }],
      ['POST /api/investigation-orders/:id/results', nurse, async () => {
        assert.equal((await nurse.c.post(`/api/investigation-orders/${S.irid}/results`, { valueText: 'v', ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/investigation-orders/${S.irid}/results`, { valueText: 'v' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.irrid = ok.body.result.id; return ['investigation_result.add'];
      }],
      ['POST /api/investigation-results/:id/correct', nurse, async () => {
        assert.equal((await nurse.c.post(`/api/investigation-results/${S.irrid}/correct`, { valueText: 'v2', reason: 'Audit correct', ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/investigation-results/${S.irrid}/correct`, { valueText: 'v2', reason: 'Audit correct' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); return ['investigation_result.correct'];
      }],
      ['POST /api/investigation-results/:id/acknowledge', doctor, async () => {
        const r = await doctor.c.post(`/api/investigation-orders/${S.irid}/results`, { valueText: 'Audit abnormal', flag: 'abnormal' });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal((await doctor.c.post(`/api/investigation-results/${r.body.result.id}/acknowledge`, { note: 'Audit note', ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/investigation-results/${r.body.result.id}/acknowledge`, { note: 'Audit note' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); return ['investigation_result.add', 'investigation_result.acknowledge'];
      }],
      ['POST /api/investigation-orders/:id/entered-in-error', doctor, async () => {
        const ok = await doctor.c.post(`/api/investigation-orders/${S.ioid}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['investigation_order.error'];
      }],
      ['POST /api/patients/:id/referrals', doctor, async () => {
        const r = await doctor.c.post(`/api/patients/${S.pid}/referrals`, { destination: 'Audit clinic', reason: 'Audit reason', ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/patients/${S.pid}/referrals`, { destination: 'Audit clinic', reason: 'Audit reason' });
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.rfid = ok.body.referral.id; return ['referral.add'];
      }],
      ['POST /api/referrals/:id/cancel', doctor, async () => {
        assert.equal((await doctor.c.post(`/api/referrals/${S.rfid}/cancel`, { reason: 'Audit cancel', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/referrals/${S.rfid}/cancel`, { reason: 'Audit cancel', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['referral.cancel'];
      }],
      ['POST /api/referrals/:id/entered-in-error', doctor, async () => {
        const ok = await doctor.c.post(`/api/referrals/${S.rfid}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['referral.error'];
      }],
      ['POST /api/patients/:id/procedures', doctor, async () => {
        const body = { procedure: 'Audit procedure', performedAt: '2026-11-20T09:30:00+05:45', outcome: 'Audit outcome' };
        const r = await doctor.c.post(`/api/patients/${S.pid}/procedures`, { ...body, ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/patients/${S.pid}/procedures`, body);
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.prid = ok.body.procedure.id; return ['procedure.add'];
      }],
      ['POST /api/procedures/:id/cancel', doctor, async () => {
        assert.equal((await doctor.c.post(`/api/procedures/${S.prid}/cancel`, { reason: 'Audit cancel', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/procedures/${S.prid}/cancel`, { reason: 'Audit cancel', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['procedure.cancel'];
      }],
      ['POST /api/procedures/:id/entered-in-error', doctor, async () => {
        const ok = await doctor.c.post(`/api/procedures/${S.prid}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['procedure.error'];
      }],
      ['POST /api/patients/:id/admissions', doctor, async () => {
        const body = { ward: 'Audit ward', reason: 'Audit reason', admittedAt: '2026-11-20T09:30:00+05:45' };
        const r = await doctor.c.post(`/api/patients/${S.pid}/admissions`, { ...body, ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/patients/${S.pid}/admissions`, body);
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.adid = ok.body.admission.id; return ['admission.add'];
      }],
      ['POST /api/admissions/:id/cancel', doctor, async () => {
        assert.equal((await doctor.c.post(`/api/admissions/${S.adid}/cancel`, { reason: 'Audit cancel', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/admissions/${S.adid}/cancel`, { reason: 'Audit cancel', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['admission.cancel'];
      }],
      ['POST /api/admissions/:id/entered-in-error', doctor, async () => {
        const ok = await doctor.c.post(`/api/admissions/${S.adid}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['admission.error'];
      }],
      ['POST /api/admissions/:id/discharge', doctor, async () => {
        const a = await doctor.c.post(`/api/patients/${S.pid}/admissions`, { ward: 'Audit ward 2', reason: 'Audit reason 2', admittedAt: '2026-11-20T09:30:00+05:45' });
        assert.equal(a.status, 201, JSON.stringify(a.body));
        const body = { dischargedAt: '2026-11-21T09:30:00+05:45', summary: 'Audit summary', condition: 'Audit condition', rowVersion: 1 };
        assert.equal((await doctor.c.post(`/api/admissions/${a.body.admission.id}/discharge`, { ...body, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/admissions/${a.body.admission.id}/discharge`, body);
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['admission.discharge'];
      }],
      ['POST /api/admissions/:id/followups', doctor, async () => {
        const a = await doctor.c.post(`/api/patients/${S.pid}/admissions`, { ward: 'Audit ward 3', reason: 'Audit reason 3', admittedAt: '2026-11-20T09:30:00+05:45' });
        assert.equal(a.status, 201, JSON.stringify(a.body));
        const d = await doctor.c.post(`/api/admissions/${a.body.admission.id}/discharge`, { dischargedAt: '2026-11-21T09:30:00+05:45', summary: 'Audit summary 3', rowVersion: 1 });
        assert.equal(d.status, 200, JSON.stringify(d.body));
        const body = { instruction: 'Audit instruction', where: 'Audit place', followUpOn: '2026-12-01' };
        assert.equal((await doctor.c.post(`/api/admissions/${a.body.admission.id}/followups`, { ...body, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/admissions/${a.body.admission.id}/followups`, body);
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.fuid = ok.body.followup.id; return ['followup.add'];
      }],
      ['POST /api/followups/:id/cancel', doctor, async () => {
        assert.equal((await doctor.c.post(`/api/followups/${S.fuid}/cancel`, { reason: 'Audit cancel', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/followups/${S.fuid}/cancel`, { reason: 'Audit cancel', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['followup.cancel'];
      }],
      ['POST /api/followups/:id/entered-in-error', doctor, async () => {
        const ok = await doctor.c.post(`/api/followups/${S.fuid}/entered-in-error`, { reason: 'Audit error', rowVersion: 2 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['followup.error'];
      }],
      ['POST /api/patients/:id/administrations', nurse, async () => {
        const mo = await doctor.c.post(`/api/patients/${S.pid}/medication-orders`, { medication: 'MAR audit order', doseText: 'as typed', routeText: 'as typed', frequencyText: 'as typed' });
        assert.equal(mo.status, 201, JSON.stringify(mo.body));
        const body = { orderId: mo.body.order.id, outcome: 'given', administeredAt: new Date(Date.now() - 60e3).toISOString(), dose: 'Audit dose' };
        const r = await nurse.c.post(`/api/patients/${S.pid}/administrations`, { ...body, ...fake });
        assert.equal(r.status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/patients/${S.pid}/administrations`, body);
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.mrid = ok.body.administration.id; return ['administration.add'];
      }],
      ['POST /api/administrations/:id/entered-in-error', nurse, async () => {
        assert.equal((await nurse.c.post(`/api/administrations/${S.mrid}/entered-in-error`, { reason: 'Audit error', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await nurse.c.post(`/api/administrations/${S.mrid}/entered-in-error`, { reason: 'Audit error', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body)); return ['administration.error'];
      }],
      ['POST /api/import/bundles', doctor, async () => {
        const b = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'Patient', identifier: [{ value: 'AUDIT-ID-1' }], name: [{ family: 'Audit Name' }] } },
          { resource: { resourceType: 'Observation', status: 'final', code: { text: 'Audit sample' }, valueInteger: 7, effectiveDateTime: '2026-11-20T09:30:00Z' } }], ...fake };
        const ok = await doctor.c.post('/api/import/bundles', b);
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.ibid = ok.body.bundle.id; S.ipid = ok.body.bundle.proposals[0].id;
        assert.equal((await doctor.c.post('/api/import/bundles', { resourceType: 'Patient' })).status, 400); return ['import.stage', 'import.refused'];
      }],
      ['POST /api/import/proposals/:id/reject', doctor, async () => {
        assert.equal((await doctor.c.post(`/api/import/proposals/${S.ipid}/reject`, { reason: 'Audit reject', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/import/proposals/${S.ipid}/reject`, { reason: 'Audit reject', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await doctor.c.get('/api/import/bundles')).status, 200); assert.equal((await doctor.c.get('/api/import/bundles/' + S.ibid)).status, 200);   // the two reads are audited too
        return ['import.proposal_reject', 'import.bundles_view', 'import.bundle_view'];
      }],
      ['POST /api/import/packages', doctor, async () => {      // D6: package staging; the audit holds counts and a hash only
        const C = await import(require('node:url').pathToFileURL(require('node:path').join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href);
        const el = { manifest: { id: 'audit.pkg', name: 'Audit package', type: 'contextual-element', version: '0.1.0', status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } }, intent: { purpose: 'Audit.' },
          fields: [{ key: 'note', label: 'Note', type: 'string', cardinality: { min: 0, max: 1 } }] };
        const b = { format: 'ccis-package-bundle/1', artefacts: [{ checksum: C.checksumOf(C.canonicalize(el).text), document: el }], ...fake };
        const ok = await doctor.c.post('/api/import/packages', b);
        assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.pkid = ok.body.import.id; S.pkpid = ok.body.import.proposals[0].id;
        assert.equal((await doctor.c.post('/api/import/packages', { format: 'nope' })).status, 400); return ['import.package_stage', 'import.package_refused'];
      }],
      ['POST /api/import/package-proposals/:id/reject', doctor, async () => {
        assert.equal((await doctor.c.post(`/api/import/package-proposals/${S.pkpid}/reject`, { reason: 'Audit reject', rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/import/package-proposals/${S.pkpid}/reject`, { reason: 'Audit reject', rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await doctor.c.get('/api/import/packages')).status, 200); assert.equal((await doctor.c.get('/api/import/packages/' + S.pkid)).status, 200);   // the two reads are audited too
        return ['import.package_proposal_reject', 'import.packages_view', 'import.package_view'];
      }],
      ['POST /api/import/package-proposals/:id/accept', doctor, async () => {      // D7: a draft set is created through the set rules; creator = session user
        const C = await import(require('node:url').pathToFileURL(require('node:path').join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href);
        const el = { manifest: { id: 'audit.pkg2', name: 'Audit package two', type: 'contextual-element', version: '0.1.0', status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } }, intent: { purpose: 'Audit.' },
          fields: [{ key: 'note', label: 'Note', type: 'string', cardinality: { min: 0, max: 1 } }] };
        const st = await doctor.c.post('/api/import/packages', { format: 'ccis-package-bundle/1', artefacts: [{ checksum: C.checksumOf(C.canonicalize(el).text), document: el }] });
        assert.equal(st.status, 201, JSON.stringify(st.body)); const p = st.body.import.proposals[0];
        assert.equal((await doctor.c.post(`/api/import/package-proposals/${p.id}/accept`, { rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/import/package-proposals/${p.id}/accept`, { rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await doctor.c.post(`/api/import/package-proposals/${p.id}/accept`, { rowVersion: 2 })).status, 409);
        return ['import.package_accept'];
      }],
      ['POST /api/import/package-proposals/:id/accept-pathway', doctor, async () => {      // D8: a draft pathway over PUBLISHED sets; creator = session user
        const C = await import(require('node:url').pathToFileURL(require('node:path').join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href);
        const mk = (doc) => ({ checksum: C.checksumOf(C.canonicalize(doc).text), document: doc });
        const man = (id, type) => ({ id, name: 'Audit ' + id, type, version: '0.1.0', status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } });
        const el = { manifest: man('audit.pw.el', 'contextual-element'), intent: { purpose: 'Record information.' }, provenance: { origin: 'x', basis: 'Synthetic basis.' },
          fields: [{ key: 'note', label: 'Note', type: 'string', cardinality: { min: 0, max: 1 } }] };
        const pw = { manifest: man('audit.pw.path', 'pathway'), scope: 'Scope.', elements: [{ id: 'audit.pw.el', type: 'contextual-element', range: '0.1.0' }], stages: [],
          entryForm: { sections: [{ id: 'main', label: 'Main', items: [{ kind: 'element', element: 'audit.pw.el' }] }] }, contexts: [] };
        const st = await doctor.c.post('/api/import/packages', { format: 'ccis-package-bundle/1', artefacts: [mk(el), mk(pw)] });
        assert.equal(st.status, 201, JSON.stringify(st.body));
        const sp = st.body.import.proposals.find(x => x.kind === 'set'), pp = st.body.import.proposals.find(x => x.kind === 'pathway');
        const okSet = await doctor.c.post(`/api/import/package-proposals/${sp.id}/accept`, { rowVersion: 1 }); assert.equal(okSet.status, 200, JSON.stringify(okSet.body));
        assert.equal((await doctor.c.post(`/api/import/package-proposals/${pp.id}/accept-pathway`, { rowVersion: 1 })).status, 409, 'sets not published yet');
        assert.equal((await doctor.c.post(`/api/element-sets/${okSet.body.setId}/versions/1/submit`, {})).status, 200);
        const inf2 = client(aenv.base); assert.equal((await inf2.login('informatician2')).status, 200);
        for (const c of [reviewer.c, inf2]) { const a = await c.post(`/api/element-sets/${okSet.body.setId}/versions/1/approve`, { reason: 'Audit approval' }); if (a.body.status === 'reviewed') break; }
        assert.equal((await admin.c.post(`/api/element-sets/${okSet.body.setId}/versions/1/publish`, {})).status, 200);
        assert.equal((await doctor.c.post(`/api/import/package-proposals/${pp.id}/accept-pathway`, { rowVersion: 1, ...fake })).status, 400, 'a body that names a user is refused');
        const ok = await doctor.c.post(`/api/import/package-proposals/${pp.id}/accept-pathway`, { rowVersion: 1 });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await doctor.c.post(`/api/import/package-proposals/${pp.id}/accept-pathway`, { rowVersion: 2 })).status, 409);
        return ['import.package_accept_pathway'];
      }],
      ['PATCH /api/patients/:id/archive', doctor, async () => {
        assert.equal((await doctor.c.patch(`/api/patients/${S.pid}/archive`, { archived: true, ...fake })).status, 200);
        assert.equal((await doctor.c.patch(`/api/patients/${S.pid}/archive`, { archived: false, ...fake })).status, 200);
        return ['patient.archive', 'patient.restore'];
      }],
      ['PUT /api/ai/settings', admin, async () => {
        const r = await admin.c.raw('PUT', '/api/ai/settings', { enabled: true, model: 'test/m' });
        assert.equal(r.status, 200); return ['ai.settings'];
      }],
      ['POST /api/ai/preview', doctor, async () => {                  // success writes nothing by design; refusal is audited
        assert.equal((await admin.c.raw('PUT', '/api/ai/settings', { enabled: false })).status, 200);
        const off = await doctor.c.post('/api/ai/preview', { kind: 'gen', payload: { diagnosis: 'Sepsis', systems: ['snomed', 'loinc'] } });
        assert.equal(off.status, 409);
        assert.equal((await admin.c.raw('PUT', '/api/ai/settings', { enabled: true })).status, 200);
        const on = await doctor.c.post('/api/ai/preview', { kind: 'gen', payload: { diagnosis: 'Sepsis', systems: ['snomed', 'loinc'] } });
        assert.equal(on.status, 200); S.preview = on.body.previewId;
        return ['ai.refused'];
      }],
      ['POST /api/ai/run', doctor, async () => {
        const r = await doctor.c.post('/api/ai/run', { previewId: S.preview });
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['ai.request', 'ai.result'];
      }],
      ['POST /api/logout', nurse, async () => {
        assert.equal((await nurse.c.post('/api/logout', {})).status, 200); return ['logout'];
      }],
    ];

    assert.deepEqual(steps.map(s => s[0]).sort(), writeRoutes.sort(), 'every write route has an audit scenario (add one for the new route)');

    for (const [key, who_, run] of steps) {
      const before = (await rows()).length;
      const expect = await run();
      const added = (await rows()).slice(before);
      for (const action of expect) assert.ok(added.some(r => r.action === action), `${key}: expected audit action ${action}, got ${added.map(r => r.action).join(', ') || 'nothing'}`);
      if (who_) {
        for (const r of added.filter(x => expect.includes(x.action) && !['login.failed', 'login'].includes(x.action))) {
          assert.equal(r.username, who_.u, `${key}: audit actor must be the signed-in user (${r.action})`);
          assert.equal(r.role, who_.u.replace(/1$/, ''), `${key}: audit role must be the session role (${r.action})`);
          assert.ok(r.user_id, `${key}: audit row carries the user id`);
        }
      }
    }
    // nothing in any audit row was taken from the request bodies
    const all = await rows();
    assert.equal(all.filter(r => r.username === 'mallory').length, 0, 'a name sent in a body never becomes the actor');
    assert.equal((await aenv.pool.query(`SELECT created_by FROM patients WHERE id = $1`, [S.pid])).rows[0].created_by,
      (await aenv.pool.query(`SELECT id FROM users WHERE username = 'nurse1'`)).rows[0].id, 'createdBy comes from the session');
    // the AI key never lands in an audit row
    assert.ok(!JSON.stringify(all).includes('k-test'));
  } finally { await aenv.close(); await new Promise(r => prov.close(r)); }
});

// ---------- 7. no hard-delete route ----------
test('no route can hard-delete anything: no DELETE method, no delete-like path', () => {
  const dels = routes.filter(k => k.startsWith('DELETE '));
  assert.deepEqual(dels, [], 'DELETE routes are not allowed (archive/close/amend instead)');
  const wordy = routes.filter(k => /delete|remove|purge|destroy|erase|wipe|truncate/i.test(k.split(' ')[1]));
  assert.deepEqual(wordy, []);
});
