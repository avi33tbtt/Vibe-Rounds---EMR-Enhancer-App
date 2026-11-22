'use strict';
// Chunk 04b: AI on the server. Real app + PostgreSQL, with a local mock "provider" (no network, no real key).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, client } = require('./helpers');
const { genPrompt, SYS_RANK } = require('../ai');

const KEY = 'sk-test-SECRET-1234567890';
let env, prov, provUrl, seen, mode, anthropicShape;

function startProvider() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', d => { b += d; });
      req.on('end', async () => {
        seen.push({ url: req.url, headers: req.headers, body: b });
        if (mode === 'slow') { await new Promise(r => setTimeout(r, 600)); }
        if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'bad key ' + KEY } })); }
        if (mode === 'garbage') { res.writeHead(200); return res.end('not json'); }
        const text = JSON.stringify({ title: 'Mock set', fields: [{ id: 'a', label: 'A', type: 'text' }] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthropicShape ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const cfgBox = { provider: 'openrouter', key: KEY, model: 'test/model-1', baseUrl: '', timeoutMs: 5000 };
test.before(async () => {
  seen = []; mode = 'ok'; anthropicShape = false;
  prov = await startProvider();
  provUrl = `http://127.0.0.1:${prov.address().port}`;
  cfgBox.baseUrl = provUrl;
  env = await setup({ ai: cfgBox });
});
test.after(async () => { await env.close(); await new Promise(r => prov.close(r)); });
test.beforeEach(() => { seen.length = 0; mode = 'ok'; anthropicShape = false; Object.assign(cfgBox, { provider: 'openrouter', key: KEY, model: 'test/model-1', timeoutMs: 5000 }); });

async function as(user) { const c = client(env.base); const r = await c.login(user); assert.equal(r.status, 200); return c; }
async function setAi(patch) { const a = await as('admin1'); const r = await a.raw('PUT', '/api/ai/settings', patch); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.ai; }
const GEN = (over = {}) => ({ kind: 'gen', payload: { diagnosis: 'Diabetic ketoacidosis', instructions: 'focus on time-critical intervals', systems: ['snomed', 'loinc'], ...over } });
const RANK = { kind: 'rank', payload: { diagnosis: 'Sepsis', applied_sets: [{ id: 'vitals', title: 'Vitals' }], applied_pathways: [],
  candidates: [{ type: 'element', id: 'sepsis_bundle', title: 'Sepsis bundle' }, { type: 'pathway', id: 'icu_path', title: 'ICU pathway' }] } };
const auditRows = async () => (await env.pool.query('SELECT * FROM audit_log ORDER BY id')).rows;

test('AI is OFF by default: nothing reaches the provider, and previews are refused', async () => {
  await env.pool.query('UPDATE ai_settings SET enabled = false, model = NULL WHERE id = 1');
  const d = await as('doctor1');
  const st = await d.get('/api/ai/status');
  assert.equal(st.body.ai.enabled, false);
  assert.equal(st.body.ai.configured, true);
  const pv = await d.post('/api/ai/preview', GEN());
  assert.equal(pv.status, 409); assert.equal(pv.body.error, 'ai_off');
  const run = await d.post('/api/ai/run', { previewId: 'nope' });
  assert.equal(run.status, 404);
  assert.equal(seen.length, 0);
  const row = (await env.pool.query('SELECT enabled FROM ai_settings')).rows[0];
  assert.equal(row.enabled, false);   // the migration default
});

test('only an admin can flip the switch; every change is audited with before/after', async () => {
  const d = await as('doctor1');
  assert.equal((await d.raw('PUT', '/api/ai/settings', { enabled: true })).status, 403);
  const n = await as('nurse1');
  assert.equal((await n.raw('PUT', '/api/ai/settings', { enabled: true })).status, 403);
  const a = await as('admin1');
  for (const bad of [{ enabled: 'yes' }, { hourlyLimitPerUser: 0 }, { dailyLimitTotal: 99999 }, { model: 'bad model!' }, { apiKey: 'x' }, {}])
    assert.equal((await a.raw('PUT', '/api/ai/settings', bad)).status, 400, JSON.stringify(bad));
  const ai = await setAi({ enabled: true, model: 'test/model-1' });
  assert.equal(ai.enabled, true); assert.equal(ai.admin.modelOverride, 'test/model-1');
  const row = (await auditRows()).filter(r => r.action === 'ai.settings').pop();
  assert.equal(row.username, 'admin1');
  assert.equal(row.detail.before.enabled, false); assert.equal(row.detail.after.enabled, true);
  assert.ok((await auditRows()).some(r => r.action === 'permission.denied' && r.detail.perm === 'ai:admin'));
  await setAi({ enabled: false });
});

test('roles: nurse and viewer cannot use AI; the server decides, not the UI', async () => {
  await setAi({ enabled: true, model: 'test/model-1' });
  for (const u of ['nurse1', 'viewer1']) {
    const c = await as(u);
    assert.equal((await c.post('/api/ai/preview', GEN())).status, 403);
    assert.equal((await c.post('/api/ai/run', { previewId: 'x' })).status, 403);
    assert.equal((await c.get('/api/ai/status')).body.ai.canUse, false);
  }
  assert.equal((await client(env.base).post('/api/ai/preview', GEN())).status, 401);
  assert.equal(seen.length, 0);
  await setAi({ enabled: false });
});

test('preview shows the exact request; run sends exactly that; the key never leaves the server', async () => {
  await setAi({ enabled: true, model: 'test/model-1', hourlyLimitPerUser: 20 });
  const d = await as('doctor1');
  const pv = await d.post('/api/ai/preview', GEN());
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(seen.length, 0, 'a preview sends nothing');
  const sent = JSON.parse(pv.body.body);
  assert.equal(sent.model, 'test/model-1');
  assert.equal(sent.messages[0].content, genPrompt(['snomed', 'loinc']));
  assert.equal(sent.messages[1].content, 'Diagnosis: Diabetic ketoacidosis\nExtra: focus on time-critical intervals');
  const run = await d.post('/api/ai/run', { previewId: pv.body.previewId });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, pv.body.body, 'provider received byte-for-byte what the user was shown');
  assert.equal(seen[0].url, '/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer ' + KEY);
  assert.match(run.body.text, /Mock set/);
  // nothing the browser can see carries the key
  const st = await d.get('/api/ai/status');
  const adminSt = await (await as('admin1')).get('/api/ai/status');
  for (const x of [pv.body, run.body, st.body, adminSt.body]) assert.ok(!JSON.stringify(x).includes(KEY));
  assert.ok(!JSON.stringify(await auditRows()).includes(KEY));
  assert.ok(!JSON.stringify(pv.body.headers).toLowerCase().includes('authorization'));
  // one preview, one call
  assert.equal((await d.post('/api/ai/run', { previewId: pv.body.previewId })).status, 404);
  assert.equal(seen.length, 1);
  await setAi({ enabled: false });
});

test('a preview belongs to the user who made it', async () => {
  await setAi({ enabled: true, model: 'test/model-1' });
  const d = await as('doctor1'), a = await as('admin1');
  const pv = await d.post('/api/ai/preview', GEN());
  assert.equal((await a.post('/api/ai/run', { previewId: pv.body.previewId })).status, 404);
  assert.equal(seen.length, 0);
  await setAi({ enabled: false });
});

test('switching AI off after a preview stops the call', async () => {
  await setAi({ enabled: true, model: 'test/model-1' });
  const d = await as('doctor1');
  const pv = await d.post('/api/ai/preview', GEN());
  await setAi({ enabled: false });
  const run = await d.post('/api/ai/run', { previewId: pv.body.previewId });
  assert.equal(run.status, 409); assert.equal(run.body.error, 'ai_off');
  assert.equal(seen.length, 0);
});

test('payload is a whitelist: patient fields, narrative and unknown keys are rejected', async () => {
  await setAi({ enabled: true, model: 'test/model-1' });
  const d = await as('doctor1');
  for (const extra of [{ patient: { name: 'X' } }, { narrative: 'text' }, { name: 'Asha' }, { mrn: '1' }, { values: {} }])
    assert.equal((await d.post('/api/ai/preview', GEN(extra))).status, 400, JSON.stringify(extra));
  assert.equal((await d.post('/api/ai/preview', GEN({ systems: ['snomed', 'cpt'] }))).status, 400);
  assert.equal((await d.post('/api/ai/preview', GEN({ diagnosis: 'x'.repeat(201) }))).status, 400);
  assert.equal((await d.post('/api/ai/preview', GEN({ instructions: 'x'.repeat(501) }))).status, 400);
  assert.equal((await d.post('/api/ai/preview', GEN({ diagnosis: '   ' }))).status, 400);
  assert.equal((await d.post('/api/ai/preview', { kind: 'chat', payload: {} })).status, 400);
  const r = (o, extraCand = {}) => ({ kind: 'rank', payload: { ...RANK.payload, ...o } });
  assert.equal((await d.post('/api/ai/preview', r({ narrative: 'n' }))).status, 400);
  assert.equal((await d.post('/api/ai/preview', r({ candidates: [{ type: 'element', id: 'a b', title: 'T' }] }))).status, 400);   // id pattern
  assert.equal((await d.post('/api/ai/preview', r({ candidates: [{ type: 'element', id: 'a', title: 'T', notes: 'x' }] }))).status, 400);   // extra key on an item
  assert.equal((await d.post('/api/ai/preview', r({ candidates: Array.from({ length: 81 }, (_, i) => ({ type: 'element', id: 'e' + i, title: 'T' })) }))).status, 400);
  assert.equal((await d.post('/api/ai/preview', r({ candidates: [] }))).status, 400);
  assert.equal((await d.post('/api/ai/preview', RANK)).status, 200);
  assert.equal(seen.length, 0);
  await setAi({ enabled: false });
});

test('de-identification: registered names, MRNs, dates, phones, emails and ages never reach the provider', async () => {
  await setAi({ enabled: true, model: 'test/model-1' });
  const d = await as('doctor1');
  const reg = await d.post('/api/patients', { name: 'Zubeida Quraishi', mrn: 'DEID-4471', dob: '1980-05-06', sex: 'F' });
  assert.equal(reg.status, 201);
  const dirty = 'Sepsis in Zubeida Quraishi MRN DEID-4471, seen 2026-03-04, call 98765 43210, z.q@example.org, 45-year-old, bed ICU-3, Dr. Rao';
  const pv = await d.post('/api/ai/preview', GEN({ diagnosis: dirty, instructions: 'Quraishi family asked about 12 March 2026' }));
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  for (const leak of ['Zubeida', 'Quraishi', 'DEID-4471', '2026-03-04', '98765', 'z.q@example.org', '45-year', 'ICU-3', 'Rao', '12 March'])
    assert.ok(!pv.body.body.includes(leak), 'leaked: ' + leak);
  assert.ok(pv.body.body.includes('Sepsis'));
  const kinds = Object.fromEntries(pv.body.redactions.map(r => [r.kind, r.count]));
  for (const k of ['name', 'mrn', 'date', 'phone', 'email', 'age', 'bed']) assert.ok(kinds[k] >= 1, 'no redaction counted for ' + k);
  await d.post('/api/ai/run', { previewId: pv.body.previewId });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].body.includes('Quraishi'));
  // titles in rank requests are scrubbed too
  const rk = await d.post('/api/ai/preview', { kind: 'rank', payload: { ...RANK.payload, candidates: [{ type: 'element', id: 'x1', title: 'Quraishi special set' }] } });
  assert.ok(!rk.body.body.includes('Quraishi'));
  // a diagnosis that is nothing but identifiers is refused
  assert.equal((await d.post('/api/ai/preview', GEN({ diagnosis: 'Zubeida Quraishi' }))).status, 400);
  // the audit log keeps counts and a hash, not the text
  const aiRows = JSON.stringify((await auditRows()).filter(r => r.action.startsWith('ai.')));
  assert.ok(!aiRows.includes('Sepsis in')); assert.ok(!aiRows.includes('DEID-4471')); assert.ok(!aiRows.includes('Quraishi'));
  await setAi({ enabled: false });
});

