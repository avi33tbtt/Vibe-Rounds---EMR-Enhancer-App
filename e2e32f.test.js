'use strict';
// node --test e2e32f.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 32f: two-user check (doctor + nurse, plus admin) with REAL login sessions, CSRF and the restricted emr_app role.
// Honest scope: this drives the server over HTTP exactly as two browsers would. It does NOT click through enhancer.html
// (no browser is available in the build sandbox); the on-screen parts are listed in the plan as "still to do by hand".
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const { readSeedSets, seedSets } = require('./seed.js');

try { require('node:fs').existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_e2e_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, hash, doctor, nurse, admin;

async function mk(username, role) {
  await owner.query('INSERT INTO users (username,name,role,password_hash,must_change_password) VALUES ($1,$2,$3,$4,false)', [username, 'Name ' + username, role, hash]);
  return signIn(username);
}
async function signIn(username, pw = PW) {
  const agent = request.agent(app);
  const r = await agent.post('/api/login').send({ username, password: pw });
  agent.loginStatus = r.status; agent.loginBody = r.body;
  if (r.status === 200) agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
  return agent;
}

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = appPw;
  await seedSets(owner, readSeedSets());              // the same one-time seed a real install runs (npm run seed)
  appDb = createDb(u.toString());
  app = createApp({ db: appDb });                      // real sessions, no dev user
  hash = await hashPassword(PW);
  doctor = await mk('dr_e2e', 'doctor'); nurse = await mk('rn_e2e', 'nurse'); admin = await mk('ad_e2e', 'admin');
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

let caseId, rowD, rowN;
test('step 1: sign in, doctor creates a case, each user adds a reading at the same moment, nothing is overwritten', async () => {
  assert.equal(doctor.loginStatus, 200); assert.equal(nurse.loginStatus, 200);
  const c = await doctor.post('/api/cases').send({ patient: { name: 'Synthetic One', mrn: 'DEMO-1', ageSex: '40 M', bed: 'W1-1' }, narrative: 'synthetic' });
  assert.equal(c.status, 201, JSON.stringify(c.body)); caseId = c.body.id;
  const body = (v) => ({ setId: 'care.vitals', groupId: 'vit', row: { vit_time: new Date().toISOString(), hr: v } });
  const [a, b] = await Promise.all([doctor.post(`/api/cases/${caseId}/rows`).send(body(80)), nurse.post(`/api/cases/${caseId}/rows`).send(body(90))]);
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(b.status, 201, JSON.stringify(b.body));
  rowD = a.body; rowN = b.body;
  for (const who of [doctor, nurse]) {                    // both browsers see both rows
    const g = (await who.get(`/api/cases/${caseId}`)).body;
    const rows = g.values['care.vitals/@vit'];
    assert.equal(rows.length, 2); assert.deepEqual(rows.map((r) => r.hr).sort(), [80, 90]);
    assert.equal(new Set(rows.map((r) => r.__by)).size, 2, 'each row carries its own author');
  }
});

test('step 2: a real conflict gives exactly one 409 with the current copy; the loser is not applied', async () => {
  const id = rowD.id || rowD.__id, v = rowD.version ?? rowD.__v ?? 1;
  const [a, b] = await Promise.all([
    doctor.patch(`/api/cases/${caseId}/rows/${id}`).send({ expectedVersion: v, row: { hr: 81 } }),
    admin.patch(`/api/cases/${caseId}/rows/${id}`).send({ expectedVersion: v, row: { hr: 82 } })]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409], JSON.stringify([a.body, b.body]));
  const loser = a.status === 409 ? a : b; assert.ok(loser.body.current, '409 carries current so the screen can show theirs vs mine');
  const final = (await doctor.get(`/api/cases/${caseId}`)).body.values['care.vitals/@vit'].find((r) => r.__id === id);
  assert.ok([81, 82].includes(final.hr));
  // narrative (case-level) conflict as well
  const cur = (await doctor.get(`/api/cases/${caseId}`)).body;
  const [x, y] = await Promise.all([doctor.patch(`/api/cases/${caseId}`).send({ expectedVersion: cur.version, narrative: 'A' }),
    admin.patch(`/api/cases/${caseId}`).send({ expectedVersion: cur.version, narrative: 'B' })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
});

test('step 3: one-time import - doctor refused, admin allowed (dry-run and real), second run inserts nothing', async () => {
  const body = { cases: [{ id: 'legacy-1', narrative: 'old browser case', applied: [], pathways: [], values: {} }], sets: [], setUsage: {}, pinned: [], codes: {}, rules: {}, protocols: {} };
  for (const p of ['/api/import/dry-run', '/api/import']) assert.equal((await doctor.post(p).send(body)).status, 403, 'doctor ' + p);
  assert.equal((await nurse.post('/api/import').send(body)).status, 403);
  const dry = await admin.post('/api/import/dry-run').send(body); assert.equal(dry.status, 200, JSON.stringify(dry.body));
  const n0 = (await owner.query('SELECT count(*)::int n FROM cases')).rows[0].n;
  const r1 = await admin.post('/api/import').send(body); assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const n1 = (await owner.query('SELECT count(*)::int n FROM cases')).rows[0].n; assert.equal(n1, n0 + 1);
  const r2 = await admin.post('/api/import').send(body); assert.ok([200, 201].includes(r2.status), JSON.stringify(r2.body));
  assert.equal((await owner.query('SELECT count(*)::int n FROM cases')).rows[0].n, n1, 'second run inserts nothing');
});

test('step 4: five wrong passwords lock the account; the right password is then refused until the lock ends', async () => {
  await mk('lock_e2e', 'nurse');
  let last;
  for (let i = 0; i < 5; i++) last = await signIn('lock_e2e', 'wrong password ' + i);
  assert.equal(last.loginStatus, 401);
  const locked = await signIn('lock_e2e', PW);
  assert.equal(locked.loginStatus, 429); assert.equal(locked.loginBody.error.code, 'account_locked');
  await owner.query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE username='lock_e2e'`);   // the lock ending (what an admin reactivate or the clock does)
  assert.equal((await signIn('lock_e2e', PW)).loginStatus, 200);
});

test('step 5: a session that idles out during unsent edits: write refused with 401, nothing stored; after sign-in the same data is accepted', async () => {
  const u = await mk('idle_e2e', 'nurse');
  const body = { setId: 'care.vitals', groupId: 'vit', row: { vit_time: new Date().toISOString(), hr: 77 } };
  const before = (await owner.query('SELECT count(*)::int n FROM case_rows WHERE case_id=$1', [caseId])).rows[0].n;
  await owner.query(`UPDATE sessions SET last_seen = now() - interval '45 minutes' WHERE user_id=(SELECT id FROM users WHERE username='idle_e2e')`);
  const r = await u.post(`/api/cases/${caseId}/rows`).send(body);
  assert.equal(r.status, 401);
  assert.equal((await owner.query('SELECT count(*)::int n FROM case_rows WHERE case_id=$1', [caseId])).rows[0].n, before, 'refused write stored nothing');
  const again = await signIn('idle_e2e');                  // same user signs in again; the browser queue (store.test.js, 32d1) resends the same body
  const r2 = await again.post(`/api/cases/${caseId}/rows`).send(body);
  assert.equal(r2.status, 201);
  assert.equal((await owner.query('SELECT count(*)::int n FROM case_rows WHERE case_id=$1', [caseId])).rows[0].n, before + 1);
});
