'use strict';
// Server-side AI (chunk 04b).
//  - The provider key exists only in the server environment (AI_API_KEY). It is never stored in the database, never
//    returned by any route, never written to the audit log and never sent to the browser.
//  - AI is OFF until an admin switches it on (ai_settings.enabled, default false).
//  - Two steps: POST /api/ai/preview builds the EXACT provider request (after de-identification) and returns it for the
//    user to read; POST /api/ai/run sends exactly that stored request, once. Nothing is sent without a preview.
//  - The payload is a whitelist (diagnosis, titles/ids of library items, optional instructions). Prompts live here, so the
//    browser cannot choose what the model is told to do.
//  - One audit row when a call is made ('ai.request') and one for its outcome ('ai.result'); refusals are audited too.
const crypto = require('crypto');
const { tx } = require('./db');
const { audit } = require('./audit');
const { can } = require('./permissions');
const A = require('./auth');
const { scrub, loadKnown } = require('./deid');

const MAX_TOKENS = 3000;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEWS_PER_USER = 5;
const MAX_IN_FLIGHT_PER_USER = 2;
const MAX_REPLY_CHARS = 200000;
const LIMITS = { diagnosis: 200, instructions: 500, title: 200, items: 50, candidates: 80, systems: 6 };
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,100}$/;

/* ---------- prompts (server-owned) ---------- */
const SYS_HINT = {
  snomed: 'SNOMED CT for findings and procedures',
  loinc: 'LOINC for lab and vital-sign observations',
  rxnorm: 'RxNorm only for medication fields (drug names, never doses)',
  icd10: 'ICD-10 only for diagnosis/condition fields (cannot be machine-verified here: leave empty unless certain)',
  icd11: 'ICD-11 only for diagnosis/condition fields (cannot be machine-verified here: leave empty unless certain)',
  atc: 'ATC only for medication-class fields (cannot be machine-verified here: leave empty unless certain)',
};
const SYSTEM_KEYS = Object.keys(SYS_HINT);   // Local is never proposed by AI; CPT is off

const SYS_RANK = 'You rank EXISTING library items for relevance to a diagnosis. Return ONLY valid JSON: {"ranked":["id","id"]}. Use only ids from "candidates", at most 8, most relevant first. Do not include doses, thresholds or protocol text.';

function genPrompt(systems) {
  const sy = systems.filter(k => SYS_HINT[k]);
  const b = sy.length ? `,"bindings":[{"system":"${sy.join('|')}","code":"","display":""}]` : '';
  const term = sy.length
    ? `\nTerminology: "bindings" are CANDIDATES that will be machine-verified, so give the exact official display term. Allowed systems ONLY: ${sy.join(', ')} (${sy.map(k => SYS_HINT[k]).join('; ')}). Never use any other system. At most one binding per allowed system per field. If you are not certain of a code, leave "bindings" as an empty array (an empty binding is better than a wrong one).`
    : '\nTerminology: do NOT include codes or bindings.';
  return `You are a clinical informatics assistant. Return ONLY valid JSON (no prose, no markdown):
{"id":"snake_case","kind":"disease|care","title":"","desc":"","fields":[{"id":"snake_case","label":"","type":"datetime|number|integer|select|boolean|text","unit":"","options":[],"required":false,"repeat":false${b},"rationale":""}]}.
8-14 high-yield fields. Prioritise time-critical intervals, severity, therapy. Use select only with options. For serial observations set repeat:true.${term}
Safety: do NOT include drug doses, dose calculations, therapeutic target ranges, or protocol thresholds anywhere (labels, options, rationale). Capture what to record, not what to do. Use the diagnosis as title.`;
}

