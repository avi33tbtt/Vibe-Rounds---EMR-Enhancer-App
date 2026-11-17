'use strict';
// node --test store.test.js   (no browser, no database)
// Runs the real store.js in a vm sandbox with a fake window, localStorage and fetch, against a small scripted "server".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');
const caseRoute = /^\/cases\/[^/]+$/;

// A server that accepts everything. Tests wrap it to inject conflicts, outages and errors.
function happy() {
  let caseVer = 1;
  return async (m, p, b) => {
    if (m === 'GET') {
      const lists = { '/me': { id: 'u1', name: 'Dev', role: 'admin', mode: 'dev' }, '/cases': [], '/element-sets': [], '/usage': {}, '/codes': [], '/bindings': [], '/rules': {}, '/protocols': {}, '/prefs': {} };
      if (p in lists) return [200, lists[p]];
      return [404, { error: { code: 'not_found', message: 'Not found' } }];
    }
    if (m === 'POST' && p === '/cases') { caseVer = 1; return [201, { version: 1 }]; }
    if (m === 'PATCH' && caseRoute.test(p)) return [200, { version: ++caseVer }];
    if (m === 'POST' && /\/rows$/.test(p)) return [201, { version: 1, row: b.row, rowTime: b.rowTime }];
    if (m === 'PATCH' && /\/rows\//.test(p)) return [200, { version: 2 }];
    return [200, {}];
  };
}

function boot(handler, { mode = 'server' } = {}) {
  const ls = new Map(); if (mode === 'local') ls.set('storeMode', 'local');
  const calls = [];
  const sandbox = {
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) },
    crypto: { randomUUID: () => crypto.randomUUID() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, opts = {}) => {
      const p = String(url).replace(/^\/api/, ''), body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ method: opts.method, path: p, body });
      const [status, data] = await handler(opts.method, p, body);   // a throw here is a network failure
      return { ok: status >= 200 && status < 300, status, json: async () => data };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox); vm.runInContext(SRC, sandbox);
  return { Store: sandbox.Store, calls, ls, writes: () => calls.filter((c) => c.method !== 'GET') };
}
const mkCase = (id, extra = {}) => Object.assign({ id, patient: { name: 'Demo', ageSex: '', bed: '', mrn: '' }, narrative: 'v1', applied: [], pathways: [], alertLog: [], values: {}, notes: [] }, extra);
const edit = (Store, id, fn) => { const cs = Store.getCases(); fn(cs.find((c) => c.id === id)); Store.setCases(cs); };
const until = async (fn, what) => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail('timed out waiting for ' + what); };
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function readyServerStore(handler = happy()) {
  const t = boot(async (m, p, b) => (t.custom && (await t.custom(m, p, b))) || handler(m, p, b));
  await t.Store.init(); return t;
}

test('init (server mode) loads /api/me and the reference data, then is ready', async () => {
  const t = await readyServerStore();
  assert.equal(t.Store.ready, true); assert.equal(t.Store.me.name, 'Dev');
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['/bindings', '/cases', '/codes', '/element-sets', '/me', '/prefs', '/protocols', '/rules', '/usage']);
});

test('init fails (never half-loaded) when /api/me is missing; 401 calls onUnauthorized', async () => {
  const t = boot(async (m, p) => (p === '/me' ? [404, { error: { code: 'not_found', message: 'Unknown API route' } }] : happy()(m, p)));
  await assert.rejects(t.Store.init(), (e) => e.status === 404);
  assert.equal(t.Store.ready, false);
  const u = boot(async (m, p) => (p === '/me' ? [401, { error: { code: 'unauthorized', message: 'Login required' } }] : happy()(m, p)));
  let hit = 0; u.Store.hooks.onUnauthorized = () => { hit++; };
  await assert.rejects(u.Store.init(), (e) => e.status === 401); assert.equal(hit, 1);
});

