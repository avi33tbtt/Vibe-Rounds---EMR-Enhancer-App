'use strict';
// Chunk 06b: security headers, Secure cookie, rate limits (and that a refusal is audited).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, PW } = require('./helpers');
const { createLimiter } = require('../ratelimit');

const raw = (base, method, path, body, headers = {}) => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', 'x-emr': '1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const rateRows = pool => pool.query(`SELECT username, detail FROM audit_log WHERE action = 'rate_limited' ORDER BY id`).then(r => r.rows);

test('security headers are on every response; HSTS only when HTTPS is flagged', async () => {
  for (const https of [false, true]) {
    const { base, close } = await setup({ https });
    try {
      for (const path of ['/', '/api/me', '/api/nope']) {
        const h = (await raw(base, 'GET', path)).headers;
        assert.equal(h.get('x-frame-options'), 'DENY', path);
        assert.equal(h.get('referrer-policy'), 'no-referrer', path);
        assert.match(h.get('permissions-policy'), /camera=\(\).*microphone=\(\).*geolocation=\(\)/, path);
        assert.equal(h.get('x-content-type-options'), 'nosniff', path);
        assert.equal(h.get('cache-control'), 'no-store', path);
        assert.ok(h.get('content-security-policy'), 'CSP is on every response (chunk 6d-1; details in safety-csp.test.js)');
        assert.equal(!!h.get('strict-transport-security'), https, `HSTS ${path} https=${https}`);
        if (https) assert.match(h.get('strict-transport-security'), /max-age=\d+/);
      }
    } finally { await close(); }
  }
});

test('session cookie: HttpOnly + SameSite=Strict always; Secure only when HTTPS is flagged (login and logout)', async () => {
  for (const https of [false, true]) {
    const { base, close } = await setup({ https });
    try {
      const login = await raw(base, 'POST', '/api/login', { username: 'doctor1', password: PW });
      const sc = login.headers.get('set-cookie');
      assert.match(sc, /^sid=[\w-]+;/);
      assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//);
      assert.equal(/;\s*Secure/.test(sc), https, 'login cookie Secure=' + https);
      const out = await raw(base, 'POST', '/api/logout', {}, { cookie: sc.split(';')[0] });
      const sc2 = out.headers.get('set-cookie');
      assert.match(sc2, /Max-Age=0/);
      assert.equal(/;\s*Secure/.test(sc2), https, 'logout cookie Secure=' + https);
    } finally { await close(); }
  }
});

test('login: the Nth failed attempt for one username gets 429, even with the right password; audited once', async () => {
  const { pool, base, close } = await setup({ limits: { loginUser: { max: 3 } } });
  try {
    const c = client(base);
    for (let i = 0; i < 3; i++) assert.equal((await c.login('doctor1', 'wrong')).status, 401, 'attempt ' + (i + 1));
    const r = await raw(base, 'POST', '/api/login', { username: 'doctor1', password: PW });
    assert.equal(r.status, 429); assert.equal((await r.json()).error, 'rate_limited');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(r.headers.get('set-cookie'), null, 'no session was created');
    for (let i = 0; i < 4; i++) assert.equal((await raw(base, 'POST', '/api/login', { username: 'doctor1', password: 'x' })).status, 429);
    const rows = await rateRows(pool);
    assert.equal(rows.length, 1, 'one audit row per key per window, not one per refusal');
    assert.equal(rows[0].detail.scope, 'login_username'); assert.equal(rows[0].username, 'doctor1');
    assert.equal((await client(base).login('nurse1')).status, 200, 'other usernames are not affected');
  } finally { await close(); }
});

test('login: a successful sign-in clears that username\'s failure count', async () => {
  const { base, close } = await setup({ limits: { loginUser: { max: 3 } } });
  try {
    const c = client(base);
    for (let round = 0; round < 3; round++) {
      assert.equal((await c.login('doctor1', 'bad')).status, 401);
      assert.equal((await c.login('doctor1', 'bad')).status, 401);
      assert.equal((await c.login('doctor1')).status, 200, 'round ' + round);
    }
  } finally { await close(); }
});

