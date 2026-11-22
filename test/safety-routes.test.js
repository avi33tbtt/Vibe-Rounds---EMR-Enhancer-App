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

// ---------- the matrix (written by hand on purpose: it is the spec, permissions.js is the implementation) ----------
// guard: 'public' (no sign-in), 'login' (any signed-in user) or a permission name.
const MATRIX = {
  'GET /':                          { guard: 'public' },
  'GET /emr-enhancer.html':         { guard: 'public' },
  'GET /sdc.js':                    { guard: 'public' },
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
  'GET /api/element-sets':          { guard: 'sets:read' },
  'POST /api/element-sets':         { guard: 'sets:write' },
  'GET /api/element-sets/:id':      { guard: 'sets:read' },
  'GET /api/element-sets/:id/versions/:version': { guard: 'sets:read' },
  'POST /api/element-sets/:id/versions': { guard: 'sets:write' },
  'POST /api/element-sets/:id/versions/:version/submit': { guard: 'sets:submit' },
  'GET /api/element-sets/:id/versions/:version/review': { guard: 'sets:read' },
  'GET /api/review-queue':          { guard: 'sets:read' },
  'POST /api/element-sets/:id/versions/:version/publish': { guard: 'sets:publish' },
  'POST /api/element-sets/:id/versions/:version/retire': { guard: 'sets:publish' },
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
  'sets:read':         ['admin', 'doctor', 'nurse', 'viewer'],
  'sets:write':        ['admin', 'doctor'],
  'sets:submit':       ['admin', 'doctor'],
  'sets:publish':      ['admin'],
  'audit:read':        ['admin'],
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
  const aenv = await setup({ ai: { provider: 'openrouter', key: 'k-test', model: 'test/m', baseUrl: provUrl, timeoutMs: 5000 } });
  try {
    const aroutes = listRoutes(aenv.pool);
    const writeRoutes = aroutes.filter(isWrite);
    const fake = { username: 'mallory', role: 'admin', user: 'mallory', userId: 1, actor: 'mallory', createdBy: 1, signedBy: 'mallory' };
    const S = {};   // shared state between steps
    const who = (u, c) => ({ u, c });
    const nurse = who('nurse1', client(aenv.base)), doctor = who('doctor1', client(aenv.base)), admin = who('admin1', client(aenv.base));
    const rows = async () => (await aenv.pool.query('SELECT * FROM audit_log ORDER BY id')).rows;

    const steps = [
      ['POST /api/login', null, async () => {                        // login is public: success and failure are both audited
        assert.equal((await nurse.c.login('nurse1', 'wrong-password')).status, 401);
        for (const w of [nurse, doctor, admin]) assert.equal((await w.c.login(w.u)).status, 200);
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
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['set.submit'];
      }],
      ['POST /api/element-sets/:id/versions/:version/publish', admin, async () => {
        const r = await admin.c.post(`/api/element-sets/${S.setId}/versions/${S.setV}/publish`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['set.publish'];
      }],
      ['POST /api/element-sets/:id/versions/:version/retire', admin, async () => {
        const r = await admin.c.post(`/api/element-sets/${S.setId}/versions/${S.setV}/retire`, {});
        assert.equal(r.status, 200, JSON.stringify(r.body)); return ['set.retire'];
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