test('writes are queued in order: case first, then its rows, with expectedVersion on every patch', async () => {
  const { Store, writes } = await readyServerStore(); const id = crypto.randomUUID();
  Store.setCases([mkCase(id, { values: { 'care.vitals/@vit': [{ hr: 70 }] } })]);
  await Store.flush();
  let w = writes();
  assert.deepEqual(w.map((c) => c.method + ' ' + c.path.replace(id, ':id')), ['POST /cases', 'POST /cases/:id/rows']);
  assert.equal(w[1].body.setId, 'care.vitals'); assert.equal(w[1].body.groupId, 'vit'); assert.deepEqual(w[1].body.row, { hr: 70 });
  const rid = w[1].body.id;
  edit(Store, id, (c) => { c.values['care.vitals/@vit'][0].hr = 75; c.values['care.vitals/@vit'].push({ hr: 90 }); c.narrative = 'v2'; });
  await Store.flush();
  w = writes().slice(2);
  assert.deepEqual(w.map((c) => c.method + ' ' + c.path.replace(id, ':id').replace(rid, ':rid')), ['PATCH /cases/:id', 'PATCH /cases/:id/rows/:rid', 'POST /cases/:id/rows']);
  assert.equal(w[0].body.expectedVersion, 1); assert.equal(w[0].body.narrative, 'v2');
  assert.equal(w[1].body.expectedVersion, 1); assert.deepEqual(w[1].body.row, { hr: 75 });
  assert.equal(Store.status().state, 'saved');
});

test('repeated edits coalesce: only the latest data is sent', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const t = await readyServerStore(); const id = crypto.randomUUID();
  t.custom = async (m, p) => { if (m === 'POST' && p === '/cases') await gate; };   // hold the first send open
  t.Store.setCases([mkCase(id, { narrative: 'v1' })]);
  for (const n of ['v2', 'v3', 'v4']) edit(t.Store, id, (c) => { c.narrative = n; });
  assert.equal(t.Store.status().state, 'saving');
  release(); await t.Store.flush();
  const w = t.writes();
  assert.equal(w.length, 2, 'one create and one patch, not four sends');
  assert.equal(w[0].body.narrative, 'v1'); assert.equal(w[1].method, 'PATCH'); assert.equal(w[1].body.narrative, 'v4');
});

test('409: onConflict is called, that case stops sending, Reload theirs clears it', async () => {
  const t = await readyServerStore(); const id = crypto.randomUUID(); const seen = [];
  t.Store.hooks.onConflict = (key, current) => seen.push([key, current]);
  t.Store.setCases([mkCase(id)]); await t.Store.flush();
  t.custom = async (m, p) => (m === 'PATCH' && caseRoute.test(p) ? [409, { error: { code: 'conflict', message: 'Case was changed by someone else' }, current: { id, version: 9 } }] : undefined);
  edit(t.Store, id, (c) => { c.narrative = 'mine'; });
  await until(() => t.Store.status().state === 'conflict', 'conflict');
  assert.equal(seen.length, 1); assert.equal(seen[0][0], 'case:' + id); assert.equal(seen[0][1].version, 9);
  assert.match(t.Store.status().text, /^NOT SAVED/);
  const before = t.writes().length;
  edit(t.Store, id, (c) => { c.narrative = 'mine again'; }); await tick();
  assert.equal(t.writes().length, before, 'nothing is sent for a case in conflict');

  let reloaded = 0; t.Store.hooks.onCaseReloaded = () => { reloaded++; };
  t.custom = async (m, p) => (m === 'GET' && p === '/cases/' + id ? [200, { id, patient: { name: 'Demo', ageSex: '', bed: '', mrn: '' }, narrative: 'theirs', applied: [], pathways: [], alertLog: [], values: {}, notes: [], version: 9, updatedAt: '2026-01-01T00:00:00Z' }] : undefined);
  await t.Store.reloadCase(id);
  assert.equal(reloaded, 1); assert.equal(t.Store.getCases()[0].narrative, 'theirs'); assert.equal(t.Store.status().state, 'saved');
  edit(t.Store, id, (c) => { c.narrative = 'after reload'; }); await t.Store.flush();
  const last = t.writes().pop(); assert.equal(last.method, 'PATCH'); assert.equal(last.body.expectedVersion, 9); assert.equal(last.body.narrative, 'after reload');
});

test('network failure: NOT SAVED, keeps the change, Retry sends the latest data', async () => {
  const t = await readyServerStore(); const id = crypto.randomUUID();
  t.Store.setCases([mkCase(id)]); await t.Store.flush();
  let down = true;
  t.custom = async (m, p) => { if (down && m === 'PATCH') throw new Error('offline'); };
  edit(t.Store, id, (c) => { c.narrative = 'n1'; });
  await until(() => t.Store.status().state === 'retry', 'retry state');
  assert.equal(t.Store.status().text, 'NOT SAVED: will retry'); assert.ok(t.Store.pending() > 0);
  edit(t.Store, id, (c) => { c.narrative = 'n2'; });               // typed while offline
  down = false; t.Store.retry(); await t.Store.flush();
  const last = t.writes().pop();
  assert.equal(last.method, 'PATCH'); assert.equal(last.body.narrative, 'n2');
  assert.equal(t.Store.status().state, 'saved'); assert.equal(t.Store.pending(), 0);
});