test('login: per-IP limit across different usernames (password spraying) gets 429 and is audited', async () => {
  const { pool, base, close } = await setup({ limits: { loginIp: { max: 2 }, loginUser: { max: 100 } } });
  try {
    assert.equal((await client(base).login('a1', 'bad')).status, 401);
    assert.equal((await client(base).login('b1', 'bad')).status, 401);
    assert.equal((await client(base).login('doctor1')).status, 429, 'blocked even with a valid account');
    const rows = await rateRows(pool);
    assert.equal(rows.length, 1); assert.equal(rows[0].detail.scope, 'login_ip');
  } finally { await close(); }
});

test('writes: the Nth write in a window gets 429 per SESSION; reads and other sessions are unaffected; audited from the session', async () => {
  const { pool, base, close } = await setup({ limits: { write: { max: 3 } } });
  try {
    const doc = client(base), nurse = client(base);
    await doc.login('doctor1'); await nurse.login('nurse1');
    for (let i = 0; i < 3; i++) assert.equal((await doc.post('/api/patients', {})).status, 400, 'write ' + (i + 1));   // invalid body still counts as a write
    const r = await doc.raw('POST', '/api/patients', {});
    assert.equal(r.status, 429); assert.equal(r.body.error, 'rate_limited');
    assert.equal((await doc.post('/api/patients', {})).status, 429);
    assert.equal((await doc.get('/api/me')).status, 200, 'reads are not limited');
    assert.equal((await nurse.post('/api/patients', {})).status, 400, 'another session has its own window');
    const rows = await rateRows(pool);
    assert.equal(rows.length, 1, 'audited once for the window');
    assert.equal(rows[0].username, 'doctor1', 'actor comes from the session');
    assert.equal(rows[0].detail.scope, 'write'); assert.equal(rows[0].detail.path, '/api/patients');
  } finally { await close(); }
});

test('writes without a session are not counted by the write limiter (they get the normal 401)', async () => {
  const { base, close } = await setup({ limits: { write: { max: 1 } } });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await client(base).post('/api/patients', {})).status, 401);
  } finally { await close(); }
});

test('client IP: X-Forwarded-For is ignored by default, and honoured only with trustProxy (hop count)', async () => {
  const attempt = (base, ip) => raw(base, 'POST', '/api/login', { username: 'u' + Math.random(), password: 'bad' }, { 'x-forwarded-for': ip }).then(r => r.status);
  let t = await setup({ limits: { loginIp: { max: 2 } } });
  try {
    assert.equal(await attempt(t.base, '1.1.1.1'), 401); assert.equal(await attempt(t.base, '2.2.2.2'), 401);
    assert.equal(await attempt(t.base, '3.3.3.3'), 429, 'a spoofed header does not dodge the limit');
  } finally { await t.close(); }
  t = await setup({ limits: { loginIp: { max: 2 } }, trustProxy: 1 });
  try {
    assert.equal(await attempt(t.base, '1.1.1.1'), 401); assert.equal(await attempt(t.base, '1.1.1.1'), 401);
    assert.equal(await attempt(t.base, '1.1.1.1'), 429);
    assert.equal(await attempt(t.base, '2.2.2.2'), 401, 'a different client behind the proxy has its own count');
  } finally { await t.close(); }
});

test('limiter unit: window expiry, one "first" refusal, bounded memory', () => {
  let t = 1000;
  const L = createLimiter({ max: 2, windowMs: 1000, maxKeys: 3, now: () => t });
  assert.ok(L.hit('a').ok); assert.ok(L.hit('a').ok);
  const r1 = L.hit('a'), r2 = L.hit('a');
  assert.deepEqual([r1.ok, r1.first, r2.first], [false, true, false]);
  assert.ok(r1.retryAfter >= 1 && r1.retryAfter <= 1);
  t += 1001;
  assert.ok(L.hit('a').ok, 'a new window starts');
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) L.hit(k);
  assert.ok(L.size() <= 3, 'key count stays bounded: ' + L.size());
});