/* ---------- configuration (environment; opts.ai overrides it in tests) ---------- */
function readConfig(opts = {}) {
  const o = opts.ai || {};
  const env = process.env;
  const provider = String(o.provider ?? env.AI_PROVIDER ?? 'openrouter').trim().toLowerCase();
  const key = String(o.key ?? env.AI_API_KEY ?? '').trim();
  const model = String(o.model ?? env.AI_MODEL ?? '').trim();
  const given = o.baseUrl ?? env.AI_BASE_URL ?? '';
  let baseUrl = String(given).trim().replace(/\/+$/, '');
  let problem = null;
  if (!['openrouter', 'anthropic'].includes(provider)) problem = 'AI_PROVIDER must be openrouter or anthropic';
  else if (!key) problem = 'AI_API_KEY is not set';
  if (!baseUrl) baseUrl = provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://openrouter.ai/api/v1';
  else if (!o.baseUrl && !/^https:\/\//i.test(baseUrl)) problem = 'AI_BASE_URL must start with https://';
  return {
    provider, key, model, baseUrl, problem, configured: !problem,
    timeoutMs: Number(o.timeoutMs) || 55000,
    fetch: o.fetch || globalThis.fetch,
  };
}

/* ---------- payload whitelist ---------- */
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Validates the shape and returns a clean copy. Unknown keys are rejected, never silently passed on.
function validatePayload(kind, p) {
  if (!isObj(p)) return { error: 'The AI request must be an object.' };
  const allowed = kind === 'gen'
    ? ['diagnosis', 'instructions', 'systems']
    : ['diagnosis', 'instructions', 'applied_sets', 'applied_pathways', 'candidates'];
  const extra = Object.keys(p).filter(k => !allowed.includes(k));
  if (extra.length) return { error: `Not allowed in an AI request: ${extra.join(', ')}. Only a diagnosis, titles/ids of library items and your instructions can be sent.` };
  const out = {};
  if (typeof p.diagnosis !== 'string' || !p.diagnosis.trim()) return { error: 'A diagnosis is required.' };
  if (p.diagnosis.trim().length > LIMITS.diagnosis) return { error: `Diagnosis is too long (max ${LIMITS.diagnosis} characters).` };
  out.diagnosis = p.diagnosis.trim();
  if (p.instructions != null && p.instructions !== '') {
    if (typeof p.instructions !== 'string') return { error: 'Instructions must be text.' };
    if (p.instructions.trim().length > LIMITS.instructions) return { error: `Instructions are too long (max ${LIMITS.instructions} characters).` };
    if (p.instructions.trim()) out.instructions = p.instructions.trim();
  }
  if (kind === 'gen') {
    const sys = p.systems == null ? [] : p.systems;
    if (!Array.isArray(sys) || sys.length > LIMITS.systems || sys.some(k => !SYSTEM_KEYS.includes(k)))
      return { error: `systems must be a list of: ${SYSTEM_KEYS.join(', ')}.` };
    out.systems = [...new Set(sys)];
    return { value: out };
  }
  const item = (x, withType) => {
    if (!isObj(x)) return null;
    const keys = Object.keys(x).filter(k => !['id', 'title'].concat(withType ? ['type'] : []).includes(k));
    if (keys.length || typeof x.id !== 'string' || !ID_RE.test(x.id) || typeof x.title !== 'string') return null;
    const title = x.title.trim();
    if (!title || title.length > LIMITS.title) return null;
    if (withType && !['element', 'pathway'].includes(x.type)) return null;
    return withType ? { type: x.type, id: x.id, title } : { id: x.id, title };
  };
  const list = (v, max, withType, name) => {
    if (v == null) v = [];
    if (!Array.isArray(v) || v.length > max) return { error: `${name} must be a list of at most ${max} items.` };
    const r = v.map(x => item(x, withType));
    if (r.some(x => !x)) return { error: `${name} items must be {${withType ? 'type, ' : ''}id, title} with a plain id and a short title.` };
    return { value: r };
  };
  for (const [key, max, withType] of [['applied_sets', LIMITS.items, false], ['applied_pathways', LIMITS.items, false], ['candidates', LIMITS.candidates, true]]) {
    const r = list(p[key], max, withType, key);
    if (r.error) return r;
    out[key] = r.value;
  }
  if (!out.candidates.length) return { error: 'There is nothing to rank (no candidates).' };
  return { value: out };
}

// De-identify every free-text string. Ids are validated by pattern and left untouched so rankings can be mapped back.
function deidentify(kind, v, known) {
  const counts = {};
  const s = t => scrub(t, known, counts).text;
  const out = { diagnosis: s(v.diagnosis) };
  if (v.instructions) out.instructions = s(v.instructions);
  if (kind === 'gen') out.systems = v.systems;
  else {
    out.applied_sets = v.applied_sets.map(x => ({ id: x.id, title: s(x.title) }));
    out.applied_pathways = v.applied_pathways.map(x => ({ id: x.id, title: s(x.title) }));
    out.candidates = v.candidates.map(x => ({ type: x.type, id: x.id, title: s(x.title) }));
  }
  return { payload: out, counts };
}

/* ---------- provider request / call ---------- */
function buildRequest(cfg, kind, payload, model) {
  const system = kind === 'rank' ? SYS_RANK : genPrompt(payload.systems);
  const user = kind === 'rank'
    ? JSON.stringify(payload)
    : `Diagnosis: ${payload.diagnosis}` + (payload.instructions ? `\nExtra: ${payload.instructions}` : '');
  if (cfg.provider === 'anthropic') {
    return {
      url: `${cfg.baseUrl}/v1/messages`,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      authName: 'x-api-key',
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] }),
    };
  }
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    headers: { 'content-type': 'application/json' },
    authName: 'Authorization',
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  };
}

