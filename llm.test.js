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

// ---------------------------------------------------------------- chunk 36b: de-identification, preview, /me flag
const IDENT = { name: 'Asha Kumari Rai', mrn: '1000017', national_id: '123-45-6789', phone: '+977 9812345678', date_of_birth: '1980-03-12' };
const mkPatient = async (p = IDENT, extra = {}) => (await db.query(`INSERT INTO patients (mrn,name,national_id,phone,date_of_birth) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [p.mrn, p.name, p.national_id, p.phone, p.date_of_birth])).rows[0].id;

test('deidentify: names, MRN, national id, phone, e-mail, birth date, address and titled names go; readings and thresholds stay', () => {
  const known = L.knownIdentifiers(IDENT);
  const t = 'Asha Rai, 45-year-old, MRN 1000017, DOB 12/03/1980 (born 12 March 1980), national id 123-45-6789, phone 9812345678, a@b.com, lives at 12 Mahendra Marg. Temp 38.5, BP 120/80, K 5.5 mmol/L, HR 110. Mr Sharma and Dr. Patel visited. Patient named Sita Rai.';
  const d = L.deidentify(t, known);
  for (const bad of ['Asha', 'Rai', 'Kumari', '1000017', '1980', '123-45-6789', '9812345678', 'a@b.com', 'Mahendra', 'Sharma', 'Patel', 'Sita', 'March']) assert.ok(!d.text.includes(bad), bad + ' should be gone: ' + d.text);
  for (const keep of ['45-year-old', '38.5', '120/80', '5.5 mmol/L', 'HR 110', 'Temp', 'BP']) assert.ok(d.text.includes(keep), keep + ' should stay: ' + d.text);
  assert.deepEqual(L.deidentify(t, known), d, 'deterministic: the preview and the send agree');
  assert.ok(L.deidentify('Age 93 year old').text.includes('90+'), 'ages of 90 and over become 90+');
  assert.equal(L.deidentify('warn when potassium above 5.5 or 120 80 100').text, 'warn when potassium above 5.5 or 120 80 100');
  assert.equal(L.deidentify('').text, ''); assert.equal(L.deidentify(null).text, '');
  assert.deepEqual(L.knownIdentifiers(null), []);
});

test('suggest: the case\'s real patient (and the record it was merged into) is removed from the narrative before the provider sees it', async () => {
  await setAi(true);
  const c = (await as('admin').post('/api/cases', { narrative: 'x' })).body;
  const kept = await mkPatient({ name: 'Bimala Gurung', mrn: '1000025', national_id: '987-65-4321', phone: '+977 9801112222', date_of_birth: '1975-07-01' });
  const dup = await mkPatient(IDENT);
  await db.query('UPDATE patients SET active=false, merged_into=$1, merged_at=now(), merged_by=$2 WHERE id=$3', [kept, actors.admin.id, dup]);
  await db.query('UPDATE cases SET patient_id=$1 WHERE id=$2', [dup, c.id]);
  reply = () => '{"suggestions":[],"pathways":[]}';
  const nar = 'Asha Rai, MRN 1000017, DOB 12/03/1980, phone 9812345678, daughter Bimala Gurung 1000025. Fever 38.5 for two days, K 5.5.';
  const r = await as('doctor').post('/api/llm/suggest', { narrative: nar, caseId: c.id });
  assert.equal(r.status, 200); assert.equal(calls.length, 1);
  const sent = calls[0].user;
  for (const bad of ['Asha', 'Rai', 'Bimala', 'Gurung', '1000017', '1000025', '12/03/1980', '9812345678']) assert.ok(!sent.includes(bad), bad + ' reached the provider: ' + sent);
  assert.ok(sent.includes('Fever 38.5') && sent.includes('K 5.5'), 'clinical content is kept');
  assert.ok(sent.includes('care.one | One'), 'the registry list is still there');
  const rows = await auditSince(await maxId() - 1);
  assert.ok(!JSON.stringify(rows).includes('Asha'), 'no content in the audit row');
});

test('suggest: a typed demo patient on the case is removed too', async () => {
  const c = (await as('admin').post('/api/cases', { narrative: 'x' })).body; assert.ok(c.id);
  await db.query('UPDATE cases SET demo_patient=$1 WHERE id=$2', [JSON.stringify({ name: 'Gita Magar', ageSex: '', bed: '', mrn: 'D-4471' }), c.id]);
  reply = () => '{"suggestions":[],"pathways":[]}';
  assert.equal((await as('doctor').post('/api/llm/suggest', { narrative: 'Gita Magar has a cough, D-4471', caseId: c.id })).status, 200);
  assert.ok(!/Gita|Magar|D-4471/.test(calls[0].user), calls[0].user);
});

test('preview: shows the exact text the server will send, sends nothing, writes no audit row, does not use the rate limit; the real call then sends that same text', async () => {
  const limiter = L.createLimiter({ perMinute: 1, perHour: 100 });
  const a2 = createApp({ db, getActor, llm: mock, aiLimiter: limiter });
  const nar = 'Mr Sharma, phone 9812345678, has fever 38.5';
  const m = await maxId();
  const p1 = await as('doctor', a2).post('/api/llm/suggest', { narrative: nar, preview: true });
  const p2 = await as('doctor', a2).post('/api/llm/suggest', { narrative: nar, preview: true });
  assert.equal(p1.status, 200); assert.equal(p2.status, 200);
  assert.equal(p1.body.preview, true); assert.equal(p1.body.purpose, 'suggest'); assert.ok(p1.body.removedCount >= 2); assert.ok(p1.body.removed.phone || p1.body.removed.number);
  assert.ok(!/Sharma|9812345678/.test(p1.body.sent) && p1.body.sent.includes('fever 38.5'));
  assert.equal(calls.length, 0, 'the provider was not called'); assert.equal((await auditSince(m)).length, 0, 'no audit row for a preview');
  reply = () => '{"suggestions":[],"pathways":[]}';
  const real = await as('doctor', a2).post('/api/llm/suggest', { narrative: nar });
  assert.equal(real.status, 200, 'previews did not use up the one call a minute'); assert.equal(calls[0].user, p1.body.sent, 'exactly the previewed text');
  assert.equal((await as('doctor', a2).post('/api/llm/suggest', { narrative: nar })).status, 429);
  assert.equal((await as('doctor', a2).post('/api/llm/suggest', { narrative: nar, preview: 'yes' })).status, 400);
});

test('preview obeys the same gates: AI off is 403, nurse and viewer are 403, a bad body is 400', async () => {
  const body = { narrative: 'cough', preview: true };
  assert.equal((await as('nurse').post('/api/llm/suggest', body)).status, 403); assert.equal((await as('viewer').post('/api/llm/suggest', body)).status, 403);
  assert.equal((await as('informatician').post('/api/llm/suggest', body)).status, 403);
  assert.equal((await as('doctor').post('/api/llm/suggest', { preview: true })).status, 400);
  await setAi(false);
  for (const [u, b] of [['/api/llm/schema', { diagnosis: 'Asthma', preview: true }], ['/api/llm/suggest', body], ['/api/llm/rule-draft', { ...RULE, preview: true }]]) assert.equal((await as('admin').post(u, b)).status, 403, u);
  await setAi(true); assert.equal(calls.length, 0);
});

test('schema: vignette and instructions are de-identified, the diagnosis is de-identified for the provider but comes back as the clinician typed it', async () => {
  reply = () => JSON.stringify({ diagnosis: { text: 'model text' }, sections: [{ title: 'S', fields: [{ id: 'a_b', label: 'A', type: 'number' }] }] });
  const r = await as('doctor').post('/api/llm/schema', { diagnosis: 'Dengue', vignette: 'Ram Thapa, DOB 03/04/1990, MRN 1000099, platelets falling', instructions: 'call 9812345678' });
  assert.equal(r.status, 200); assert.equal(r.body.schema.diagnosis.text, 'Dengue');
  const sent = calls[0].user; assert.ok(!/1990|1000099|9812345678/.test(sent), sent); assert.ok(sent.includes('platelets falling') && sent.includes('Diagnosis: Dengue'));
  const pv = await as('doctor').post('/api/llm/schema', { diagnosis: 'Dengue', vignette: 'Ram Thapa, DOB 03/04/1990, MRN 1000099, platelets falling', instructions: 'call 9812345678', preview: true });
  assert.equal(pv.body.sent, sent); assert.equal(calls.length, 1);
});

test('rule drafting never receives patient values: only field names, units and the typed sentence; extra keys are refused; a phone number in the sentence is removed and the typed threshold still works', async () => {
  for (const extra of [{ values: { 'care.one/k': 7.1 } }, { caseId: crypto.randomUUID() }, { patient: { name: 'X' } }]) assert.equal((await as('doctor').post('/api/llm/rule-draft', { ...RULE, ...extra })).status, 400, JSON.stringify(extra));
  assert.equal((await as('doctor').post('/api/llm/rule-draft', { ...RULE, fields: [{ ...RULE.fields[0], value: 7.1 }] })).status, 400);
  assert.equal(calls.length, 0);
  reply = () => JSON.stringify(goodRule);
  const r = await as('doctor').post('/api/llm/rule-draft', { ...RULE, text: 'Review potassium when above 5.5, phone 9812345678' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.draft.threshold, 5.5);
  const sent = calls[0].user; assert.ok(!sent.includes('9812345678'), sent);
  assert.equal(sent, 'Fields (ref | label | unit | type):\ncare.one/k | Potassium | mmol/L | number\ncare.one/t | Last reading |  | datetime\n\nSentence:\nReview potassium when above [phone removed]'.replace('above [phone removed]', 'above 5.5, phone [number removed]'));
});

test('/api/me says whether AI is on: false when off, true when on and a model is configured, false when on but no model; the admin panel says de-identification is on', async () => {
  await setAi(false); assert.equal((await as('doctor').get('/api/me')).body.ai, false);
  await setAi(true); assert.equal((await as('doctor').get('/api/me')).body.ai, true); assert.equal((await as('nurse').get('/api/me')).body.ai, true, 'the flag is the switch; the role list (allowed) says who may use it');
  const bare = createApp({ db, getActor, llm: null }); assert.equal((await as('doctor', bare).get('/api/me')).body.ai, false, 'switched on in the database but no model on the server');
  assert.equal((await as('admin').get('/api/admin/ai')).body.deidentification, 'server_patterns');
});

test('the page no longer talks to a model provider or holds a prompt: only the server routes do', () => {
  const html = fs.readFileSync(__dirname + '/enhancer.html', 'utf8');
  for (const bad of ['api.anthropic.com', 'openrouter.ai', 'callLLM', 'anthropic-dangerous-direct-browser-access', 'You are a clinical informatics assistant', 'You turn a clinician']) assert.ok(!html.includes(bad), bad);
  for (const must of ['Store.ai.preview', 'data processing agreement', 'id="aiSent"', 'Not for clinical use']) assert.ok(html.includes(must), must);
  const src = fs.readFileSync(__dirname + '/store.js', 'utf8'); assert.ok(!/api\.anthropic\.com|openrouter\.ai/.test(src));
});

// ---------------------------------------------------------------- 43a2: POST /llm/feature-request (one sentence -> a DRAFT set, pathway or rule; saves nothing)
const FR = { text: 'A simple form for a made-up condition', output: 'set' };
const goodSetReply = () => JSON.stringify({ sections: [{ title: 'S', fields: [{ id: 'a_b', label: 'A', type: 'number', unit: 'mg' }] }] });
const elementCount = async () => Number((await db.query('SELECT count(*) n FROM element_sets')).rows[0].n);
async function numSet() { await db.query(`INSERT INTO element_sets (set_id, kind, body) VALUES ('care.num','care','{"title":"Num","sections":[{"fields":[{"id":"k","label":"Potassium","type":"number","unit":"mmol/L"}]}]}') ON CONFLICT DO NOTHING`); }

test('43a2: AI off is 403 "AI disabled" with nothing sent and no audit row; viewer is always 403', async () => {
  await setAi(false);
  const m = await maxId(), r = await as('doctor').post('/api/llm/feature-request', FR);
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'ai_disabled');
  assert.equal(calls.length, 0); assert.equal((await auditSince(m)).length, 0);
  await setAi(true);
  assert.equal((await as('viewer').post('/api/llm/feature-request', FR)).status, 403);
});

test('43a2: roles: admin, doctor, nurse and informatician may ask; viewer may not', async () => {
  await setAi(true); reply = goodSetReply;
  for (const role of ['admin', 'doctor', 'nurse', 'informatician']) assert.equal((await as(role).post('/api/llm/feature-request', FR)).status, 200, role);
  assert.equal((await as('viewer').post('/api/llm/feature-request', FR)).status, 403);
});

test('43a2: inputs are validated before anything is sent: unknown key, short text, bad output, rule without an owner, unknown owner', async () => {
  await setAi(true); reply = goodSetReply;
  const bad = [{ ...FR, extra: 1 }, { ...FR, text: 'too short' }, { ...FR, output: 'order' }, { text: FR.text, output: 'rule' }, { ...FR, text: 'x'.repeat(501) }];
  for (const b of bad) assert.equal((await as('doctor').post('/api/llm/feature-request', b)).status, 400, JSON.stringify(b).slice(0, 60));
  assert.equal((await as('doctor').post('/api/llm/feature-request', { text: 'Review potassium when above 5.5', output: 'rule', owner: 'no.such' })).status, 404);
  assert.equal(calls.length, 0);
});

test('43a2: a set draft keeps no code, says so, carries provenance, and saves nothing; one audit row without the sentence or the answer', async () => {
  await setAi(true);
  reply = () => JSON.stringify({ sections: [{ title: 'S', fields: [{ id: 'a_b', label: 'A', type: 'number', coding: { system: 'snomed', code: '123456' } }] }] });
  const n = await elementCount(), m = await maxId();
  const r = await as('doctor').post('/api/llm/feature-request', FR);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.output, 'set');
  assert.equal(r.body.draft.diagnosis.snomed.code, '');
  for (const s of r.body.draft.sections) for (const f of s.fields) assert.equal(f.coding, undefined);
  assert.ok(r.body.warnings.some((w) => /Codes were left empty/.test(w)));
  assert.equal(r.body.provenance.model, 'mock-1'); assert.equal(r.body.provenance.requestText, FR.text); assert.ok(!isNaN(Date.parse(r.body.provenance.at)));
  assert.equal(await elementCount(), n, 'the route saves nothing');
  const rows = await auditSince(m); assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'ai.call'); assert.equal(rows[0].entity_id, 'feature_set'); assert.equal(rows[0].after.outcome, 'ok');
  assert.ok(!JSON.stringify(rows[0]).includes(FR.text), 'the sentence is not in the audit row'); assert.ok(!JSON.stringify(rows[0]).includes('123456'));
});

test('43a2: the sentence is de-identified before the model sees it, and the same text is the provenance', async () => {
  await setAi(true); reply = goodSetReply;
  const r = await as('doctor').post('/api/llm/feature-request', { text: 'A form for follow up, call 9820011111 about it', output: 'set' });
  assert.equal(r.status, 200);
  assert.ok(!calls[0].user.includes('9820011111')); assert.ok(!r.body.provenance.requestText.includes('9820011111'));
});

test('43a2: preview shows the exact text, sends nothing and writes no audit row', async () => {
  await setAi(true);
  const m = await maxId(), r = await as('doctor').post('/api/llm/feature-request', { ...FR, preview: true });
  assert.equal(r.status, 200); assert.equal(r.body.preview, true); assert.ok(r.body.sent.includes(FR.text));
  assert.equal(calls.length, 0); assert.equal((await auditSince(m)).length, 0);
});

test('43a2: a pathway draft keeps only registry sets (no pathway, no invented id); an answer with none is 422 and audited as invalid', async () => {
  await setAi(true);
  reply = () => JSON.stringify({ title: 'My path', setIds: ['care.one', 'nope', 'pathway.p', 'care.one'] });
  const r = await as('doctor').post('/api/llm/feature-request', { text: 'A pathway for a made-up condition', output: 'pathway' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.draft.setIds, ['care.one']); assert.equal(r.body.draft.title, 'My path');
  reply = () => JSON.stringify({ title: 'Empty', setIds: ['nope'] });
  const m = await maxId(), bad = await as('doctor').post('/api/llm/feature-request', { text: 'A pathway for a made-up condition', output: 'pathway' });
  assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'ai_invalid_output');
  const rows = await auditSince(m); assert.equal(rows.length, 1); assert.equal(rows[0].after.outcome, 'invalid_output');
});

test('43a2: a rule draft needs a threshold the person typed, a known field and an allowed operator; a set with no numeric field is 422', async () => {
  await setAi(true); await numSet();
  const ask = (text, extra) => as('doctor').post('/api/llm/feature-request', { text, output: 'rule', owner: 'care.num', ...extra });
  reply = () => JSON.stringify({ fieldRef: 'care.num/k', op: '>', threshold: 5.5, indicator: 'warning', summary: 'Review potassium' });
  const ok = await ask('Review potassium when above 5.5');
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.output, 'rule'); assert.equal(ok.body.draft.fieldRef, 'care.num/k'); assert.equal(ok.body.draft.op, '>');
  reply = () => JSON.stringify({ fieldRef: 'care.num/k', op: '>', threshold: 9, indicator: 'warning', summary: 'x' });
  assert.equal((await ask('Review potassium when above 5.5')).status, 422, 'a threshold that is not in the sentence');
  reply = () => JSON.stringify({ fieldRef: 'care.num/k', op: 'contains', threshold: 5.5, indicator: 'warning', summary: 'x' });
  assert.equal((await ask('Review potassium when above 5.5')).status, 422, 'an operator that is not allowed');
  reply = () => JSON.stringify({ fieldRef: 'care.other/z', op: '>', threshold: 5.5, indicator: 'warning', summary: 'x' });
  assert.equal((await ask('Review potassium when above 5.5')).status, 422, 'a field that is not in the set');
  const none = await as('doctor').post('/api/llm/feature-request', { text: 'Review something when above 5', output: 'rule', owner: 'care.one' });
  assert.equal(none.status, 422); assert.equal(none.body.error.code, 'no_fields');
});

test('43a2: an answer that is not JSON twice is 422, and a provider failure is a generic 502 (each audited once)', async () => {
  await setAi(true); reply = () => 'not json at all';
  let m = await maxId(), r = await as('doctor').post('/api/llm/feature-request', FR);
  assert.equal(r.status, 422); assert.equal((await auditSince(m)).length, 1);
  const bare = createApp({ db, getActor, llm: { name: 'bad', model: 'bad-1', complete: async () => { throw new L.ProviderError('secret detail'); } }, aiLimiter: L.createLimiter({ perMinute: 1000, perHour: 1000 }) });
  m = await maxId(); r = await as('doctor', bare).post('/api/llm/feature-request', FR);
  assert.equal(r.status, 502); assert.ok(!JSON.stringify(r.body).includes('secret detail')); assert.equal((await auditSince(m)).length, 1);
});