test('a 400 is not retried: it shows NOT SAVED with the reason', async () => {
  const t = await readyServerStore(); const id = crypto.randomUUID();
  t.Store.setCases([mkCase(id)]); await t.Store.flush();
  t.custom = async (m, p) => (m === 'PATCH' ? [400, { error: { code: 'validation', message: 'bad narrative' } }] : undefined);
  edit(t.Store, id, (c) => { c.narrative = 'x'; }); await t.Store.flush();
  const n = t.writes().length; await tick();
  assert.equal(t.writes().length, n); assert.equal(t.Store.status().text, 'NOT SAVED: bad narrative');
});

test('Demo mode never calls fetch and keeps data in localStorage', async () => {
  const { Store, calls, ls } = boot(async () => { throw new Error('fetch must not be called in Demo mode'); }, { mode: 'local' });
  await Store.init();
  assert.equal(Store.mode, 'local'); assert.equal(Store.me.id, 'demo');
  const id = crypto.randomUUID();
  Store.setCases([mkCase(id, { values: { 'care.vitals/@vit': [{ hr: 70 }] } })]);
  Store.saveCodes({ 'snomed|1': 'x' }); Store.saveBinds({ 's|f': { system: 'loinc', code: '2', display: 'z' } }); Store.saveRules({ s: [{ ruleId: 'r1' }] });
  Store.saveSet({ setId: 's1', kind: 'custom' }); Store.saveProtocol('p1', {}); Store.setPref('pinned', ['a']); Store.bumpUsage('care.vitals', ['1']); Store.resetUsage();
  await Store.flush();
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(ls.get('cases'))[0].id, id); assert.equal(JSON.parse(ls.get('codes'))['snomed|1'], 'x'); assert.deepEqual(JSON.parse(ls.get('pinned')), ['a']);
  assert.match(Store.status().text, /^Demo mode/);
});

test('codes: a new code is POSTed once; a duplicate (409) keeps the server entry and tells the person', async () => {
  const t = await readyServerStore(); const toasts = []; t.Store.hooks.toast = (m) => toasts.push(m);
  t.Store.saveCodes({ 'snomed|386661006': 'Fever' }); await t.Store.flush();
  const w = t.writes(); assert.equal(w.length, 1); assert.equal(w[0].method, 'POST'); assert.equal(w[0].path, '/codes');
  assert.deepEqual(w[0].body, { system: 'snomed', code: '386661006', display: 'Fever' });
  t.Store.saveCodes({ 'snomed|386661006': 'Fever' }); await t.Store.flush();
  assert.equal(t.writes().length, 1, 'already confirmed: not sent again');

  t.custom = async (m, p) => (m === 'POST' && p === '/codes' ? [409, { error: { code: 'conflict', message: 'dup' }, current: { system: 'loinc', code: '8310-5', display: 'Body temperature', addedBy: 'u9', addedAt: '2026-11-01T00:00:00Z', verifiedLive: null } }] : undefined);
  t.Store.saveCodes({ 'snomed|386661006': 'Fever', 'loinc|8310-5': 'My own wording' }); await t.Store.flush();
  assert.equal(t.Store.codes()['loinc|8310-5'], 'Body temperature');
  assert.equal(t.Store.codeMeta()['loinc|8310-5'].addedBy, 'u9');
  assert.equal(t.Store.status().state, 'saved', 'a duplicate is not a save failure or a conflict screen');
  assert.ok(toasts.some((m) => /already in the verified table/.test(m)));
});

