'use strict';
// node --test llm.test.js  (needs DATABASE_URL; creates and drops its own database). Chunk 36a: AI proxy routes, admin switch, limits, audit. No network: a stand-in provider answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const L = require('./llm.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const name = 'emr_llm_' + crypto.randomBytes(4).toString('hex');
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
// the stand-in model: `reply` is set per test; every request it receives is kept in `calls`
let calls = [], reply = () => '{}';
const mock = { name: 'mock', model: 'mock-1', complete: async (a) => { calls.push(a); return reply(a); } };
const api = (a = app) => request(a);
const as = (role, a = app) => ({ post: (u, b) => api(a).post(u).set('x-test-role', role).send(b), get: (u) => api(a).get(u).set('x-test-role', role), put: (u, b) => api(a).put(u).set('x-test-role', role).send(b) });
const maxId = async () => Number((await db.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
const auditSince = async (id) => (await db.query('SELECT * FROM audit_log WHERE id > $1 ORDER BY id', [id])).rows;
const setAi = async (on) => { const r = await as('admin').put('/api/admin/ai', { enabled: on }); assert.equal(r.status, 200, JSON.stringify(r.body)); };

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
  db = createDb(withDb(name)); await migrate(db, __dirname);
  app = createApp({ db, getActor, llm: mock, aiLimiter: L.createLimiter({ perMinute: 1000, perHour: 1000 }) });
  await db.query(`INSERT INTO element_sets (set_id, kind, body) VALUES ('care.one','care','{"title":"One"}'), ('care.two','care','{"title":"Two"}'), ('disease.x','disease','{"title":"Disease X"}'), ('pathway.p','pathway','{"title":"Pathway P"}')`);
});
test.after(async () => {
  if (db) await db.close();
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
});
test.beforeEach(() => { calls = []; reply = () => '{}'; });

const RULE = { owner: 'care.one', text: 'Review potassium when above 5.5', fields: [{ ref: 'care.one/k', label: 'Potassium', unit: 'mmol/L', type: 'number' }, { ref: 'care.one/t', label: 'Last reading', unit: '', type: 'datetime' }] };
const goodRule = { fieldRef: 'care.one/k', op: '>', threshold: 5.5, indicator: 'warning', summary: 'Review potassium', detail: 'typed by the clinician' };

test('AI is OFF by default: every route answers 403 "AI disabled", nothing reaches the provider, no audit row', async () => {
  const before = await maxId();
  assert.deepEqual((await as('admin').get('/api/admin/ai')).body.enabled, false);
  for (const [u, b] of [['/api/llm/schema', { diagnosis: 'Asthma' }], ['/api/llm/suggest', { narrative: 'cough' }], ['/api/llm/rule-draft', RULE]]) {
    const r = await as('admin').post(u, b);
    assert.equal(r.status, 403, u); assert.equal(r.body.error.code, 'ai_disabled'); assert.equal(r.body.error.message, 'AI disabled');
  }
  assert.equal(calls.length, 0); assert.equal((await auditSince(before)).length, 0);
});

test('the switch: only an admin changes it, it is audited with before and after, and it takes effect on the very next call', async () => {
  assert.equal((await as('doctor').put('/api/admin/ai', { enabled: true })).status, 403);
  assert.equal((await as('doctor').get('/api/admin/ai')).status, 403);
  assert.equal((await as('admin').put('/api/admin/ai', { enabled: 'yes' })).status, 400);
  const m = await maxId(); await setAi(true);
  const rows = await auditSince(m); assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'ai.setting'); assert.deepEqual(rows[0].before, { enabled: false }); assert.deepEqual(rows[0].after, { enabled: true }); assert.equal(rows[0].user_id, actors.admin.id);
  const g = (await as('admin').get('/api/admin/ai')).body;
  assert.equal(g.enabled, true); assert.equal(g.configured, true); assert.equal(g.model, 'mock-1'); assert.equal(g.updatedBy, 'Test admin');
  assert.ok(!/key/i.test(JSON.stringify(Object.keys(g))), 'no key field');
  reply = () => JSON.stringify({ sections: [{ fields: [{ id: 'a_b', label: 'A', type: 'number' }] }] });
  assert.equal((await as('doctor').post('/api/llm/schema', { diagnosis: 'Asthma' })).status, 200);
  await setAi(false);
  assert.equal((await as('doctor').post('/api/llm/schema', { diagnosis: 'Asthma' })).status, 403);
  await setAi(true);
});

