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
      const lists = { '/session': { id: 'u1', name: 'Dev', role: 'admin' }, '/csrf': { token: 'tok1' }, '/me': { id: 'u1', name: 'Dev', role: 'admin', mode: 'dev' }, '/cases': [], '/element-sets': [], '/usage': {}, '/codes': [], '/bindings': [], '/rules': {}, '/protocols': {}, '/prefs': {} };
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
  assert.deepEqual(t.calls.map((c) => c.path).sort(), ['/bindings', '/cases', '/codes', '/element-sets', '/me', '/prefs', '/protocols', '/rules', '/session', '/usage']);
});

test('init fails (never half-loaded) when /api/me is missing; 401 on the session check calls onUnauthorized', async () => {
  const t = boot(async (m, p) => (p === '/me' ? [404, { error: { code: 'not_found', message: 'Unknown API route' } }] : happy()(m, p)));
  await assert.rejects(t.Store.init(), (e) => e.status === 404);
  assert.equal(t.Store.ready, false);
  const u = boot(async (m, p) => (p === '/session' ? [401, { error: { code: 'unauthorized', message: 'Login required' } }] : happy()(m, p)));
  let hit = 0; u.Store.hooks.onUnauthorized = () => { hit++; };
  await assert.rejects(u.Store.init(), (e) => e.status === 401); assert.equal(hit, 1); assert.deepEqual(u.calls.map((c) => c.path), ['/session']);   // nothing else is loaded while signed out
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

// ---------------------------------------------------------------- chunk 31c: conflict review and resolve
const srv = (id, over = {}) => Object.assign({ id, patient: { name: 'Demo', ageSex: '', bed: '', mrn: '' }, narrative: 'base', applied: [], pathways: [], alertLog: [], pinned: null, values: {}, valueVersions: {}, notes: [], version: 5, updatedAt: '2026-01-01T00:00:00Z' }, over);
const srvRow = (rid, row, v = 1) => Object.assign({}, row, { __id: rid, __v: v, __by: 'u2', __at: '2026-01-01T00:00:00Z', __time: null });
// Creates the case on the "server" (so the snapshot is the base), then makes `route` answer 409 and applies `mineEdit` so a conflict is raised.
async function conflicted(id, initial, route, mineEdit, theirsCase, extra) {
  const t = await readyServerStore(); t.Store.setCases([mkCase(id, initial)]); await t.Store.flush();
  t.custom = async (m, p, b) => {
    if (m === 'GET' && p === '/cases/' + id) return [200, theirsCase];
    if (route(m, p)) return [409, { error: { code: 'conflict', message: 'changed by someone else' }, current: { id, version: 5 } }];
    return extra && extra(m, p, b);
  };
  edit(t.Store, id, mineEdit); await until(() => t.Store.status().state === 'conflict', 'conflict');
  return t;
}
const isCasePatch = (m, p) => m === 'PATCH' && caseRoute.test(p), isRowPatch = (m, p) => m === 'PATCH' && /\/rows\//.test(p);

test('31c: only true conflicts need a choice; my other edits are kept and re-sent after the person resolves', async () => {
  const id = crypto.randomUUID(), rid = crypto.randomUUID();
  const t = await conflicted(id, { narrative: 'base', values: { 'care.vitals/@vit': [{ __id: rid, hr: 70 }] } }, isCasePatch,
    (c) => { c.narrative = 'mine'; c.values['care.vitals/@vit'][0].hr = 75; },
    srv(id, { narrative: 'theirs', values: { 'care.vitals/@vit': [srvRow(rid, { hr: 70 })] } }));
  assert.equal(t.Store.conflictInfo(id).isCase, true);
  const rv = await t.Store.conflictReview(id);
  assert.deepEqual(Array.from(rv.items, (i) => i.key + ':' + i.state).sort(), ['f:narrative:conflict', 'r:' + rid + ':mine']);
  const before = t.writes().length;
  assert.throws(() => t.Store.resolveConflict(id, {}), /Choose mine or theirs/);
  t.Store.resolveConflict(id, { 'f:narrative': 'theirs' }); await t.Store.flush();
  const w = t.writes().slice(before);
  assert.equal(w.length, 1, 'only my row edit is sent'); assert.equal(w[0].method, 'PATCH'); assert.match(w[0].path, /\/rows\//); assert.equal(w[0].body.expectedVersion, 1); assert.equal(w[0].body.row.hr, 75);
  assert.equal(t.Store.getCases()[0].narrative, 'theirs'); assert.equal(t.Store.status().state, 'saved');
});

test('31c: choosing mine sends only that item with the server\'s current version, and the queue works again', async () => {
  const id = crypto.randomUUID();
  const t = await conflicted(id, { narrative: 'base' }, isCasePatch, (c) => { c.narrative = 'mine'; }, srv(id, { narrative: 'theirs' }));
  await t.Store.conflictReview(id); const before = t.writes().length;
  t.custom = undefined; t.Store.resolveConflict(id, { 'f:narrative': 'mine' }); await t.Store.flush();
  const w = t.writes().slice(before); assert.equal(w.length, 1); assert.equal(w[0].body.expectedVersion, 5); assert.deepEqual(Object.keys(w[0].body).sort(), ['expectedVersion', 'narrative']); assert.equal(w[0].body.narrative, 'mine');
  edit(t.Store, id, (c) => { c.narrative = 'later'; }); await t.Store.flush();
  assert.equal(t.writes().pop().body.narrative, 'later'); assert.equal(t.Store.status().state, 'saved');
});

test('31c: the same reading edited by both: mine re-sends against their version, theirs sends nothing', async () => {
  for (const pick of ['mine', 'theirs']) {
    const id = crypto.randomUUID(), rid = crypto.randomUUID();
    const t = await conflicted(id, { values: { 'care.vitals/@vit': [{ __id: rid, hr: 70 }] } }, isRowPatch, (c) => { c.values['care.vitals/@vit'][0].hr = 75; },
      srv(id, { values: { 'care.vitals/@vit': [srvRow(rid, { hr: 80 }, 2)] } }));
    const rv = await t.Store.conflictReview(id); assert.deepEqual(Array.from(rv.items, (i) => i.key + ':' + i.state), ['r:' + rid + ':conflict']);
    const before = t.writes().length; t.custom = undefined; t.Store.resolveConflict(id, { ['r:' + rid]: pick }); await t.Store.flush();
    const w = t.writes().slice(before);
    if (pick === 'mine') { assert.equal(w.length, 1); assert.equal(w[0].body.expectedVersion, 2); assert.equal(w[0].body.row.hr, 75); } else { assert.equal(w.length, 0); assert.equal(t.Store.getCases()[0].values['care.vitals/@vit'][0].hr, 80); }
  }
});

test('31c: a reading someone marked entered in error is not brought back; my edit to it is dropped and nothing is sent', async () => {
  const id = crypto.randomUUID(), rid = crypto.randomUUID();
  const t = await conflicted(id, { values: { 'care.vitals/@vit': [{ __id: rid, hr: 70 }] } }, isRowPatch, (c) => { c.values['care.vitals/@vit'][0].hr = 75; }, srv(id));
  const rv = await t.Store.conflictReview(id); assert.equal(rv.items.length, 1); assert.equal(rv.items[0].state, 'theirs'); assert.match(rv.items[0].why, /entered in error/);
  const before = t.writes().length; t.custom = undefined; t.Store.resolveConflict(id, {}); await t.Store.flush();
  assert.equal(t.writes().length, before); assert.equal((t.Store.getCases()[0].values['care.vitals/@vit'] || []).length, 0);
});

test('31c: a single value conflict uses the value version from the server', async () => {
  const id = crypto.randomUUID(), key = 'care.vitals/__ref';
  const t = await readyServerStore(); t.Store.setCases([mkCase(id)]); await t.Store.flush();
  t.custom = async (m, p) => (m === 'PUT' ? [200, { version: 1 }] : undefined);
  edit(t.Store, id, (c) => { c.values[key] = { hr: { low: 50 } }; }); await t.Store.flush();
  t.custom = async (m, p) => (m === 'GET' && p === '/cases/' + id ? [200, srv(id, { narrative: 'v1', values: { [key]: { hr: { low: 60 } } }, valueVersions: { [key]: 4 } })] : m === 'PUT' && t.hold ? [409, { error: { code: 'conflict', message: 'x' }, current: {} }] : m === 'PUT' ? [200, { version: 5 }] : undefined);
  t.hold = true; edit(t.Store, id, (c) => { c.values[key] = { hr: { low: 55 } }; }); await until(() => t.Store.status().state === 'conflict', 'conflict');
  const rv = await t.Store.conflictReview(id); assert.deepEqual(Array.from(rv.items, (i) => i.key + ':' + i.state), ['v:' + key + ':conflict']);
  t.hold = false; const before = t.writes().length; t.Store.resolveConflict(id, { ['v:' + key]: 'mine' }); await t.Store.flush();
  const w = t.writes().slice(before); assert.equal(w.length, 1); assert.equal(w[0].method, 'PUT'); assert.equal(w[0].body.expectedVersion, 4); assert.deepEqual(w[0].body.value, { hr: { low: 55 } });
});

test('31c: a draft note edited by me while someone signed it keeps their signed version', async () => {
  const id = crypto.randomUUID(), nid = crypto.randomUUID();
  const t = await readyServerStore(); t.custom = async (m, p) => (m === 'POST' && /\/notes$/.test(p) ? [201, { version: 1 }] : undefined);
  t.Store.setCases([mkCase(id, { notes: [{ id: nid, type: 'narrative', text: 'draft', status: 'draft' }] })]); await t.Store.flush();
  t.custom = async (m, p) => (m === 'GET' && p === '/cases/' + id ? [200, srv(id, { notes: [{ id: nid, type: 'narrative', text: 'signed text', status: 'signed', version: 3, signedAt: '2026-01-02T00:00:00Z' }] })] : m === 'PATCH' && /\/notes\//.test(p) ? [409, { error: { code: 'signed', message: 'read-only' } }] : undefined);
  edit(t.Store, id, (c) => { c.notes[0].text = 'my edit'; }); await until(() => t.Store.status().state === 'conflict', 'conflict');
  const rv = await t.Store.conflictReview(id); assert.equal(rv.items.length, 1); assert.equal(rv.items[0].state, 'theirs'); assert.match(rv.items[0].why, /signed/);
  const before = t.writes().length; t.Store.resolveConflict(id, {}); await t.Store.flush();
  assert.equal(t.writes().length, before); assert.equal(t.Store.getCases()[0].notes[0].text, 'signed text'); assert.equal(t.Store.getCases()[0].notes[0].status, 'signed');
});

test('31c: reference-data conflicts are not patient conflicts and cannot be reviewed as one', async () => {
  const t = await readyServerStore();
  t.custom = async (m, p) => (m === 'POST' && p === '/element-sets' ? [409, { error: { code: 'conflict', message: 'newer version' }, current: {} }] : undefined);
  t.Store.saveSet({ setId: 'x.y', kind: 'custom', version: 1, title: 'T' }); await until(() => t.Store.status().state === 'conflict', 'conflict');
  assert.equal(t.Store.conflictInfo('x.y').isCase, false); await assert.rejects(t.Store.conflictReview('x.y'), /no patient conflict/);
  assert.equal(t.Store.conflictInfo('nope'), null);
});

// ---------------------------------------------------------------- chunk 32d1: session, CSRF, 401
// The boot() helper records only method/path/body, so these tests read headers through a second recorder.
// A direct harness that exposes the request headers as well.
function bootWithHeaders(handler, { mode = 'server' } = {}) {
  const ls = new Map(); if (mode === 'local') ls.set('storeMode', 'local');
  const calls = [];
  const sandbox = {
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) },
    crypto: { randomUUID: () => crypto.randomUUID() }, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, opts = {}) => {
      const p = String(url).replace(/^\/api/, ''), body = opts.body ? JSON.parse(opts.body) : undefined, h = opts.headers || {};
      calls.push({ method: opts.method, path: p, body, csrf: h['X-CSRF-Token'] });
      const [status, data] = await handler(opts.method, p, body, h);
      return { ok: status >= 200 && status < 300, status, json: async () => data };
    },
  };
  sandbox.window = sandbox; vm.createContext(sandbox); vm.runInContext(SRC, sandbox);
  return { Store: sandbox.Store, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}
const OK = happy();

test('32d1: the CSRF token is fetched once and sent on writes only, never on GET, login or logout', async () => {
  const t = bootWithHeaders(async (m, p, b) => OK(m, p, b));
  await t.Store.init(); const id = crypto.randomUUID();
  t.Store.setCases([mkCase(id)]); await t.Store.flush();
  edit(t.Store, id, (c) => { c.narrative = 'v2'; }); await t.Store.flush();
  const w = t.writes(); assert.ok(w.length >= 2);
  assert.ok(w.every((c) => c.csrf === 'tok1'), 'every write carries the token');
  assert.ok(t.calls.filter((c) => c.method === 'GET').every((c) => c.csrf === undefined), 'GET never carries it');
  assert.equal(t.calls.filter((c) => c.path === '/csrf').length, 1, 'fetched once per session');
  await t.Store.login('a', 'b').catch(() => {});
  const lg = t.calls.filter((c) => c.path === '/login')[0]; assert.equal(lg.csrf, undefined);
  await t.Store.logout(true);
  assert.equal(t.calls.filter((c) => c.path === '/logout')[0].csrf, undefined);
});

test('32d1: a 403 csrf fetches a fresh token and retries that request once; a second csrf failure is reported, not looped', async () => {
  let n = 0, tokens = ['old', 'new'];
  const t = bootWithHeaders(async (m, p, b, h) => {
    if (p === '/csrf') return [200, { token: tokens.shift() || 'new' }];
    if (m === 'PATCH' && /^\/cases\/[^/]+$/.test(p)) { n++; return h['X-CSRF-Token'] === 'new' ? [200, { version: 2 }] : [403, { error: { code: 'csrf', message: 'Missing or wrong CSRF token.' } }]; }
    return OK(m, p, b);
  });
  await t.Store.init(); const id = crypto.randomUUID(); t.Store.setCases([mkCase(id)]); await t.Store.flush();
  edit(t.Store, id, (c) => { c.narrative = 'v2'; }); await t.Store.flush();
  assert.equal(n, 2, 'sent twice: the stale token, then the fresh one'); assert.equal(t.Store.status().state, 'saved');
  // a server that always says csrf: one retry only, then NOT SAVED with the reason
  let m2 = 0;
  const u = bootWithHeaders(async (m, p, b) => { if (p === '/csrf') return [200, { token: 'x' }]; if (m === 'PATCH') { m2++; return [403, { error: { code: 'csrf', message: 'Missing or wrong CSRF token.' } }]; } return OK(m, p, b); });
  await u.Store.init(); const id2 = crypto.randomUUID(); u.Store.setCases([mkCase(id2)]); await u.Store.flush();
  edit(u.Store, id2, (c) => { c.narrative = 'v2'; }); await u.Store.flush();
  assert.equal(m2, 2); assert.match(u.Store.status().text, /^NOT SAVED/);
});

test('32d1: a 401 during use shows the login hook, keeps the unsent queue, and login resumes it', async () => {
  let signedIn = true, hits = 0;
  const t = bootWithHeaders(async (m, p, b) => {
    if (!signedIn && p !== '/login') return [401, { error: { code: 'session_expired', message: 'Your session ended. Please log in again.' } }];
    if (p === '/login') { signedIn = true; return [200, { id: 'u1', name: 'Dev', role: 'admin', mustChangePassword: false }]; }
    return OK(m, p, b);
  });
  t.Store.hooks.onUnauthorized = () => { hits++; };
  await t.Store.init(); const id = crypto.randomUUID(); t.Store.setCases([mkCase(id)]); await t.Store.flush();
  signedIn = false;
  edit(t.Store, id, (c) => { c.narrative = 'typed while signed out'; });
  await until(() => t.Store.status().state === 'login', 'login state');
  assert.ok(hits >= 1); assert.match(t.Store.status().text, /^NOT SAVED: sign in/); assert.equal(t.Store.pending() > 0, true, 'the change is still queued');
  edit(t.Store, id, (c) => { c.narrative = 'typed more'; }); await tick();       // more edits while signed out stay queued, nothing is sent
  const before = t.writes().length;
  await t.Store.login('dev', 'a long password'); assert.equal(t.Store.needsLogin(), false);
  t.Store.resume(); await t.Store.flush();
  const w = t.writes().slice(before).filter((c) => c.method === 'PATCH');
  assert.equal(w.length, 1, 'one coalesced PATCH after login'); assert.equal(w[0].body.narrative, 'typed more');
  assert.equal(t.Store.status().state, 'saved');
});

test('32d1: unsent changes are never sent as a different user', async () => {
  let signedIn = true, who = { id: 'u1', name: 'Dr One', role: 'doctor' };
  const t = bootWithHeaders(async (m, p, b) => {
    if (!signedIn && p !== '/login') return [401, { error: { code: 'session_expired', message: 'x' } }];
    if (p === '/login') { signedIn = true; return [200, who]; }
    if (p === '/session' || p === '/me') return [200, { id: 'u1', name: 'Dr One', role: 'doctor' }];
    return OK(m, p, b);
  });
  await t.Store.init(); const id = crypto.randomUUID(); t.Store.setCases([mkCase(id)]); await t.Store.flush();
  signedIn = false; edit(t.Store, id, (c) => { c.narrative = 'Dr One note'; }); await until(() => t.Store.status().state === 'login', 'login');
  who = { id: 'u2', name: 'Nurse Two', role: 'nurse' }; const mark = t.calls.length;
  await assert.rejects(t.Store.login('n2', 'pw'), (e) => e.code === 'other_user' && /Dr One/.test(e.message));
  assert.ok(t.calls.some((c) => c.path === '/logout'), 'the wrong session is ended again');
  assert.equal(t.Store.pending() > 0, true); t.Store.resume(); await tick(); // even a mistaken resume must not send under the wrong session
  assert.equal(t.calls.slice(mark).filter((c) => c.method === 'PATCH').length, 0, 'nothing sent after the wrong-user login');
});

test('32d1: a wrong password does not trigger the login hook again and keeps the error for the screen', async () => {
  let hits = 0;
  const t = bootWithHeaders(async (m, p, b) => (p === '/login' ? [401, { error: { code: 'invalid_credentials', message: 'Invalid username or password' } }] : OK(m, p, b)));
  t.Store.hooks.onUnauthorized = () => { hits++; };
  await assert.rejects(t.Store.login('x', 'y'), (e) => e.status === 401 && e.code === 'invalid_credentials');
  assert.equal(hits, 0);
  const l = bootWithHeaders(async (m, p) => (p === '/login' ? [429, { error: { code: 'account_locked', message: 'This account is locked' } }] : OK(m, p)));
  await assert.rejects(l.Store.login('x', 'y'), (e) => e.status === 429 && e.code === 'account_locked');
});

test('32d1: logout clears every cached record; it refuses while changes are unsent unless forced', async () => {
  const t = bootWithHeaders(async (m, p, b) => (m === 'PATCH' ? new Promise(() => {}) : OK(m, p, b)));   // PATCH never answers: the change stays unsent
  await t.Store.init(); const id = crypto.randomUUID(); t.Store.setCases([mkCase(id)]); await t.Store.flush();
  edit(t.Store, id, (c) => { c.narrative = 'unsent'; }); await tick();
  await assert.rejects(t.Store.logout(), (e) => e.code === 'unsent');
  assert.equal(t.calls.filter((c) => c.path === '/logout').length, 0);
  await t.Store.logout(true);
  assert.equal(t.Store.getCases().length, 0); assert.equal(t.Store.me, null); assert.equal(t.Store.ready, false); assert.equal(t.Store.pending(), 0);
});

test('32d1: Demo mode never calls /session, /csrf or /login', async () => {
  const t = bootWithHeaders(async (m, p, b) => OK(m, p, b), { mode: 'local' });
  await t.Store.init(); t.Store.setCases([mkCase(crypto.randomUUID())]); await tick();
  assert.equal(t.calls.length, 0); assert.equal(t.Store.needsLogin(), false);
});