test('codes: live result goes to the server route; Demo mode keeps it in the browser', async () => {
  const t = await readyServerStore();
  t.Store.saveCodes({ 'snomed|386661006': 'Fever' }); await t.Store.flush();
  t.custom = async (m, p) => (m === 'POST' && /\/live$/.test(p) ? [200, { system: 'snomed', code: '386661006', display: 'Fever', addedBy: 'u1', addedAt: '2026-11-18T00:00:00Z', verifiedLive: { ok: true, checkedAt: '2026-11-18T01:00:00Z', checkedBy: 'u1' } }] : undefined);
  t.Store.saveLiveResult('snomed', '386661006', true, 'Fever (finding)'); await t.Store.flush();
  const w = t.writes().pop(); assert.equal(w.path, '/codes/snomed/386661006/live'); assert.deepEqual(w.body, { ok: true, display: 'Fever (finding)' });
  assert.equal(t.Store.codeMeta()['snomed|386661006'].verifiedLive.checkedBy, 'u1');
  const d = boot(happy(), { mode: 'local' }); await d.Store.init();
  d.Store.saveLiveResult('loinc', '8310-5', true); assert.equal(d.writes().length, 0);
  assert.equal(JSON.parse(d.ls.get('codeMeta'))['loinc|8310-5'].verifiedLive.ok, true);
});

test('set versions: saving a new version keeps the old one; a case can resolve it (Demo mode)', async () => {
  const { Store, ls } = boot(async () => { throw new Error('no fetch in Demo mode'); }, { mode: 'local' });
  await Store.init();
  Store.saveSet({ setId: 'pathway.user.p', kind: 'pathway', version: 1, title: 'P', members: [{ setId: 'a' }] });
  Store.saveSet({ setId: 'pathway.user.p', kind: 'pathway', version: 2, title: 'P', members: [{ setId: 'b' }] });
  assert.equal(Store.userSets().length, 1); assert.equal(Store.userSets()[0].version, 2);
  assert.equal(Store.setVersion('pathway.user.p', 1).members[0].setId, 'a');
  assert.equal(Store.setVersion('pathway.user.p', 2).members[0].setId, 'b');
  assert.equal(Store.setVersion('pathway.user.p', 3), null, 'unknown version: caller falls back to latest');
  assert.equal(Store.setVersion('bad id!', 1), null);
  assert.ok(JSON.parse(ls.get('setHist'))['pathway.user.p@1'], 'history survives a reload in Demo mode');
});

test('set versions (server): a missing old version is fetched once, then served from memory', async () => {
  const t = await readyServerStore(); const got = [];
  t.Store.hooks.onSetVersion = (id, n, ok) => got.push([id, n, ok]);
  t.custom = async (m, p) => (m === 'GET' && p === '/element-sets/user.s/versions/1' ? [200, { setId: 'user.s', version: 1, body: { title: 'Old', sections: [] } }] : null);
  assert.equal(t.Store.setVersion('user.s', 1), null, 'first read is a miss and starts one fetch');
  assert.equal(t.Store.setVersion('user.s', 1), null, 'no second fetch while loading');
  await until(() => got.length === 1, 'version fetch');
  assert.deepEqual(got[0], ['user.s', 1, true]);
  assert.equal(t.Store.setVersion('user.s', 1).title, 'Old'); assert.equal(t.Store.setVersion('user.s', 1).version, 1);
  assert.equal(t.calls.filter((c) => /versions\/1$/.test(c.path)).length, 1);
  assert.equal(t.writes().length, 0, 'reading old versions never writes');
});

test('set versions (server): a failed fetch reports failure and the app falls back to the latest', async () => {
  const t = await readyServerStore(); const got = [];
  t.Store.hooks.onSetVersion = (id, n, ok) => got.push(ok);
  t.custom = async (m, p) => (/versions\/4$/.test(p) ? [404, { error: { code: 'not_found', message: 'Set version not found' } }] : null);
  assert.equal(t.Store.setVersion('user.s', 4), null);
  await until(() => got.length === 1, 'failure report'); assert.deepEqual(got, [false]);
  assert.equal(t.Store.setVersion('user.s', 4), null);
});

