'use strict';
// node --test rules-inforce.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 35c. Rules in force: GET /api/rules-in-force and its audited, formula-safe CSV. Runs as the restricted emr_app role.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { ROUTE_ACTIONS, ACTIONS } = require('./permissions.js');


try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_rif_' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let owner, appDb, app;
const actors = {};
async function getActor(req) {                       // TEST-ONLY actor, as in audit.test.js
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await owner.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['adm-' + role, 'Admin test ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
const api = () => request(app);
const as = (role) => (role === 'admin' ? {} : { 'x-test-role': role });
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
const since = async (id) => (await owner.query('SELECT * FROM audit_log WHERE id > $1 ORDER BY id', [id])).rows;
/** Minimal RFC 4180 reader for the tests (quoted cells, doubled quotes, CRLF). */
function parseCsv(t) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csvText = (r) => r.text || (Buffer.isBuffer(r.body) ? r.body.toString('utf8') : '');

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  owner = createDb(withDb(name)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${pw}'`);
  const u = new URL(withDb(name)); u.username = 'emr_app'; u.password = pw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb, getActor });
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});

const RULE = (over) => ({ body: { ruleId: 'r1', fieldRef: 'care.vitals/temp', op: '>=', threshold: 38, unit: 'C', indicator: 'warning', summary: 'Review temperature', ...over }, expectedVersion: 0 });
const put = (role, owner_, id, b) => api().put(`/api/rules/${owner_}/${id}`).set(as(role)).send(b);
const approve = (role, owner_, id, v) => api().post(`/api/rules/${owner_}/${id}/approve`).set(as(role)).send({ expectedVersion: v });
const list = (role, q = '') => api().get('/api/rules-in-force' + q).set(as(role));
const ids = (r) => r.body.items.map((i) => i.kind + ':' + i.setId + '/' + i.ruleId);

test('access: admin and doctor only, for the list and the CSV; both routes are mapped to one action', async () => {
  assert.deepEqual([...ACTIONS['rules.inforce']].sort(), ['admin', 'doctor']);
  assert.equal(ROUTE_ACTIONS['GET /rules-in-force'], 'rules.inforce'); assert.equal(ROUTE_ACTIONS['GET /rules-in-force.csv'], 'rules.inforce');
  const m = await maxId();
  for (const role of ['admin', 'doctor']) { assert.equal((await list(role)).status, 200, role); assert.equal((await api().get('/api/rules-in-force.csv').set(as(role))).status, 200, role + ' csv'); }
  for (const role of ['nurse', 'informatician', 'viewer']) {
    const a = await list(role), b = await api().get('/api/rules-in-force.csv').set(as(role));
    assert.equal(a.status, 403, role); assert.equal(a.body.error.code, 'forbidden'); assert.equal(b.status, 403, role + ' csv');
  }
  assert.equal((await since(m)).filter((x) => x.action === 'rules_inforce_export').length, 2, 'only the two allowed exports were recorded');
});

test('only approved rules and verified protocols are listed; approver and time are the session user; any edit takes a rule out again', async () => {
  const p = await put('doctor', 'care.vitals', 'r1', RULE());
  assert.equal(p.status, 200);
  assert.deepEqual(ids(await list('admin', '?set=care.vitals')), [], 'saved but unapproved: not in force');
  const ap = await approve('doctor', 'care.vitals', 'r1', 1);
  assert.equal(ap.status, 200);
  const l = await list('admin', '?set=care.vitals'), it = l.body.items[0];
  assert.deepEqual(ids(l), ['rule:care.vitals/r1']);
  assert.equal(it.approvedBy, 'Admin test doctor'); assert.ok(it.approvedAt); assert.equal(it.source, 'manual'); assert.equal(it.indicator, 'warning');
  assert.equal(it.sentence, 'If latest care.vitals/temp >= 38 C, show warning: Review temperature', 'wording comes from the typed rule; unknown field falls back to its reference');
  assert.equal((await put('doctor', 'care.vitals', 'r1', { ...RULE({ threshold: 39 }), expectedVersion: 2 })).status, 200);
  assert.deepEqual(ids(await list('admin', '?set=care.vitals')), [], 'an edit resets approval, so it leaves the list');
  const ap2 = await approve('admin', 'care.vitals', 'r1', 3);
  assert.equal(ap2.status, 200); assert.equal((await list('doctor', '?set=care.vitals')).body.items[0].approvedBy, 'Admin test admin');
  assert.equal((await api().post('/api/rules/care.vitals/r1/disable').set(as('doctor')).send({ expectedVersion: 4 })).status, 200);
  assert.deepEqual(ids(await list('admin', '?set=care.vitals')), [], 'a disabled rule is not in force');
});