test('request limits: per user per hour and per day; refusals are audited and nothing is sent', async () => {
  await setAi({ enabled: true, model: 'test/model-1', hourlyLimitPerUser: 1, dailyLimitTotal: 5000 });
  const d = await as('doctor1');
  const used = (await d.get('/api/ai/status')).body.ai.usedThisHour;
  await setAi({ hourlyLimitPerUser: used + 2 });
  const go = async () => d.post('/api/ai/run', { previewId: (await d.post('/api/ai/preview', GEN())).body.previewId });
  assert.equal((await go()).status, 200);
  const last = await go(); assert.equal(last.status, 200); assert.equal(last.body.remainingThisHour, 0);
  const n = seen.length;
  const over = await go();
  assert.equal(over.status, 429); assert.equal(over.body.error, 'rate_limited');
  assert.equal(seen.length, n, 'nothing sent past the limit');
  assert.ok((await auditRows()).some(r => r.action === 'ai.refused' && r.detail.reason === 'hourly_user_limit'));
  // another user is not affected by this user's hourly limit
  const a = await as('admin1');
  const pva = await a.post('/api/ai/preview', GEN());
  assert.equal((await a.post('/api/ai/run', { previewId: pva.body.previewId })).status, 200);
  // the daily cap applies to everyone
  const day = (await a.get('/api/ai/status')).body.ai.admin.usedToday;
  await setAi({ hourlyLimitPerUser: 500, dailyLimitTotal: day });
  const pv2 = await a.post('/api/ai/preview', GEN());
  const cap = await a.post('/api/ai/run', { previewId: pv2.body.previewId });
  assert.equal(cap.status, 429);
  assert.ok((await auditRows()).some(r => r.action === 'ai.refused' && r.detail.reason === 'daily_limit'));
  await setAi({ enabled: false, dailyLimitTotal: 200, hourlyLimitPerUser: 20 });
});