const fail = (code, message, status, extra = {}) => Object.assign(new Error(message), { aiCode: code, status, ...extra });

// Sends the stored request. Provider error bodies are never passed on (they can echo headers).
async function callProvider(cfg, rq) {
  const authValue = cfg.provider === 'anthropic' ? cfg.key : 'Bearer ' + cfg.key;
  let res, text;
  try {
    res = await cfg.fetch(rq.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs),
      headers: { ...rq.headers, [rq.authName]: authValue }, body: rq.body,
    });
    text = await res.text();
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      throw fail('provider_timeout', `The AI provider did not answer within ${Math.round(cfg.timeoutMs / 1000)} seconds.`, 504);
    throw fail('provider_unreachable', 'Could not reach the AI provider.', 502);
  }
  if (!res.ok) throw fail('provider_error', `The AI provider returned an error (HTTP ${res.status}).`, 502, { providerStatus: res.status });
  if (text.length > MAX_REPLY_CHARS) throw fail('provider_bad_reply', 'The AI provider reply was too large.', 502);
  let j;
  try { j = JSON.parse(text); } catch (_) { throw fail('provider_bad_reply', 'The AI provider reply was not valid JSON.', 502); }
  const out = cfg.provider === 'anthropic'
    ? (Array.isArray(j.content) ? j.content.filter(b => b && b.type === 'text').map(b => b.text).join('') : null)
    : (j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null);
  if (typeof out !== 'string' || !out) throw fail('provider_bad_reply', 'The AI provider reply had no text.', 502);
  return out;
}

/* ---------- settings, usage ---------- */
const getSettings = async db => (await db.query('SELECT enabled, model, hourly_limit_per_user, daily_limit_total FROM ai_settings WHERE id = 1')).rows[0];