test('it cannot be switched on while no model is configured on the server', async () => {
  const bare = createApp({ db, getActor, llm: null });
  const r = await as('admin', bare).put('/api/admin/ai', { enabled: true });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'ai_not_configured');
  assert.equal((await as('admin', bare).get('/api/admin/ai')).body.configured, false);
  await db.query("INSERT INTO app_settings (key, value) VALUES ('ai', '{\"enabled\":true}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");   // forced on in the database, still no model
  const c = await as('doctor', bare).post('/api/llm/schema', { diagnosis: 'Asthma' });
  assert.equal(c.status, 503); assert.equal(c.body.error.code, 'ai_not_configured');
});

test('roles: nurse and viewer never; informatician only drafts sets; doctor and admin all three', async () => {
  reply = (a) => (a.system.startsWith('You are a clinical') ? JSON.stringify({ sections: [{ fields: [{ id: 'a_b', label: 'A', type: 'number' }] }] }) : a.system.startsWith('You help') ? '{"suggestions":[],"pathways":[]}' : JSON.stringify(goodRule));
  const bodies = { schema: { diagnosis: 'Asthma' }, suggest: { narrative: 'cough' }, 'rule-draft': RULE };
  const want = { admin: [200, 200, 200], doctor: [200, 200, 200], informatician: [200, 403, 403], nurse: [403, 403, 403], viewer: [403, 403, 403] };
  for (const [role, codes] of Object.entries(want)) {
    const got = []; for (const k of ['schema', 'suggest', 'rule-draft']) got.push((await as(role).post('/api/llm/' + k, bodies[k])).status);
    assert.deepEqual(got, codes, role);
  }
});

test('inputs are validated: unknown keys, missing text, and size caps are 400 before anything is sent', async () => {
  const bad = [['/api/llm/schema', {}], ['/api/llm/schema', { diagnosis: 'x'.repeat(201) }], ['/api/llm/schema', { diagnosis: 'Asthma', apiKey: 'k' }],
    ['/api/llm/suggest', { narrative: '' }], ['/api/llm/suggest', { narrative: 'x'.repeat(8001) }], ['/api/llm/suggest', { narrative: 'x', caseId: 'nope' }],
    ['/api/llm/rule-draft', { ...RULE, text: 'x'.repeat(301) }], ['/api/llm/rule-draft', { ...RULE, fields: [] }], ['/api/llm/rule-draft', { ...RULE, fields: [{ ...RULE.fields[0], value: 7.1 }] }]];
  for (const [u, b] of bad) assert.equal((await as('admin').post(u, b)).status, 400, u + ' ' + JSON.stringify(b).slice(0, 60));
  assert.equal(calls.length, 0);
});

test('per-user rate limit: the third call in a minute is 429 with Retry-After, another user is not affected, and the window moves on', async () => {
  let now = 1000000; const limiter = L.createLimiter({ perMinute: 2, perHour: 100, now: () => now });
  const a2 = createApp({ db, getActor, llm: mock, aiLimiter: limiter });
  reply = () => '{"suggestions":[],"pathways":[]}';
  const call = (role) => as(role, a2).post('/api/llm/suggest', { narrative: 'cough' });
  assert.equal((await call('doctor')).status, 200); assert.equal((await call('doctor')).status, 200);
  const r = await call('doctor'); assert.equal(r.status, 429); assert.equal(r.body.error.code, 'ai_rate_limited'); assert.ok(Number(r.headers['retry-after']) >= 1);
  assert.equal((await call('admin')).status, 200);
  now += 61000; assert.equal((await call('doctor')).status, 200);
  const hourly = L.createLimiter({ perMinute: 100, perHour: 3, now: () => now });
  for (let i = 0; i < 3; i++) assert.equal(hourly.take('u').ok, true);
  assert.equal(hourly.take('u').ok, false);
});