test('every call writes ai.request and ai.result with the user from the session (no text, no key)', async () => {
  await setAi({ enabled: true, model: 'test/model-1', hourlyLimitPerUser: 500, dailyLimitTotal: 5000 });
  const d = await as('doctor1');
  const before = (await auditRows()).length;
  const pv = await d.post('/api/ai/preview', RANK);
  const run = await d.post('/api/ai/run', { previewId: pv.body.previewId });
  assert.equal(run.status, 200);
  const rows = (await auditRows()).slice(before);
  assert.deepEqual(rows.map(r => r.action), ['ai.request', 'ai.result']);
  assert.ok(rows.every(r => r.username === 'doctor1' && r.role === 'doctor'));
  assert.equal(rows[0].detail.kind, 'rank'); assert.equal(rows[0].detail.model, 'test/model-1');
  assert.match(rows[0].detail.payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(rows[1].detail.ok, true);
  assert.ok(!JSON.stringify(rows).includes('Sepsis bundle'));
  await setAi({ enabled: false });
});

test('provider failures: generic message, provider body (which echoes the key) is not passed on, outcome audited', async () => {
  await setAi({ enabled: true, model: 'test/model-1', hourlyLimitPerUser: 500, dailyLimitTotal: 5000 });
  const d = await as('doctor1');
  mode = 'error';
  let pv = await d.post('/api/ai/preview', GEN());
  let run = await d.post('/api/ai/run', { previewId: pv.body.previewId });
  assert.equal(run.status, 502); assert.equal(run.body.error, 'provider_error');
  assert.ok(!JSON.stringify(run.body).includes(KEY)); assert.ok(!JSON.stringify(run.body).includes('bad key'));
  assert.equal((await auditRows()).filter(r => r.action === 'ai.result').pop().detail.ok, false);
  mode = 'garbage';
  pv = await d.post('/api/ai/preview', GEN());
  run = await d.post('/api/ai/run', { previewId: pv.body.previewId });
  assert.equal(run.status, 502); assert.equal(run.body.error, 'provider_bad_reply');
  mode = 'slow'; cfgBox.timeoutMs = 150;
  pv = await d.post('/api/ai/preview', GEN());
  run = await d.post('/api/ai/run', { previewId: pv.body.previewId });
  assert.equal(run.status, 504); assert.equal(run.body.error, 'provider_timeout');
  await setAi({ enabled: false });
});

test('anthropic provider shape: /v1/messages with x-api-key, system prompt owned by the server', async () => {
  await setAi({ enabled: true, model: 'claude-test', hourlyLimitPerUser: 500, dailyLimitTotal: 5000 });
  cfgBox.provider = 'anthropic'; anthropicShape = true;
  const d = await as('doctor1');
  const pv = await d.post('/api/ai/preview', RANK);
  const body = JSON.parse(pv.body.body);
  assert.equal(body.system, SYS_RANK); assert.equal(body.model, 'claude-test'); assert.equal(body.max_tokens, 3000);
  const run = await d.post('/api/ai/run', { previewId: pv.body.previewId });
  assert.equal(run.status, 200); assert.match(run.body.text, /Mock set/);
  assert.equal(seen[0].url, '/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], KEY);
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].headers.authorization, undefined);
  await setAi({ enabled: false });
});

test('not configured: an admin can see why, and no call is possible', async () => {
  await setAi({ enabled: true, model: 'test/model-1' });
  cfgBox.key = '';
  const a = await as('admin1');
  const st = await a.get('/api/ai/status');
  assert.equal(st.body.ai.configured, false); assert.match(st.body.ai.admin.problem, /AI_API_KEY/);
  const pv = await a.post('/api/ai/preview', GEN());
  assert.equal(pv.status, 503); assert.equal(pv.body.error, 'not_configured');
  cfgBox.key = KEY; cfgBox.model = '';
  await setAi({ model: '' });
  const nm = await a.post('/api/ai/preview', GEN());
  assert.equal(nm.status, 503); assert.equal(nm.body.error, 'no_model');
  assert.equal(seen.length, 0);
  await setAi({ enabled: false });
});
