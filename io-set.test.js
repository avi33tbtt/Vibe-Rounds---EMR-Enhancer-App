'use strict';
// node --test io-set.test.js  (needs DATABASE_URL for the server part; creates and drops its own database)
// Chunk 37b: care.intake_output seed set, and the name of the person who entered a row (shown as initials in Flowsheets).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { validateView } = require('./views.js');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync('./element-sets.js', 'utf8'), sandbox);
const io = sandbox.window.SEED_SETS.find((s) => s.setId === 'care.intake_output');
const fields = () => io.sections.flatMap((s) => s.fields);

test('care.intake_output is a direct flowsheet set with the agreed fields', () => {
  assert.ok(io, 'set exists');
  assert.equal(io.kind, 'care'); assert.equal(io.direct, true);
  assert.equal(io.view.type, 'flowsheet'); assert.equal(io.view.timeField, 'io_time');
  assert.equal(fields().map((f) => f.id).join(','), 'io_time,io_type,io_volume,io_note');
  assert.ok(fields().every((f) => f.repeat === true && f.group === 'io'));
  assert.equal(fields().find((f) => f.id === 'io_type').options.join('|'), 'Intake oral|Intake IV|Urine|Drain|Stool|Other');
  assert.equal(fields().find((f) => f.id === 'io_volume').unit, 'mL');
});

test('care.intake_output has zero rules, thresholds, bands, targets, limits and defaults', () => {
  assert.ok(!io.rules || io.rules.length === 0);
  const keys = new Set(), numbers = [];
  (function walk(v, path) {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, path + '[' + i + ']'));
    if (v && typeof v === 'object') return Object.keys(v).forEach((k) => { keys.add(k); walk(v[k], path + '.' + k); });
    if (typeof v === 'number') numbers.push(path);
  })(io, 'io');
  for (const k of ['derived', 'flag', 'rules', 'protocol', 'bands', 'default', 'meta', 'thresholdField', 'min', 'max', 'low', 'high', 'target'])
    assert.ok(!keys.has(k), 'must not have a "' + k + '" key');
  assert.equal(numbers.join(','), 'io.quick.order,io.view.summary[0].windowsHours[0],io.view.summary[0].windowsHours[1],io.view.summary[0].windowsHours[2],io.version',
    'the only numbers in the set are its quick-bar position, the three display windows (hours) and its version');
  const ids = fields().map((f) => f.id).join(' ');
  assert.ok(!/thr|tgt|target|limit|goal/i.test(ids), 'no field id for a threshold, target or limit');
});

test('care.intake_output has a summary block (V4b), version 3, and its view validates', () => {
  assert.equal(io.version, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(io.view.summary)), [{ type: 'sumBy', timeField: 'io_time', keyField: 'io_type', valueField: 'io_volume', windowsHours: [8, 12, 24], label: 'sum of entered rows' }]);
  const r = validateView(io);
  assert.deepEqual(JSON.parse(JSON.stringify(r.errors)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(r.warnings)), []);
});

test('the quick-bar order is unique among the direct sets', () => {
  const orders = sandbox.window.SEED_SETS.filter((s) => s.direct).map((s) => s.quick.order);
  assert.equal(new Set(orders).size, orders.length);
});

test('initialsOf and enteredByCell (copied from enhancer.html, run in a vm)', () => {
  const html = fs.readFileSync('./enhancer.html', 'utf8');
  const grab = (n) => { const i = html.indexOf('function ' + n + '('); assert.ok(i > 0, n); let d = 0, j = html.indexOf('{', i); for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; if (html[k] === '}' && --d === 0) return html.slice(i, k + 1); } };
  let me = 'Asha Rai';
  const ctx = { Store: { who: () => me }, esc: (s) => String(s).replace(/[&<>"']/g, '') };
  vm.runInNewContext(grab('initialsOf') + grab('enteredByCell'), ctx);
  assert.equal(ctx.initialsOf('Asha Rai'), 'AR');
  assert.equal(ctx.initialsOf('  maria  del   carmen lopez '), 'ML');
  assert.equal(ctx.initialsOf('Plato'), 'PL');
  assert.equal(ctx.initialsOf(''), ''); assert.equal(ctx.initialsOf(null), '');
  assert.match(ctx.enteredByCell({ __by: 'u1', __byName: 'Dev Sharma' }), />DS</);
  assert.match(ctx.enteredByCell({ __by: 'u1' }), /—/, 'stamped by someone but name unknown: no guess');
  assert.match(ctx.enteredByCell({}), />AR</, 'unconfirmed row is the signed-in user\'s own');
  me = null;
  assert.equal(ctx.enteredByCell({}), '—', 'Demo mode: dash');
  assert.ok(!/<script/i.test(ctx.enteredByCell({ __by: 'u', __byName: '<script>x' })));
});

// ---- server: the name travels with the row ----
try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const dbName = 'emr_io_' + crypto.randomBytes(4).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
let db, app; const actors = {};
async function getActor(req) {
  const role = req.headers['x-test-role'] || 'admin';
  if (!actors[role]) {
    const r = await db.query(`INSERT INTO users (username,name,role) VALUES ($1,$2,$3) ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id`, ['test-' + role, 'Test ' + role, role]);
    actors[role] = { id: r.rows[0].id, role };
  }
  return actors[role];
}
test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  db = createDb(withDb(dbName)); await migrate(db, __dirname); app = createApp({ db, getActor });
  await db.query(`INSERT INTO element_sets (set_id,version,kind,body,source) VALUES ($1,1,'care',$2,'seed')`, [io.setId, JSON.stringify(io)]);
});
test.after(async () => {
  if (db) await db.close(); const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('GET case and /changes carry the name of whoever entered a row, not whoever last edited it', async () => {
  const c = (await request(app).post('/api/cases').send({})).body;
  const add = await request(app).post(`/api/cases/${c.id}/rows`).set('x-test-role', 'nurse')
    .send({ setId: 'care.intake_output', groupId: 'io', row: { io_type: 'Urine', io_volume: '200' } });
  assert.equal(add.status, 201);
  const got = (await request(app).get(`/api/cases/${c.id}`)).body;
  const row = got.values['care.intake_output/@io'][0];
  assert.equal(row.__byName, 'Test nurse');
  assert.equal(row.__by, actors.nurse.id);
  // a doctor amends it: the enterer stays the nurse
  const patch = await request(app).patch(`/api/cases/${c.id}/rows/${add.body.id}`).set('x-test-role', 'doctor')
    .send({ expectedVersion: add.body.version, row: { io_type: 'Urine', io_volume: '250' }, reason: 'typo' });
  assert.ok(patch.status < 300, JSON.stringify(patch.body));
  const got2 = (await request(app).get(`/api/cases/${c.id}`)).body;
  assert.equal(got2.values['care.intake_output/@io'][0].__byName, 'Test nurse');
  const ch = (await request(app).get(`/api/cases/${c.id}/changes`).query({ since: new Date(Date.now() - 60000).toISOString() })).body;
  const r = ch.rows.find((x) => x.id === add.body.id);
  assert.equal(r.enteredByName, 'Test nurse'); assert.equal(r.byName, 'Test doctor');
});