test('one audit row per call: purpose, outcome, byte counts, model, patient from the case; never the prompt or the answer', async () => {
  const c = (await as('admin').post('/api/cases', { narrative: 'x' })).body;
  const secret = 'ZEBRA-NARRATIVE-9137', answer = 'QUOKKA-REASON';
  reply = () => JSON.stringify({ suggestions: [{ setId: 'care.one', reason: answer }], pathways: [] });
  const m = await maxId();
  const r = await as('doctor').post('/api/llm/suggest', { narrative: 'Fever and ' + secret, caseId: c.id });
  assert.equal(r.status, 200); assert.equal(r.body.suggestions[0].reason, answer);
  const rows = await auditSince(m); assert.equal(rows.length, 1);
  const row = rows[0]; assert.equal(row.action, 'ai.call'); assert.equal(row.entity_id, 'suggest'); assert.equal(row.user_id, actors.doctor.id); assert.equal(row.role, 'doctor');
  assert.equal(row.after.outcome, 'ok'); assert.equal(row.after.purpose, 'suggest'); assert.equal(row.after.model, 'mock-1'); assert.equal(row.after.providerCalls, 1);
  assert.ok(row.after.bytesIn > 100 && row.after.bytesOut > 10);
  const dump = JSON.stringify(row); assert.ok(!dump.includes(secret) && !dump.includes(answer), 'no content in the audit row');
  const p = (await db.query('SELECT patient_id FROM cases WHERE id=$1', [c.id])).rows[0].patient_id; assert.equal(row.patient_id, p);
});