async function usage(db, userId) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE user_id = $1 AND at > now() - interval '1 hour')::int AS hour,
            count(*)::int AS day
       FROM audit_log WHERE action = 'ai.request' AND at > now() - interval '24 hours'`, [userId]);
  return rows[0];
}

async function statusFor(db, req, cfg) {
  const s = await getSettings(db);
  const u = await usage(db, req.user.id);
  const out = {
    enabled: s.enabled, configured: cfg.configured, canUse: can(req.user.role, 'ai:use'),
    provider: cfg.provider, model: s.model || cfg.model || '',
    hourlyLimit: s.hourly_limit_per_user, usedThisHour: u.hour,
  };
  if (can(req.user.role, 'ai:admin')) {
    out.admin = { modelOverride: s.model || '', serverModel: cfg.model || '', dailyLimit: s.daily_limit_total, usedToday: u.day, problem: cfg.problem };
  }
  return out;
}

/* ---------- routes ---------- */
function mountAi(app, pool, opts = {}) {
  const previews = new Map();       // previewId -> { userId, kind, model, rq, sha, counts, exp }
  const inFlight = new Map();       // userId -> running calls
  const sweep = () => { const now = Date.now(); for (const [k, v] of previews) if (v.exp < now) previews.delete(k); };
  const cfgNow = () => readConfig(opts);

  app.get('/api/ai/status', A.requireLogin, async (req, res) => res.json({ ai: await statusFor(pool, req, cfgNow()) }));

  app.put('/api/ai/settings', A.requirePerm(pool, 'ai:admin'), async (req, res) => {
    const b = req.body || {};
    const known = ['enabled', 'model', 'hourlyLimitPerUser', 'dailyLimitTotal'];
    const extra = Object.keys(b).filter(k => !known.includes(k));
    if (extra.length || !Object.keys(b).length) return res.status(400).json({ error: 'invalid', message: `Send any of: ${known.join(', ')}.` });
    const set = {};
    if ('enabled' in b) { if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'invalid', message: 'enabled must be true or false.' }); set.enabled = b.enabled; }
    if ('model' in b) {
      const m = String(b.model == null ? '' : b.model).trim();
      if (m && !MODEL_RE.test(m)) return res.status(400).json({ error: 'invalid', message: 'Model may only contain letters, digits and . _ : / - (max 100).' });
      set.model = m || null;
    }
    for (const [k, col, lo, hi] of [['hourlyLimitPerUser', 'hourly_limit_per_user', 1, 500], ['dailyLimitTotal', 'daily_limit_total', 1, 5000]]) {
      if (k in b) {
        if (!Number.isInteger(b[k]) || b[k] < lo || b[k] > hi) return res.status(400).json({ error: 'invalid', message: `${k} must be a whole number from ${lo} to ${hi}.` });
        set[col] = b[k];
      }
    }
    await tx(pool, async c => {
      const before = (await c.query('SELECT enabled, model, hourly_limit_per_user, daily_limit_total FROM ai_settings WHERE id = 1 FOR UPDATE')).rows[0];
      const cols = Object.keys(set);
      await c.query(`UPDATE ai_settings SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_by = $${cols.length + 1}, updated_at = now() WHERE id = 1`,
        [...cols.map(k => set[k]), req.user.id]);
      const after = (await c.query('SELECT enabled, model, hourly_limit_per_user, daily_limit_total FROM ai_settings WHERE id = 1')).rows[0];
      await audit(c, req, 'ai.settings', 'ai', 1, { before, after });
    });
    res.json({ ai: await statusFor(pool, req, cfgNow()) });
  });

  app.post('/api/ai/preview', A.requirePerm(pool, 'ai:use'), async (req, res) => {
    const cfg = cfgNow();
    const s = await getSettings(pool);
    if (!s.enabled) {
      await audit(pool, req, 'ai.refused', 'ai', null, { reason: 'off', stage: 'preview' });
      return res.status(409).json({ error: 'ai_off', message: 'AI is switched off. An administrator can switch it on in Settings.' });
    }
    if (!cfg.configured) return res.status(503).json({ error: 'not_configured', message: `The server has no AI provider set up yet (${cfg.problem}).` });
    const model = s.model || cfg.model;
    if (!model || !MODEL_RE.test(model)) return res.status(503).json({ error: 'no_model', message: 'No AI model is set. An administrator can set one in Settings (or AI_MODEL on the server).' });
    const kind = req.body && req.body.kind;
    if (!['gen', 'rank'].includes(kind)) return res.status(400).json({ error: 'invalid', message: 'kind must be gen or rank.' });
    const v = validatePayload(kind, req.body.payload);
    if (v.error) return res.status(400).json({ error: 'invalid', message: v.error });
    const { payload, counts } = deidentify(kind, v.value, await loadKnown(pool));
    if (!payload.diagnosis || /^(\[[A-Z]+\]\s*)+$/.test(payload.diagnosis))
      return res.status(400).json({ error: 'invalid', message: 'After removing identifying details the diagnosis is empty. Enter the diagnosis only, with no patient details.' });
    const rq = buildRequest(cfg, kind, payload, model);

    sweep();
    const mine = [...previews.entries()].filter(([, p]) => p.userId === req.user.id);
    while (mine.length >= MAX_PREVIEWS_PER_USER) previews.delete(mine.shift()[0]);   // oldest first
    const previewId = crypto.randomBytes(24).toString('base64url');
    previews.set(previewId, { userId: req.user.id, kind, model, rq, counts, exp: Date.now() + PREVIEW_TTL_MS,
      sha: crypto.createHash('sha256').update(rq.body).digest('hex') });
    res.json({
      previewId, expiresInSec: PREVIEW_TTL_MS / 1000, kind, provider: cfg.provider, model,
      method: 'POST', url: rq.url, headers: rq.headers,
      auth: `${rq.authName}: (the server's key, never shown and never sent to your browser)`,
      body: rq.body,
      redactions: Object.entries(counts).map(([k, count]) => ({ kind: k, count })),
    });
  });

  app.post('/api/ai/run', A.requirePerm(pool, 'ai:use'), async (req, res) => {
    sweep();
    const id = String((req.body && req.body.previewId) || '');
    const pv = previews.get(id);
    if (!pv || pv.userId !== req.user.id) return res.status(404).json({ error: 'preview_not_found', message: 'That preview expired or was already used. Click the AI button again to see a new preview.' });
    previews.delete(id);   // one preview, one call
    const cfg = cfgNow();
    const s = await getSettings(pool);
    if (!s.enabled) {
      await audit(pool, req, 'ai.refused', 'ai', null, { reason: 'off', stage: 'run' });
      return res.status(409).json({ error: 'ai_off', message: 'AI was switched off. Nothing was sent.' });
    }
    if (!cfg.configured) return res.status(503).json({ error: 'not_configured', message: `The server has no AI provider set up yet (${cfg.problem}). Nothing was sent.` });
    if ((inFlight.get(req.user.id) || 0) >= MAX_IN_FLIGHT_PER_USER)
      return res.status(429).json({ error: 'busy', message: 'You already have AI calls running. Wait for them to finish.' });

    // Count + record the request atomically per user, so two quick clicks cannot both slip under the limit.
    const gate = await tx(pool, async c => {
      await c.query('SELECT pg_advisory_xact_lock(727002, $1::int)', [req.user.id]);
      const u = await usage(c, req.user.id);
      if (u.hour >= s.hourly_limit_per_user || u.day >= s.daily_limit_total) {
        const which = u.hour >= s.hourly_limit_per_user ? 'hourly_user_limit' : 'daily_limit';
        await audit(c, req, 'ai.refused', 'ai', null, { reason: which, kind: pv.kind });
        return { ok: false, which };
      }
      await audit(c, req, 'ai.request', 'ai', null, {
        kind: pv.kind, provider: cfg.provider, model: pv.model, bytes: Buffer.byteLength(pv.rq.body),
        payloadSha256: pv.sha, redactions: pv.counts, usedThisHour: u.hour + 1,
      });
      return { ok: true, used: u.hour + 1 };
    });
    if (!gate.ok) {
      return res.status(429).json({ error: 'rate_limited', message: gate.which === 'hourly_user_limit'
        ? `You have reached your limit of ${s.hourly_limit_per_user} AI requests per hour. Nothing was sent.`
        : `The server has reached its limit of ${s.daily_limit_total} AI requests per day. Nothing was sent.` });
    }

    const t0 = Date.now();
    inFlight.set(req.user.id, (inFlight.get(req.user.id) || 0) + 1);
    try {
      const text = await callProvider(cfg, pv.rq);
      await audit(pool, req, 'ai.result', 'ai', null, { kind: pv.kind, ok: true, ms: Date.now() - t0, replyChars: text.length });
      res.json({ text, model: pv.model, remainingThisHour: Math.max(0, s.hourly_limit_per_user - gate.used) });
    } catch (e) {
      if (!e.aiCode) throw e;
      await audit(pool, req, 'ai.result', 'ai', null, { kind: pv.kind, ok: false, error: e.aiCode, providerStatus: e.providerStatus || null, ms: Date.now() - t0 });
      res.status(e.status || 502).json({ error: e.aiCode, message: e.message });
    } finally {
      const n = (inFlight.get(req.user.id) || 1) - 1;
      if (n <= 0) inFlight.delete(req.user.id); else inFlight.set(req.user.id, n);
    }
  });
}

module.exports = { mountAi, readConfig, validatePayload, deidentify, buildRequest, genPrompt, SYS_RANK, SYSTEM_KEYS, LIMITS };