test('set versions (server): saving a user set sends expectedVersion and remembers the replaced version', async () => {
  const t = await readyServerStore();
  t.custom = async (m, p, b) => (m === 'POST' && p === '/element-sets' ? [201, { setId: b.setId, version: b.expectedVersion ? b.expectedVersion + 1 : 1, body: b.body }] : null);
  t.Store.saveSet({ setId: 'user.s', kind: 'custom', version: 1, title: 'One' }); await t.Store.flush();
  t.Store.saveSet({ setId: 'user.s', kind: 'custom', version: 2, title: 'Two' }); await t.Store.flush();
  const w = t.writes().filter((c) => c.path === '/element-sets');
  assert.equal(w.length, 2); assert.equal(w[0].body.expectedVersion, undefined); assert.equal(w[1].body.expectedVersion, 1);
  assert.equal(t.Store.setVersion('user.s', 1).title, 'One', 'the replaced version is kept in memory, no fetch needed');
  assert.equal(t.calls.filter((c) => /versions\//.test(c.path)).length, 0);
});

test('protocols: saving PUTs the body; a typed verifier makes the Store ask the server to stamp approval', async () => {
  const t = await readyServerStore();
  t.custom = async (m, p, b) => {
    if (m === 'PUT' && p === '/protocols/care.sss') return [200, { setId: 'care.sss', body: b.body, verifiedBy: null, version: b.expectedVersion + 1 }];
    if (m === 'POST' && p === '/protocols/care.sss/approve') return [200, { setId: 'care.sss', verifiedBy: 'u1', version: b.expectedVersion + 1 }];
    return null;
  };
  t.Store.saveProtocol('care.sss', { verifiedBy: '', bands: [{ min: '', max: '', instruction: 'typed' }] }); await t.Store.flush();
  let w = t.writes(); assert.equal(w.length, 1); assert.equal(w[0].method, 'PUT'); assert.equal(w[0].body.expectedVersion, 0);
  t.Store.saveProtocol('care.sss', { verifiedBy: 'Dr A', bands: [{ min: '', max: '', instruction: 'typed' }] }); await t.Store.flush();
  w = t.writes(); assert.deepEqual(w.map((x) => x.method + ' ' + x.path), ['PUT /protocols/care.sss', 'PUT /protocols/care.sss', 'POST /protocols/care.sss/approve']);
  assert.equal(w[1].body.expectedVersion, 1); assert.equal(w[2].body.expectedVersion, 2);
  t.Store.saveProtocol('care.sss', { verifiedBy: 'Dr A', bands: [{ min: '', max: '', instruction: 'typed' }] }); await t.Store.flush();
  assert.equal(t.writes().length, 3, 'unchanged protocol is not sent again');
  assert.equal(t.Store.status().state, 'saved');
});

test('rules: an imported rule (no verifier) is saved unapproved; an approved rule is approved once; a disabled rule is disabled on the server', async () => {
  const t = await readyServerStore();
  t.custom = async (m, p, b) => {
    if (m === 'PUT' && /^\/rules\//.test(p)) return [200, { version: b.expectedVersion + 1, enabled: false }];
    if (m === 'POST' && /\/approve$/.test(p)) return [200, { version: b.expectedVersion + 1, enabled: true }];
    if (m === 'POST' && /\/disable$/.test(p)) return [200, { version: b.expectedVersion + 1, enabled: false }];
    return null;
  };
  const rule = (id, by, en) => ({ ruleId: id, fieldRef: 'care.vitals/temp', op: '>=', threshold: 1, indicator: 'info', summary: 's', enabled: en, provenance: { source: 'manual', verifiedBy: by, verifiedAt: by ? 'now' : '' } });
  t.Store.saveRules({ 'care.vitals': [rule('imp', '', true), rule('ok', 'Dr A', true)] }); await t.Store.flush();
  const w = t.writes().map((x) => x.method + ' ' + x.path);
  assert.ok(w.includes('PUT /rules/care.vitals/imp')); assert.ok(!w.includes('POST /rules/care.vitals/imp/approve'), 'no verifier typed: never approved');
  assert.ok(w.includes('POST /rules/care.vitals/ok/approve'));
  t.Store.saveRules({ 'care.vitals': [rule('imp', '', true), rule('ok', 'Dr A', false)] }); await t.Store.flush();
  assert.ok(t.writes().map((x) => x.path).includes('/rules/care.vitals/ok/disable'));
  t.Store.saveRules({ 'care.vitals': [rule('imp', '', true)] }); await t.Store.flush();
  assert.ok(t.writes().some((x) => x.method === 'DELETE' && /^\/rules\/care\.vitals\/ok\?expectedVersion=\d+$/.test(x.path)));
});

test('usage: a bump sends the diagnosis keys the server accepts; reset only clears the caller on the server', async () => {
  const t = await readyServerStore();
  t.Store.bumpUsage('care.vitals', ['111', '222']); await t.Store.flush();
  const w = t.writes(); assert.equal(w[0].path, '/usage/care.vitals'); assert.deepEqual(w[0].body, { dxs: ['111', '222'] });
  assert.equal(t.Store.usage()['care.vitals'].count, 1);
  t.Store.resetUsage(); await t.Store.flush();
  assert.equal(t.writes().pop().method, 'DELETE'); assert.equal(Object.keys(t.Store.usage()).length, 0);
});