test('suggest: only registry ids survive, duplicates and extras are cut, dose-like reasons are blanked, sets already on the case are not offered', async () => {
  const c = (await as('admin').post('/api/cases', { narrative: 'x' })).body;
  assert.equal((await api().patch('/api/cases/' + c.id).send({ expectedVersion: 1, applied: [{ setId: 'care.one', addedAt: new Date().toISOString() }] })).status, 200);
  reply = () => JSON.stringify({ suggestions: [{ setId: 'care.one', reason: 'already applied' }, { setId: 'care.two', reason: 'Give 10 units now' }, { setId: 'care.two', reason: 'dup' }, { setId: 'made.up', reason: 'x' }, { setId: 'pathway.p', reason: 'wrong list' }, { setId: 'disease.x', reason: 'fits the history' }],
    pathways: [{ pathwayId: 'pathway.p', reason: 'bundle' }, { pathwayId: 'care.two', reason: 'not a pathway' }] });
  const r = await as('doctor').post('/api/llm/suggest', { narrative: 'cough', caseId: c.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.suggestions, [{ setId: 'care.two', reason: '' }, { setId: 'disease.x', reason: 'fits the history' }]);
  assert.deepEqual(r.body.pathways, [{ pathwayId: 'pathway.p', reason: 'bundle' }]);
  const user = calls[calls.length - 1].user; assert.ok(!user.includes('care.one |') && user.includes('care.two | Two') && user.includes('pathway.p | Pathway P'));
  assert.equal((await as('doctor').post('/api/llm/suggest', { narrative: 'cough', caseId: crypto.randomUUID() })).status, 404);
});

test('rule draft: a threshold the clinician did not type, a bad operator, a field not in the list or an order-like summary never pass; the model sees fields and the sentence only', async () => {
  const run = async (j) => { reply = () => JSON.stringify(j); return as('doctor').post('/api/llm/rule-draft', RULE); };
  let r = await run(goodRule); assert.equal(r.status, 200);
  assert.deepEqual(r.body.draft, { fieldRef: 'care.one/k', op: '>', threshold: 5.5, unit: 'mmol/L', indicator: 'warning', summary: 'Review potassium', detail: 'typed by the clinician' });
  assert.ok(!('enabled' in r.body.draft) && !('provenance' in r.body.draft), 'a draft carries no approval of any kind');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['system', 'user']);
  assert.equal(calls[0].user, 'Fields (ref | label | unit | type):\ncare.one/k | Potassium | mmol/L | number\ncare.one/t | Last reading |  | datetime\n\nSentence:\nReview potassium when above 5.5');
  for (const [why, j] of [['threshold not typed', { ...goodRule, threshold: 6 }], ['operator', { ...goodRule, op: 'DROP' }], ['field', { ...goodRule, fieldRef: 'care.one/zzz' }], ['indicator', { ...goodRule, indicator: 'fatal' }],
    ['date field with >', { ...goodRule, fieldRef: 'care.one/t', op: '>' }], ['model error', { error: 'no number' }], ['not an object', [1]], ['threshold text', { ...goodRule, threshold: 'high' }]]) {
    r = await run(j); assert.equal(r.status, 422, why); assert.equal(r.body.error.code, 'ai_invalid_output', why);
  }
  r = await run({ ...goodRule, summary: 'Give 40 mg of something' }); assert.equal(r.status, 200); assert.match(r.body.draft.summary, /^Review potassium \(draft wording/);
  r = await run({ ...goodRule, summary: 'Hold insulin' }); assert.match(r.body.draft.summary, /^Review potassium \(draft wording/);
  r = await run({ ...goodRule, detail: 'Use 5 mg' }); assert.equal(r.body.draft.detail, '');
  r = await run({ ...goodRule, fieldRef: 'care.one/t', op: 'minutes_since_gt', threshold: 5.5 }); assert.equal(r.status, 200); assert.equal(r.body.draft.unit, '');
  assert.equal((await as('doctor').post('/api/llm/rule-draft', { ...RULE, owner: 'no.such.set' })).status, 404);
});

test('schema: the diagnosis stays as typed, model flag thresholds are removed, unsafe or unusable fields are dropped, codes are format-checked', async () => {
  reply = () => JSON.stringify({ diagnosis: { text: 'SOMETHING ELSE', snomed: { code: 'abc', display: 'x' } }, sections: [
    { title: 'Core', fields: [
      { id: 'Onset Time', label: 'Onset time', type: 'datetime', coding: { system: 'snomed', code: '123456', display: 'Onset' }, fhir: { resource: 'Observation', valueType: 'dateTime' } },
      { id: 'arrival_time', label: 'Arrival', type: 'datetime' },
      { id: 'door_to_x', label: 'Interval', type: 'duration_min', derived: { from: ['onset_time', 'arrival_time'], op: 'minutes_between', flag: [60, 240] } },
      { id: 'bad_derived', label: 'Bad', type: 'duration_min', derived: { from: ['onset_time', 'nope'], op: 'minutes_between' } },
      { id: 'dose', label: 'Insulin 10 units', type: 'text' },
      { id: 'sev', label: 'Severity', type: 'select', options: ['Mild'] },
      { id: 'onset_time', label: 'Duplicate', type: 'text' },
      { id: 'weird', label: 'Weird', type: 'image' },
      { id: 'code_bad', label: 'Bad code', type: 'text', coding: { system: 'loinc', code: 'zz', display: 'x' }, rationale: 'Give 5 mg' }] }] });
  const r = await as('doctor').post('/api/llm/schema', { diagnosis: 'My Own Diagnosis' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.schema; assert.equal(s.diagnosis.text, 'My Own Diagnosis'); assert.deepEqual(s.diagnosis.snomed, { code: '', display: '' });
  const f = Object.fromEntries(s.sections.flatMap((x) => x.fields).map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(f), ['onset_time', 'arrival_time', 'door_to_x', 'bad_derived', 'code_bad']);
  assert.deepEqual(f.onset_time.coding, { system: 'snomed', code: '123456', display: 'Onset' });
  assert.deepEqual(f.door_to_x.derived, { from: ['onset_time', 'arrival_time'], op: 'minutes_between' }); assert.ok(!JSON.stringify(s).includes('flag'));
  assert.equal(f.bad_derived.derived, undefined); assert.equal(f.code_bad.coding, undefined); assert.equal(f.code_bad.rationale, '');
  assert.ok(r.body.warnings.some((w) => /Flag thresholds/.test(w)) && r.body.warnings.some((w) => /left out/.test(w)) && r.body.warnings.some((w) => /Verify every/.test(w)));
  assert.ok(!/flag/i.test(calls[0].system.replace(/flag values/, '')), 'the prompt no longer asks the model for flag thresholds');
  reply = () => JSON.stringify({ sections: [{ fields: [{ id: 'x', label: 'Insulin 5 units', type: 'text' }] }] });
  assert.equal((await as('doctor').post('/api/llm/schema', { diagnosis: 'Asthma' })).status, 422);
});

test('JSON handling: one retry when the first answer is not JSON; a second failure is 422; a provider failure is a generic 502; each is audited once', async () => {
  const answers = ['not json at all', JSON.stringify({ suggestions: [], pathways: [] })];
  reply = () => answers.shift();
  let m = await maxId(); let r = await as('doctor').post('/api/llm/suggest', { narrative: 'cough' });
  assert.equal(r.status, 200); assert.equal(calls.length, 2); assert.ok(calls[1].user.endsWith('Return ONLY JSON.'));
  let rows = await auditSince(m); assert.equal(rows.length, 1); assert.equal(rows[0].after.providerCalls, 2);
  reply = () => '```json\n{"suggestions":[],"pathways":[]}\n```'; assert.equal((await as('doctor').post('/api/llm/suggest', { narrative: 'cough' })).status, 200, 'fenced JSON is accepted');
  reply = () => 'still not json'; m = await maxId();
  r = await as('doctor').post('/api/llm/suggest', { narrative: 'cough' }); assert.equal(r.status, 422); assert.equal(r.body.error.code, 'ai_invalid_output');
  rows = await auditSince(m); assert.equal(rows.length, 1); assert.equal(rows[0].after.outcome, 'invalid_output');
  reply = () => { throw new L.ProviderError('provider status 401 secret-detail'); }; m = await maxId();
  r = await as('doctor').post('/api/llm/suggest', { narrative: 'cough' }); assert.equal(r.status, 502); assert.equal(r.body.error.code, 'ai_provider_error'); assert.ok(!JSON.stringify(r.body).includes('secret-detail'));
  rows = await auditSince(m); assert.equal(rows.length, 1); assert.equal(rows[0].after.outcome, 'provider_error');
});

test('createProvider: no key means no provider; the key goes in a header only; no browser-access header; a failure never shows the key', async () => {
  assert.equal(L.createProvider({}), null); assert.equal(L.createProvider({ LLM_API_KEY: 'k' }), null);
  assert.throws(() => L.createProvider({ LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_PROVIDER: 'nope' }), /anthropic or openrouter/);
  const seen = []; const f = (ok, body) => async (url, o) => { seen.push({ url, o }); return { ok, status: ok ? 200 : 401, json: async () => body }; };
  const an = L.createProvider({ LLM_API_KEY: 'sk-test-KEY', LLM_MODEL: 'm1' }, f(true, { content: [{ type: 'text', text: 'hi' }] }));
  assert.equal(await an.complete({ system: 's', user: 'u' }), 'hi');
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages'); assert.equal(seen[0].o.headers['x-api-key'], 'sk-test-KEY'); assert.ok(!('anthropic-dangerous-direct-browser-access' in seen[0].o.headers));
  assert.ok(!seen[0].o.body.includes('sk-test-KEY'), 'the key is never in the body');
  const orp = L.createProvider({ LLM_API_KEY: 'sk-test-KEY', LLM_MODEL: 'm2', LLM_PROVIDER: 'OpenRouter' }, f(true, { choices: [{ message: { content: 'yo' } }] }));
  assert.equal(await orp.complete({ system: 's', user: 'u' }), 'yo'); assert.equal(seen[1].o.headers.Authorization, 'Bearer sk-test-KEY');
  const bad = L.createProvider({ LLM_API_KEY: 'sk-test-KEY', LLM_MODEL: 'm1' }, f(false, {}));
  await assert.rejects(bad.complete({ system: 's', user: 'u' }), (e) => e instanceof L.ProviderError && !e.message.includes('sk-test-KEY'));
});

test('the operator, indicator and field-type lists and the order-word test match the browser rule code in cds-rules.js', () => {
  const src = fs.readFileSync(__dirname + '/cds-rules.js', 'utf8');
  const arr = (n) => JSON.parse(src.match(new RegExp(n + "=(\\[[^\\]]*\\])"))[1].replace(/'/g, '"'));
  assert.deepEqual(arr('OPS'), L.OPS); assert.deepEqual(arr('IND'), L.IND); assert.deepEqual(arr('NUMT'), L.NUMT); assert.deepEqual(arr('TIMT'), L.TIMT);
  assert.equal(src.match(/const ORDERY=(\/.*\/i);/)[1], String(L.ORDERY));
});