test('a minutes_since_gt rule reads in plain words; protocols list their bands exactly as typed and only once verified', async () => {
  await put('doctor', 'care.io', 'late', RULE({ ruleId: 'late', fieldRef: 'care.io/io_time', op: 'minutes_since_gt', threshold: 60, unit: '' }));
  await approve('doctor', 'care.io', 'late', 1);
  const l = await list('doctor', '?set=care.io');
  assert.equal(l.body.items[0].sentence, 'If the latest care.io/io_time reading is more than 60 min old, show warning: Review temperature');
  const bands = [{ min: '', max: '', instruction: 'typed text' }];
  await api().put('/api/protocols/care.scale').set(as('doctor')).send({ body: { bands }, expectedVersion: 0 });
  assert.deepEqual(ids(await list('admin', '?set=care.scale')), [], 'unverified protocol is not listed');
  assert.equal((await api().post('/api/protocols/care.scale/approve').set(as('doctor')).send({ expectedVersion: 1 })).status, 200);
  const pr = (await list('admin', '?set=care.scale')).body.items;
  assert.equal(pr.length, 1); assert.equal(pr[0].kind, 'protocol'); assert.equal(pr[0].source, 'protocol'); assert.equal(pr[0].approvedBy, 'Admin test doctor');
  assert.match(pr[0].sentence, /1 band as typed: -: typed text$/);
  assert.equal((await api().put('/api/protocols/care.scale').set(as('doctor')).send({ body: { bands }, expectedVersion: 2 })).status, 200);
  assert.deepEqual(ids(await list('admin', '?set=care.scale')), [], 'editing a protocol resets verification');
});

test('filters: by set and by source; unknown or bad filters are 400', async () => {
  await put('doctor', 'care.ai', 'a1', RULE({ ruleId: 'a1', provenance: { source: 'ai-drafted' } }));
  await approve('doctor', 'care.ai', 'a1', 1);
  assert.deepEqual(ids(await list('admin', '?source=ai-drafted')), ['rule:care.ai/a1']);
  assert.ok(!ids(await list('admin', '?source=manual')).includes('rule:care.ai/a1'));
  assert.deepEqual(ids(await list('admin', '?source=protocol&set=care.scale')), [], 'protocol filter never returns rules');
  assert.deepEqual(ids(await list('admin', '?set=care.ai&source=ai-drafted')), ['rule:care.ai/a1']);
  assert.equal((await list('admin', '?source=other')).status, 400);
  assert.equal((await list('admin', '?set=' + encodeURIComponent('a b;'))).status, 400);
  assert.equal((await list('admin', '?x=1')).status, 400);
});

test('viewing is read-only and writes no audit row; the screen never changes a rule', async () => {
  const snap = async () => JSON.stringify((await owner.query('SELECT owner_set_id,rule_id,version,enabled,verified_by_user FROM cds_rules ORDER BY 1,2')).rows);
  const before = await snap(), m = await maxId();
  await list('admin'); await list('doctor', '?source=manual');
  assert.equal(await snap(), before); assert.equal((await since(m)).length, 0);
});

test('CSV: header, audited once with the filter, formula-safe, same rows as the list', async () => {
  await owner.query(`INSERT INTO element_sets (set_id, version, kind, body) VALUES ('care.csv', 1, 'care', $1)`,
    [JSON.stringify({ title: '=SUM(1)', sections: [{ fields: [{ id: 'temp', label: 'Temperature' }] }] })]);
  await put('doctor', 'care.csv', 'f1', RULE({ ruleId: 'f1', fieldRef: 'care.csv/temp', summary: 'say "hi", ok' }));
  await approve('doctor', 'care.csv', 'f1', 1);
  const m = await maxId(), res = await api().get('/api/rules-in-force.csv?set=care.csv').set(as('admin'));
  assert.equal(res.status, 200); assert.match(res.headers['content-type'], /text\/csv/); assert.match(res.headers['content-disposition'], /rules-in-force\.csv/);
  const rows = parseCsv(csvText(res));
  assert.deepEqual(rows[0], ['kind', 'set_id', 'set_title', 'rule_id', 'sentence', 'indicator', 'approved_by', 'approved_at', 'source']);
  assert.equal(rows.length, 2); assert.equal(res.headers['x-rows'], '1');
  assert.equal(rows[1][3], 'f1'); assert.equal(rows[1][6], 'Admin test doctor');
  assert.equal(rows[1][2], "'=SUM(1)", 'a title that looks like a formula is shown as text');
  assert.equal(rows[1][4], 'If latest Temperature >= 38 C, show warning: say "hi", ok', 'field label comes from the set; commas and quotes survive CSV quoting');
  const s = await since(m), ex = s.filter((x) => x.action === 'rules_inforce_export');
  assert.equal(ex.length, 1); assert.equal(s.length, 1);
  assert.equal(ex[0].entity, 'rules_in_force'); assert.deepEqual(ex[0].after, { filter: { set: 'care.csv' }, rows: 1 });
  assert.equal(ex[0].user_id, actors.admin.id);
  const it = (await list('admin', '?set=care.csv')).body.items[0];
  assert.equal(it.setTitle, '=SUM(1)'); assert.equal(it.sentence, rows[1][4]);
  assert.equal((await api().get('/api/rules-in-force.csv?bad=1').set(as('admin'))).status, 400);
});
