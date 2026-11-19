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

test('protocols: saving PUTs the body without a name; a typed verifier makes the Store ask the server to stamp approval (chunk 32d2)', async () => {
  const t = await readyServerStore();
  t.custom = async (m, p, b) => {
    if (m === 'PUT' && p === '/protocols/care.sss') return [200, { setId: 'care.sss', body: b.body, verifiedBy: null, version: b.expectedVersion + 1 }];
    if (m === 'POST' && p === '/protocols/care.sss/approve') return [200, { setId: 'care.sss', verifiedBy: 'u1', version: b.expectedVersion + 1 }];
    return null;
  };
  const bands = [{ min: '', max: '', instruction: 'typed' }];
  t.Store.saveProtocol('care.sss', { verifiedBy: '', bands }); await t.Store.flush();
  let w = t.writes(); assert.equal(w.length, 1); assert.equal(w[0].method, 'PUT'); assert.equal(w[0].body.expectedVersion, 0);
  t.Store.saveProtocol('care.sss', { verifiedBy: 'Dr A', bands }); await t.Store.flush();
  w = t.writes(); assert.deepEqual(w.map((x) => x.method + ' ' + x.path), ['PUT /protocols/care.sss', 'POST /protocols/care.sss/approve'], 'nothing else changed, so only the approve call is sent');
  assert.equal(w[1].body.expectedVersion, 1);
  t.Store.saveProtocol('care.sss', { verifiedBy: 'Dr A', bands }); await t.Store.flush();
  assert.equal(t.writes().length, 2, 'unchanged protocol is not sent again');
  t.Store.saveProtocol('care.sss', { verifiedBy: 'Dr A', bands: [{ min: '', max: '', instruction: 'edited' }] }); await t.Store.flush();
  w = t.writes(); assert.deepEqual(w.slice(2).map((x) => x.method + ' ' + x.path), ['PUT /protocols/care.sss', 'POST /protocols/care.sss/approve'], 'an edit saves (which unverifies) and then asks for approval again');
  t.Store.saveProtocol('care.sss', { verifiedBy: '', bands: [{ min: '', max: '', instruction: 'edited' }] }); await t.Store.flush();
  w = t.writes(); assert.equal(w[w.length - 1].method + ' ' + w[w.length - 1].path, 'PUT /protocols/care.sss', 'clearing the mark saves the body, which resets approval on the server');
  for (const x of w) assert.ok(!JSON.stringify(x.body).match(/verifiedBy|verifiedAt|Dr A/), 'no typed name in any request body');
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

// ---------------------------------------------------------------- chunk 32d2: session user, hiding by role, plain 403
const nurseMe = { id: 'u2', name: 'Nurse Neha', role: 'nurse', mode: 'session', allowed: ['session.read', 'case.read', 'row.add'] };
test('32d2: Store.who and Store.can come from the session (server mode only); Demo mode and an older server never hide anything', async () => {
  const t = await readyServerStore();
  t.custom = async (m, p) => (m === 'GET' && p === '/me' ? [200, nurseMe] : undefined);
  await t.Store.init();
  assert.equal(t.Store.who(), 'Nurse Neha');
  assert.equal(t.Store.can('row.add'), true); assert.equal(t.Store.can('rule.approve'), false); assert.equal(t.Store.can('note.sign'), false);
  const old = await readyServerStore();                                   // happy() /me has no allowed list: nothing is hidden
  assert.equal(old.Store.can('rule.approve'), true);
  const demo = boot(happy(), { mode: 'local' }); await demo.Store.init();
  assert.equal(demo.Store.who(), null, 'Demo mode keeps typed names'); assert.equal(demo.Store.can('rule.approve'), true);
});

test('32d2: rule requests carry no typed name (the server stamps the approver); a loaded approved rule shows the approver name', async () => {
  const t = await readyServerStore();
  t.custom = async (m, p, b) => {
    if (m === 'PUT' && /^\/rules\//.test(p)) return [200, { version: b.expectedVersion + 1, enabled: false }];
    if (m === 'POST' && /\/approve$/.test(p)) return [200, { version: b.expectedVersion + 1, enabled: true }];
    return null;
  };
  const rule = { ruleId: 'r1', fieldRef: 'care.vitals/temp', op: '>=', threshold: 1, indicator: 'info', summary: 's', enabled: true, provenance: { source: 'manual', verifiedBy: 'Dev', verifiedAt: '2026-01-01T00:00:00Z' } };
  t.Store.saveRules({ 'care.vitals': [rule] }); await t.Store.flush();
  const w = t.writes(); assert.deepEqual(w.map((x) => x.method + ' ' + x.path), ['PUT /rules/care.vitals/r1', 'POST /rules/care.vitals/r1/approve']);
  assert.ok(!JSON.stringify(w[0].body).match(/verifiedBy|verifiedAt|Dev/), 'no typed name in the body');
  const t2 = await readyServerStore();
  t2.custom = async (m, p) => (m === 'GET' && p === '/rules' ? [200, { 'care.vitals': [{ ruleId: 'r1', ownerSetId: 'care.vitals', enabled: true, verifiedBy: 'u9', verifiedByName: 'Dr Rao', verifiedAt: '2026-02-01T00:00:00Z', version: 3,
    body: { ruleId: 'r1', fieldRef: 'care.vitals/temp', op: '>=', threshold: 1, indicator: 'info', summary: 's', provenance: { source: 'manual' } } }] }] : undefined);
  await t2.Store.init();
  const got = t2.Store.rules()['care.vitals'][0]; assert.equal(got.provenance.verifiedBy, 'Dr Rao'); assert.equal(got.enabled, true);
});

test('32d2: a 403 forbidden shows one plain sentence, is not retried, and the save status names it', async () => {
  const t = await readyServerStore(); const toasts = []; t.Store.hooks.toast = (m) => toasts.push(m);
  const msg = 'Your role (nurse) may not approve alert rules.';
  t.custom = async (m, p) => (m === 'PUT' && /^\/rules\//.test(p) ? [403, { error: { code: 'forbidden', message: msg, action: 'rule.approve' } }] : undefined);
  t.Store.saveRules({ 'care.vitals': [{ ruleId: 'r1', fieldRef: 'care.vitals/temp', op: '>=', threshold: 1, indicator: 'info', summary: 's', enabled: false, provenance: { source: 'manual' } }] }); await t.Store.flush();
  assert.deepEqual(toasts, [msg]); assert.equal(t.writes().length, 1, 'not retried');
  assert.equal(t.Store.status().state, 'failed'); assert.match(t.Store.status().text, /may not approve alert rules/);
});

// ---------------------------------------------------------------- chunk 32e2: forced password change, users calls
test('32e2: a temporary password stops init after /session: nothing else is loaded, Store.mustChange() is true, no data in the cache', async () => {
  const h = happy();
  const t = boot(async (m, p, b) => (m === 'GET' && p === '/session') ? [200, { id: 'u9', name: 'New Nurse', role: 'nurse', mustChangePassword: true }] : h(m, p, b));
  await assert.rejects(t.Store.init(), (e) => e.code === 'must_change' && /temporary password/.test(e.message));
  assert.deepEqual(t.calls.map((c) => c.path), ['/session'], 'only /session was called: no cases, sets, codes or rules were requested');
  assert.equal(t.Store.mustChange(), true); assert.equal(t.Store.ready, false); assert.equal(t.Store.getCases().length, 0);
});

test('32e2: changePassword sends both passwords once with the CSRF token, clears the flag, and keeps no copy; init then loads normally', async () => {
  const h = happy(); let must = true;
  const t = boot(async (m, p, b) => {
    if (m === 'GET' && p === '/session') return [200, { id: 'u9', name: 'N', role: 'nurse', mustChangePassword: must }];
    if (m === 'GET' && p === '/me') return [200, { id: 'u9', name: 'N', role: 'nurse', mustChangePassword: must, allowed: [] }];
    if (m === 'POST' && p === '/password') { must = false; return [204, null]; }
    return h(m, p, b);
  });
  await assert.rejects(t.Store.init(), (e) => e.code === 'must_change');
  await t.Store.changePassword('temp-pass-123456', 'my brand new passphrase');
  const w = t.writes(); assert.equal(w.length, 1); assert.equal(w[0].path, '/password'); assert.deepEqual(w[0].body, { currentPassword: 'temp-pass-123456', newPassword: 'my brand new passphrase' });
  assert.equal(t.Store.mustChange(), false);
  await t.Store.init(); assert.equal(t.Store.ready, true, 'after the change the data loads');
  const dump = JSON.stringify([t.Store._test.S, [...t.ls.entries()]]);
  assert.ok(!dump.includes('temp-pass-123456') && !dump.includes('my brand new passphrase'), 'passwords are not cached or written to localStorage');
});

test('32e2: a wrong current password is a 422 the caller can show; it is not treated as a sign-out', async () => {
  const t = await readyServerStore(); let hook = 0; t.Store.hooks.onUnauthorized = () => { hook++; };
  t.custom = async (m, p) => (m === 'POST' && p === '/password') ? [422, { error: { code: 'wrong_password', message: 'The current password is not correct' } }] : null;
  await assert.rejects(t.Store.changePassword('x', 'y'), (e) => e.status === 422 && e.code === 'wrong_password');
  assert.equal(hook, 0); assert.equal(t.Store.needsLogin(), false);
});

test('32e2: Store.users calls the right routes with the right bodies; a typed password is sent only when given', async () => {
  const t = await readyServerStore(); const U = t.Store.users;
  t.custom = async (m, p) => (p === '/users' && m === 'GET') ? [200, [{ id: 'a' }]] : (p === '/users' && m === 'POST') ? [201, { user: { id: 'n' }, temporaryPassword: 'AbCdEfGhJkLmNpQr' }] : null;
  assert.deepEqual(await U.list(), [{ id: 'a' }]);
  const made = await U.create({ username: 'x', name: 'X', role: 'nurse' }); assert.equal(made.temporaryPassword, 'AbCdEfGhJkLmNpQr');
  await U.deactivate('id 1'); await U.reactivate('id1'); await U.resetPassword('id1'); await U.resetPassword('id1', 'typed password 12'); await U.setRole('id1', 'doctor');
  const w = t.writes().map((c) => c.method + ' ' + c.path + ' ' + JSON.stringify(c.body));
  assert.deepEqual(w.slice(-6), ['POST /users {"username":"x","name":"X","role":"nurse"}', 'POST /users/id%201/deactivate {}', 'POST /users/id1/reactivate {}',
    'POST /users/id1/reset-password {}', 'POST /users/id1/reset-password {"password":"typed password 12"}', 'POST /users/id1/role {"role":"doctor"}']);
  assert.ok(!JSON.stringify(t.Store._test.S).includes('AbCdEfGhJkLmNpQr'), 'a temporary password is not kept by Store');
});

// ---------------------------------------------------------------- chunk 34b1: Store.patients
const PID = '11111111-1111-4111-8111-111111111111', EID = '22222222-2222-4222-8222-222222222222', CID = 'case-34b1';
const err = (status, code, message, extra) => [status, Object.assign({ error: { code, message } }, extra || {})];

test('34b1: search asks the server with an encoded query, clamps limit, and asks nothing under 2 characters', async () => {
  const t = await readyServerStore(); const P = t.Store.patients;
  t.custom = async (m, p) => (m === 'GET' && p.startsWith('/patients?')) ? [200, [{ id: PID, name: 'Asha Rai' }]] : null;
  assert.equal(JSON.stringify(await P.search('  a ')), '[]'); assert.equal(JSON.stringify(await P.search(null)), '[]');   // JSON compare: the [] is made inside the vm sandbox
  assert.equal(t.calls.filter((c) => c.path.startsWith('/patients')).length, 0, 'no request for short text');
  assert.deepEqual(await P.search('Asha & 100%'), [{ id: PID, name: 'Asha Rai' }]);
  await P.search('1234567', 500); await P.search('1234567', 0);
  const paths = t.calls.filter((c) => c.path.startsWith('/patients')).map((c) => c.path);
  assert.deepEqual(paths, ['/patients?q=Asha%20%26%20100%25', '/patients?q=1234567&limit=50', '/patients?q=1234567&limit=1']);
  await assert.rejects(P.search('x'.repeat(101)), (e) => e.code === 'query_too_long');
});

test('34b1: get encodes the id and rejects a bad id before any request', async () => {
  const t = await readyServerStore(); const P = t.Store.patients;
  t.custom = async (m, p) => (m === 'GET' && p === '/patients/' + PID) ? [200, { id: PID, mrn: '12345674' }] : null;
  assert.equal((await P.get(PID)).mrn, '12345674');
  for (const bad of ['', '../cases', 'a/b', null, 5]) await assert.rejects(P.get(bad), (e) => e.code === 'bad_id');
  assert.equal(t.calls.filter((c) => c.path.startsWith('/patients')).length, 1);
});

test('34b1: create sends only known fields; a 409 possible_duplicate carries candidates; confirmDifferent is sent only when exactly true', async () => {
  const t = await readyServerStore(); const P = t.Store.patients; const cands = [{ id: PID, name: 'Asha Rai', matchedOn: ['name_and_birth'] }];
  t.custom = async (m, p, b) => (m === 'POST' && p === '/patients') ? (b.confirmDifferent ? [201, { id: EID, mrn: '7654321', name: b.name }] : err(409, 'possible_duplicate', 'Possible duplicate', { candidates: cands })) : null;
  const body = { name: 'Asha Rai', sex: 'female', ageYears: 30, mrn: 'HACK', id: 'x', confirmDifferent: 'yes' };
  await assert.rejects(P.create(body), (e) => e.status === 409 && e.code === 'possible_duplicate' && e.candidates.length === 1 && e.candidates[0].id === PID);
  let w = t.writes().filter((c) => c.path === '/patients'); assert.deepEqual(w[0].body, { name: 'Asha Rai', sex: 'female', ageYears: 30 }, 'mrn, id and a non-true confirmDifferent are dropped');
  const made = await P.create(Object.assign({}, body, { confirmDifferent: true }));
  assert.equal(made.id, EID); w = t.writes().filter((c) => c.path === '/patients');
  assert.deepEqual(w[1].body, { name: 'Asha Rai', sex: 'female', ageYears: 30, confirmDifferent: true });
});

test('34b1: update needs a version and a reason, keeps null (clear) values, and a stale version is a 409 with current', async () => {
  const t = await readyServerStore(); const P = t.Store.patients;
  t.custom = async (m, p, b) => (m === 'PATCH' && p === '/patients/' + PID) ? (b.expectedVersion === 1 ? [200, { id: PID, version: 2, phone: null }] : err(409, 'conflict', 'Changed by someone else', { current: { id: PID, version: 5 } })) : null;
  await assert.rejects(P.update(PID, { name: 'X' }), (e) => e.code === 'version_required');
  await assert.rejects(P.update(PID, { expectedVersion: 1, name: 'X', reason: '   ' }), (e) => e.code === 'reason_required');
  assert.equal(t.writes().length, 0, 'nothing sent for either');
  const r = await P.update(PID, { expectedVersion: 1, reason: 'Wrong phone', phone: null, bogus: 1 });
  assert.equal(r.version, 2); assert.deepEqual(t.writes()[0].body, { expectedVersion: 1, reason: 'Wrong phone', phone: null });
  await assert.rejects(P.update(PID, { expectedVersion: 9, reason: 'again', name: 'Y' }), (e) => e.status === 409 && e.code === 'conflict' && e.current.version === 5);
});

test('34b1: encounter routes use the right paths and bodies', async () => {
  const t = await readyServerStore(); const P = t.Store.patients;
  t.custom = async (m, p) => (m === 'GET' && p === '/patients/' + PID + '/encounters') ? [200, [{ id: EID }]] : (m !== 'GET' && /^\/(patients|encounters)\//.test(p)) ? [200, { id: EID, version: 2 }] : null;
  assert.deepEqual(await P.encounters(PID), [{ id: EID }]);
  await P.createEncounter(PID, { type: 'admission', ward: 'A', bed: '4', attendingId: PID, extra: 1 });
  await P.updateEncounter(EID, { expectedVersion: 1, bed: null }); await P.closeEncounter(EID, { expectedVersion: 2 }); await P.cancelEncounter(EID, { expectedVersion: 3, reason: 'Opened by mistake' });
  assert.deepEqual(t.writes().map((c) => c.method + ' ' + c.path + ' ' + JSON.stringify(c.body)), [
    'POST /patients/' + PID + '/encounters {"type":"admission","ward":"A","bed":"4","attendingId":"' + PID + '"}',
    'PATCH /encounters/' + EID + ' {"expectedVersion":1,"bed":null}', 'POST /encounters/' + EID + '/close {"expectedVersion":2}',
    'POST /encounters/' + EID + '/cancel {"expectedVersion":3,"reason":"Opened by mistake"}']);
  await assert.rejects(P.cancelEncounter(EID, { expectedVersion: 3 }), (e) => e.code === 'reason_required');
  await assert.rejects(P.closeEncounter(EID, {}), (e) => e.code === 'version_required');
});

test('34b1: link defaults to the confirmed case version, records the new version, and the next save of the chart does not conflict', async () => {
  const h = happy(); let caseVer = 1;
  const t = boot(async (m, p, b) => {
    if (m === 'POST' && p === '/cases') { caseVer = 1; return [201, { version: 1 }]; }
    if (m === 'POST' && p === '/cases/' + CID + '/link') { if (b.expectedVersion !== caseVer) return err(409, 'conflict', 'Changed', { current: {} }); caseVer++; return [200, { id: CID, patientId: b.patientId, encounterId: b.encounterId || null, version: caseVer }]; }
    if (m === 'PATCH' && p === '/cases/' + CID) { if (b.expectedVersion !== caseVer) return err(409, 'conflict', 'Stale version', { current: { id: CID } }); return [200, { version: ++caseVer }]; }
    return h(m, p, b);
  });
  await t.Store.init(); t.Store.setCases([mkCase(CID)]); await t.Store.flush();
  const r = await t.Store.patients.link(CID, { patientId: PID, encounterId: EID });
  assert.equal(r.version, 2); const lw = t.writes().find((c) => c.path.endsWith('/link')); assert.deepEqual(lw.body, { expectedVersion: 1, patientId: PID, encounterId: EID });
  const c = t.Store.getCases()[0]; assert.equal(c.patientId, PID); assert.equal(c.encounterId, EID);
  edit(t.Store, CID, (x) => { x.narrative = 'after link'; }); await t.Store.flush();
  assert.equal(Object.keys(t.Store._test.failed).length + Object.keys(t.Store._test.conflicts).length, 0, 'the save after linking used version 2, so no conflict');
  assert.equal(t.Store.status().state, 'saved');
  assert.equal(t.writes().filter((x) => x.method === 'PATCH' && x.path === '/cases/' + CID).pop().body.expectedVersion, 2);
});

test('34b1: link refuses while the chart is unsaved, has unsent changes or a conflict; an explicit expectedVersion is respected; patient_locked is passed on', async () => {
  const t = await readyServerStore(); const P = t.Store.patients;
  await assert.rejects(P.link('missing-case', { patientId: PID }), (e) => e.code === 'case_not_saved');
  t.Store.setCases([mkCase(CID)]); await t.Store.flush();
  t.custom = async (m, p, b) => (p === '/cases/' + CID + '/link') ? err(409, 'patient_locked', 'This case already belongs to another patient', {}) : (m === 'PATCH' ? [200, { version: 2 }] : null);
  await assert.rejects(P.link(CID, { patientId: PID, expectedVersion: 7 }), (e) => e.status === 409 && e.code === 'patient_locked');
  assert.equal(t.writes().find((c) => c.path.endsWith('/link')).body.expectedVersion, 7);
  let release; const gate = new Promise((r) => { release = r; });
  t.custom = async (m, p) => (m === 'PATCH' && p === '/cases/' + CID) ? (await gate, [200, { version: 2 }]) : null;
  edit(t.Store, CID, (x) => { x.narrative = 'typing'; }); await tick(20);
  await assert.rejects(P.link(CID, { patientId: PID }), (e) => e.code === 'case_unsent'); release(); await t.Store.flush();
  t.custom = async (m, p) => (m === 'PATCH' && p === '/cases/' + CID) ? err(409, 'conflict', 'Changed by someone else', { current: { id: CID, version: 9 } }) : null;
  edit(t.Store, CID, (x) => { x.narrative = 'again'; }); await until(() => t.Store.conflictInfo(CID), 'conflict');
  await assert.rejects(P.link(CID, { patientId: PID }), (e) => e.code === 'case_conflict');
});

test('34b1: Demo mode: every method says it is not available, calls no server and writes no patient data', async () => {
  const t = boot(happy(), { mode: 'local' }); await t.Store.init(); const P = t.Store.patients;
  const all = [() => P.search('Asha'), () => P.get(PID), () => P.create({ name: 'A' }), () => P.update(PID, { expectedVersion: 1, reason: 'r' }), () => P.encounters(PID),
    () => P.createEncounter(PID, {}), () => P.updateEncounter(EID, { expectedVersion: 1 }), () => P.closeEncounter(EID, { expectedVersion: 1 }),
    () => P.cancelEncounter(EID, { expectedVersion: 1, reason: 'r' }), () => P.link(CID, { patientId: PID }), () => P.exportCase(CID)];
  for (const f of all) await assert.rejects(f(), (e) => e.code === 'demo_mode' && /not available in demo mode/.test(e.message));
  assert.equal(t.calls.length, 0); assert.ok(![...t.ls.keys()].some((k) => /patient|encounter/i.test(k)), 'nothing patient-related in localStorage');
});

test('34b1: a server 403 for a role is passed on unchanged and nothing is cached', async () => {
  const t = await readyServerStore();
  t.custom = async (m, p) => p.startsWith('/patients') ? err(403, 'forbidden', 'Your role (informatician) may not open patient records.') : null;
  await assert.rejects(t.Store.patients.search('Asha'), (e) => e.status === 403 && /may not open patient records/.test(e.message));
  assert.equal(t.Store.status().state, 'saved'); assert.equal(Object.keys(t.Store._test.failed).length, 0);
  assert.ok(!JSON.stringify([t.Store._test.S, [...t.ls.entries()]]).includes('Asha'), 'the search text is not stored');
});

// ---------------------------------------------------------------- chunk 34c: real patient and encounter records on a cached case
test('34c: records from the server are cached on the case, are never sent back, and a link keeps only records that match the new ids', async () => {
  const h = happy(); let caseVer = 1;
  const PREC = { id: PID, mrn: '10000008', name: 'Real Name', sex: 'female', dateOfBirth: '1980-05-17', ageEstimated: false };
  const t = boot(async (m, p, b) => {
    if (m === 'POST' && p === '/cases') { caseVer = 1; return [201, { version: 1 }]; }
    if (m === 'POST' && p === '/cases/' + CID + '/link') { caseVer++; return [200, { id: CID, patientId: b.patientId, encounterId: b.encounterId || null, version: caseVer }]; }
    if (m === 'PATCH' && p === '/cases/' + CID) return [200, { version: ++caseVer }];
    return h(m, p, b);
  });
  await t.Store.init(); t.Store.setCases([mkCase(CID)]); await t.Store.flush();
  // from the server's case shape
  const c0 = t.Store._test.fromServerCase({ id: 'srv-1', version: 3, patientId: PID, encounterId: EID, patientRecord: PREC, encounterRecord: { id: EID, type: 'admission', status: 'open', ward: 'W', bed: '4' }, values: {}, notes: [] }, true);
  assert.deepEqual(JSON.parse(JSON.stringify(c0.patientRecord)), PREC); assert.equal(c0.encounterRecord.bed, '4');
  assert.equal(t.Store._test.fromServerCase({ id: 'srv-2', version: 1, values: {}, notes: [] }, true).patientRecord, null);
  assert.ok(!('patientRecord' in t.Store._test.metaOf(c0)), 'never part of what is diffed or sent');
  // link handing over the chosen patient and encounter: shown at once; a record for a different id is dropped
  await t.Store.patients.link(CID, { patientId: PID, encounterId: EID, patient: Object.assign({ phone: '123', nationalId: 'X' }, PREC), encounter: { id: EID, type: 'admission', status: 'open', ward: 'W', bed: '4', attendingId: 'u' } });
  let c = t.Store.getCases()[0];
  const J = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(J(c.patientRecord), PREC, 'only the display fields are kept: no phone, no national id'); assert.deepEqual(Object.keys(c.encounterRecord).sort(), ['bed', 'id', 'status', 'type', 'ward']);
  edit(t.Store, CID, (x) => { x.narrative = 'after'; }); await t.Store.flush();
  const body = t.writes().filter((x) => x.method === 'PATCH' && x.path === '/cases/' + CID).pop().body;
  assert.ok(!JSON.stringify(body).includes('Real Name') && !('patientRecord' in body) && !('encounterRecord' in body), 'records are never written back');
  assert.equal(t.Store.getCases()[0].patientRecord.name, 'Real Name', 'a normal save keeps the records');
  await t.Store.patients.link(CID, { patientId: PID, patient: { id: '99999999-9999-4999-8999-999999999999', name: 'Someone Else' } });
  c = t.Store.getCases()[0]; assert.equal(c.patientRecord.name, 'Real Name', 'a record for another id is ignored; the matching cached one stays');
  assert.equal(c.encounterRecord, null, 'linking without that encounter clears its record');
});

test('34d: exportCase asks the export route every time (never cached), refuses a bad id, and passes a 409 case_not_linked on unchanged', async () => {
  const t = await readyServerStore(); const P = t.Store.patients;
  let n = 0; t.custom = async (m, p) => (m === 'GET' && p === '/cases/' + CID + '/export') ? [200, { exportedAt: 'x' + (++n), patientFullUrl: 'urn:uuid:a', bundle: { resourceType: 'Bundle', entry: [] } }] : null;
  assert.equal((await P.exportCase(CID)).exportedAt, 'x1'); assert.equal((await P.exportCase(CID)).exportedAt, 'x2');
  assert.equal(t.calls.filter((c) => c.path === '/cases/' + CID + '/export').length, 2, 'two exports, two requests');
  await assert.rejects(async () => P.exportCase('../x'), (e) => e.code === 'bad_id');
  t.custom = async (m, p) => p.endsWith('/export') ? err(409, 'case_not_linked', 'Link this chart to a patient before exporting it.') : null;
  await assert.rejects(P.exportCase(CID), (e) => e.status === 409 && e.code === 'case_not_linked');
});

// ---------------------------------------------------------------- chunk 34d: bundle() in enhancer.html uses the server's Patient and Encounter
// The real bundle() source is cut out of enhancer.html and run in a vm with small stubs for the page (no browser, no database).
function loadBundle({ server, exportCase }) {
  const html = fs.readFileSync(path.join(__dirname, 'enhancer.html'), 'utf8').split('\n');
  const line = (re) => { const l = html.find((x) => re.test(x)); assert.ok(l, 'enhancer.html no longer has ' + re); return l; };
  const a = html.findIndex((x) => x.startsWith('const isoOf=')), b = html.findIndex((x) => x.startsWith('function dl()'));
  assert.ok(a > 0 && b > a, 'bundle() block not found');
  const src = [/^const flS=/, /^const vk=/, /^const esc=/, /^const fnum=/, /^const grp=/, /^const tcol=/, /^const rowsOf=/, /^const SYSU=/, /^function st\(f\)/, /^const isPw=/].map(line).join('\n') + '\n' + html.slice(a, b).join('\n');
  const els = {}, toasts = [], set = { setId: 's1', title: 'S1', kind: 'care', version: 1, sections: [{ fields: [{ id: 'cc', label: 'Complaint', type: 'text', fhir: { resource: 'Observation', valueType: 'valueString' } }] }] };
  const sb = { crypto, console, toasts, els, CUR: { id: 'c1', applied: [{ setId: 's1' }], pathways: [], notes: [], narrative: 'n', values: { 's1/cc': 'cough', 's1/__protocol': { bands: [{ lo: 111, hi: 222, text: 'BANDTEXT' }] }, '__protocol': 'PROTOTEXT' } },
    $: (id) => els[id] || (els[id] = { textContent: '', innerHTML: '' }), toast: (m) => toasts.push(m), getSet: () => set, ensureNotes() {}, pwMembers: () => [],
    codes: () => ({}), ck: () => '', SRV: () => server, Store: { patients: { exportCase } } };
  vm.createContext(sb); vm.runInContext(src + '\nthis.bundle = bundle;', sb);
  return sb;
}
const X34 = (over) => ({ patientFullUrl: 'urn:uuid:p1', encounterFullUrl: 'urn:uuid:e1', bundle: { resourceType: 'Bundle', type: 'transaction', entry: [
  { fullUrl: 'urn:uuid:p1', resource: { resourceType: 'Patient', identifier: [{ value: '10000008' }], name: [{ text: 'Real Person' }], gender: 'female', birthDate: '1980-05-17' }, request: { method: 'POST', url: 'Patient' } },
  { fullUrl: 'urn:uuid:e1', resource: { resourceType: 'Encounter', status: 'in-progress', subject: { reference: 'urn:uuid:p1' } }, request: { method: 'POST', url: 'Encounter' } }] }, ...over });

test('34d: server mode: the bundle holds the real Patient and Encounter, clinical resources point at them, no placeholder and no protocol data', async () => {
  const sb = loadBundle({ server: true, exportCase: async (id) => { assert.equal(id, 'c1'); return X34(); } });
  await sb.bundle();
  const B = JSON.parse(sb.els.bj.textContent), types = B.entry.map((e) => e.resource.resourceType);
  assert.deepEqual(sb.toasts, []); assert.equal(types[0], 'Patient'); assert.equal(types[1], 'Encounter');
  assert.equal(B.entry[0].resource.identifier[0].value, '10000008'); assert.equal(B.entry.filter((e) => e.resource.resourceType === 'Patient').length, 1);
  const obs = B.entry.find((e) => e.resource.resourceType === 'Observation').resource;
  assert.equal(obs.subject.reference, 'urn:uuid:p1'); assert.equal(obs.encounter.reference, 'urn:uuid:e1');
  const prov = B.entry.find((e) => e.resource.resourceType === 'Provenance').resource;
  assert.ok(prov.target.some((t) => t.reference === 'urn:uuid:p1') && !('encounter' in prov), 'Provenance is not tied to the encounter');
  const txt = sb.els.bj.textContent;
  assert.ok(!txt.includes('SYNTHETIC-001') && !txt.includes('BANDTEXT') && !txt.includes('PROTOTEXT') && !txt.includes('222'), 'no placeholder patient, no protocol bands');
  assert.match(sb.els.bchk.innerHTML, /audit log/);
});

test('34d: server mode: an export refused by the server (chart not linked) builds nothing and says why; Demo mode keeps the placeholder and never calls the server', async () => {
  const bad = loadBundle({ server: true, exportCase: async () => { const e = new Error('Link this chart to a patient before exporting it.'); e.code = 'case_not_linked'; throw e; } });
  await bad.bundle(); assert.deepEqual(bad.toasts, ['Link this chart to a patient before exporting it.']); assert.ok(!bad.els.bj || !bad.els.bj.textContent, 'no bundle');
  const other = loadBundle({ server: true, exportCase: async () => { throw new Error('Network down'); } });
  await other.bundle(); assert.match(other.toasts[0], /^Export failed: Network down/);
  let called = 0; const demo = loadBundle({ server: false, exportCase: async () => { called++; } });
  await demo.bundle(); assert.equal(called, 0); assert.ok(demo.els.bj.textContent.includes('SYNTHETIC-001')); assert.match(demo.els.bchk.innerHTML, /^Demo mode: placeholder patient/);
});

test('34d: if the open chart changes while the export is being prepared, nothing is built', async () => {
  let sb; sb = loadBundle({ server: true, exportCase: async () => { sb.CUR = { id: 'c2', applied: [], pathways: [], notes: [], narrative: 'x', values: {} }; return X34(); } });
  await sb.bundle(); assert.match(sb.toasts[0], /changed while the export/); assert.ok(!sb.els.bj || !sb.els.bj.textContent);
});

// ---------------------------------------------------------------- chunk 35b: acknowledgements are server records
test('35b: ackAlert (server mode) POSTs ids and sig only, after the case itself; the server fills in who and when; a case PATCH never carries alertLog', async () => {
  const t = await readyServerStore(); const id = crypto.randomUUID();
  t.Store.setCases([mkCase(id)]); await t.Store.flush();
  t.custom = async (m, p, b) => (m === 'POST' && p === '/cases/' + id + '/alert-acks' ? [201, { id: 7, ruleId: b.ruleId, setId: b.setId, sig: b.sig, ackedAt: '2026-11-19T08:00:00.000Z', by: 'u9', byName: 'Dr Server', source: 'user' }] : null);
  const e = t.Store.ackAlert(id, { ruleId: 'r1', setId: 'care.t', sig: 'r1|>=|38|C|2026-11-19T07:00:00.000Z|39' });
  assert.ok(e && e.ruleId === 'r1'); assert.equal(t.Store.getCases()[0].alertLog.length, 1, 'shown at once');
  await t.Store.flush();
  const w = t.writes().filter((x) => /alert-acks$/.test(x.path)); assert.equal(w.length, 1);
  assert.deepEqual(Object.keys(w[0].body).sort(), ['ruleId', 'setId', 'sig'], 'no user, no time, no source in the request');
  assert.equal(e.byName, 'Dr Server'); assert.equal(e.by, 'u9'); assert.equal(e.ackedAt, '2026-11-19T08:00:00.000Z');
  edit(t.Store, id, (c) => { c.narrative = 'v2'; });
  await t.Store.flush();
  const patches = t.writes().filter((x) => x.method === 'PATCH' && /^\/cases\//.test(x.path)); assert.ok(patches.length >= 1);
  for (const x of patches) assert.ok(!('alertLog' in x.body), 'alertLog is never sent in a case PATCH');
  assert.equal(t.Store.ackAlert(id, { ruleId: 'bad id', setId: 'care.t', sig: 's' }), false);
  assert.equal(t.Store.ackAlert(id, { ruleId: 'r1', setId: 'care.t', sig: '' }), false);
  assert.equal(t.Store.ackAlert(crypto.randomUUID(), { ruleId: 'r1', setId: 'care.t', sig: 's' }), false, 'unknown case');
  assert.equal(t.writes().filter((x) => /alert-acks$/.test(x.path)).length, 1, 'refused input sends nothing');
});

test('35b: Demo mode: ackAlert does nothing and never calls the server (the screen keeps its own list)', async () => {
  const t = boot(async () => { throw new Error('fetch must not be called in Demo mode'); }, { mode: 'local' }); await t.Store.init();
  const id = crypto.randomUUID(); t.Store.setCases([mkCase(id)]);
  assert.equal(t.Store.ackAlert(id, { ruleId: 'r1', setId: 'care.t', sig: 's' }), false); assert.equal(t.calls.length, 0);
});

// ---------------------------------------------------------------- chunk 36b: Store.ai (the browser only ever talks to the server routes)
const aiMe = (extra = {}) => async (m, p) => (m === 'GET' && p === '/me' ? [200, Object.assign({ id: 'u1', name: 'Dev', role: 'doctor', mode: 'session', ai: true, allowed: ['ai.suggest', 'ai.rule_draft'] }, extra)] : null);

test('36b: Store.ai.available follows the /me flag and the role; Demo mode has no AI', async () => {
  const t = await readyServerStore(); t.custom = null;
  const on = boot(happy(), {}); on.custom = null;
  const mk = async (extra) => { const x = boot(async (m, p, b) => (await aiMe(extra)(m, p)) || happy()(m, p, b)); await x.Store.init(); return x.Store; };
  let S = await mk({});
  assert.equal(S.ai.available(), true); assert.equal(S.ai.available('suggest'), true); assert.equal(S.ai.available('ruleDraft'), true); assert.equal(S.ai.available('schema'), false, 'a doctor-like list without ai.schema');
  S = await mk({ ai: false }); assert.equal(S.ai.available(), false); assert.equal(S.ai.available('suggest'), false);
  S = await mk({ ai: undefined }); assert.equal(S.ai.available(), false, 'a server that does not say is treated as off');
  const demo = boot(async () => { throw new Error('fetch must not be called in Demo mode'); }, { mode: 'local' }); await demo.Store.init();
  assert.equal(demo.Store.ai.available(), false);
  for (const f of [() => demo.Store.ai.preview('suggest', { narrative: 'x' }), () => demo.Store.ai.run('suggest', { narrative: 'x' }), () => demo.Store.ai.status(), () => demo.Store.ai.setEnabled(true)]) await assert.rejects(f(), (e) => e.code === 'demo_mode');
  assert.equal(demo.calls.length, 0);
});

test('36b: Store.ai.preview sends preview:true and nothing else changes; run never sends preview and never caches or queues anything', async () => {
  const t = boot(async (m, p, b) => (await aiMe()(m, p)) || (m === 'POST' && p.startsWith('/llm/') ? [200, b.preview ? { preview: true, sent: 'text', removed: {}, removedCount: 0 } : { suggestions: [], pathways: [] }] : happy()(m, p, b)));
  await t.Store.init(); const before = t.calls.length;
  const pv = await t.Store.ai.preview('suggest', { narrative: 'cough', caseId: 'c1', preview: false });
  assert.equal(pv.sent, 'text');
  const rn = await t.Store.ai.run('suggest', { narrative: 'cough', caseId: 'c1', preview: true });
  assert.deepEqual(rn, { suggestions: [], pathways: [] });
  const ai = t.calls.slice(before).filter((c) => c.method === 'POST'); assert.equal(ai.length, 2);
  assert.deepEqual(ai[0], { method: 'POST', path: '/llm/suggest', body: { narrative: 'cough', caseId: 'c1', preview: true } });
  assert.deepEqual(ai[1], { method: 'POST', path: '/llm/suggest', body: { narrative: 'cough', caseId: 'c1' } }, 'preview is stripped from the real call');
  const paths = []; for (const [k, p] of [['schema', '/llm/schema'], ['ruleDraft', '/llm/rule-draft']]) { await t.Store.ai.run(k, { x: 1 }); paths.push(t.calls[t.calls.length - 1].path); assert.equal(paths[paths.length - 1], p); }
  await assert.rejects(t.Store.ai.run('nope', {}), (e) => e.code === 'bad_kind');
  assert.equal(t.writes().filter((w) => !w.path.startsWith('/llm/')).length, 0, 'no queued writes');
  assert.ok(![...t.ls.keys()].some((k) => /ai|llm/i.test(k)), 'nothing stored in the browser');
});

test('36b: a 403 ai_disabled switches the AI flag off at once; an admin toggle updates it; other errors leave it alone', async () => {
  let off = false;
  const t = boot(async (m, p, b) => (await aiMe({ role: 'admin', allowed: ['ai.suggest', 'ai.admin'] })(m, p)) || (p === '/llm/suggest' ? (off ? [403, { error: { code: 'ai_disabled', message: 'AI disabled' } }] : [429, { error: { code: 'ai_rate_limited', message: 'Too many AI requests.' } }]) : p === '/admin/ai' && m === 'PUT' ? [200, { enabled: b.enabled }] : happy()(m, p, b)));
  await t.Store.init(); assert.equal(t.Store.ai.available('suggest'), true);
  await assert.rejects(t.Store.ai.run('suggest', { narrative: 'x' }), (e) => e.status === 429); assert.equal(t.Store.ai.available('suggest'), true);
  off = true; await assert.rejects(t.Store.ai.preview('suggest', { narrative: 'x' }), (e) => e.code === 'ai_disabled'); assert.equal(t.Store.ai.available('suggest'), false);
  await t.Store.ai.setEnabled(true); assert.equal(t.Store.me.ai, true); assert.deepEqual(t.calls[t.calls.length - 1].body, { enabled: true });
  await t.Store.ai.setEnabled(false); assert.equal(t.Store.me.ai, false);
});
