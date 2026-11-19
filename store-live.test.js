'use strict';
// node --test store-live.test.js   (no browser, no database)
// Chunk 37a: the live-refresh merge in store.js (Store.applyChanges, Store.live). The real store.js runs in a vm sandbox against a scripted "server".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');
const GRP = 'care.vitals/@vit';

function happy() {
  let caseVer = 1;
  return async (m, p, b) => {
    if (m === 'GET') {
      const lists = { '/session': { id: 'u1', name: 'Dev', role: 'admin' }, '/csrf': { token: 'tok1' }, '/me': { id: 'u1', name: 'Dev', role: 'admin', mode: 'dev' }, '/cases': [], '/element-sets': [], '/usage': {}, '/codes': [], '/bindings': [], '/rules': {}, '/protocols': {}, '/prefs': {} };
      if (p in lists) return [200, lists[p]];
      return [404, { error: { code: 'not_found', message: 'Not found' } }];
    }
    if (m === 'POST' && p === '/cases') { caseVer = 1; return [201, { version: 1 }]; }
    if (m === 'PATCH' && /^\/cases\/[^/]+$/.test(p)) return [200, { version: ++caseVer }];
    if (m === 'POST' && /\/rows$/.test(p)) return [201, { version: 1, row: b.row, rowTime: b.rowTime }];
    if (m === 'PATCH' && /\/rows\//.test(p)) return [200, { version: 2 }];
    if (m === 'PUT' && /\/values$/.test(p)) return [200, { version: 1 }];
    return [200, {}];
  };
}
function boot(handler, doc) {
  const calls = [];
  const sandbox = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: { randomUUID: () => crypto.randomUUID() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, opts = {}) => {
      const p = String(url).replace(/^\/api/, ''), body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ method: opts.method, path: p, body });
      const [status, data] = await handler(opts.method, p, body);
      return { ok: status >= 200 && status < 300, status, json: async () => data };
    },
  };
  if (doc) sandbox.document = doc;
  sandbox.window = sandbox;
  vm.createContext(sandbox); vm.runInContext(SRC, sandbox);
  return { Store: sandbox.Store, calls, writes: () => calls.filter((c) => c.method !== 'GET'), sandbox };
}
const mkCase = (id, extra = {}) => Object.assign({ id, patient: { name: 'Demo', ageSex: '', bed: '', mrn: '' }, narrative: 'v1', applied: [], pathways: [], alertLog: [], values: {}, notes: [] }, extra);
const until = async (fn, what) => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail('timed out waiting for ' + what); };
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const srvRow = (id, hr, v = 1, extra = {}) => Object.assign({ id, setId: 'care.vitals', groupId: 'vit', row: { hr }, rowTime: null, version: v, status: 'active', enteredBy: 'u2', enteredAt: '2026-01-01T00:00:00Z', byName: 'Sam' }, extra);
const empty = (extra = {}) => Object.assign({ cursor: '2026-01-01T00:00:10Z', truncated: false, case: null, rows: [], values: [], notes: [], acks: [], latest: null }, extra);

// A ready server-mode store holding one case (id, with these rows) that the server has confirmed.
async function withCase(rows = [], extra = {}) {
  const t = boot(async (m, p, b) => (t.custom && (await t.custom(m, p, b))) || happy()(m, p, b));
  await t.Store.init();
  const id = crypto.randomUUID();
  t.Store.setCases([mkCase(id, Object.assign({ values: rows.length ? { [GRP]: rows } : {} }, extra))]);
  await t.Store.flush();
  t.Store._test.ASOF[id] = '2026-01-01T00:00:00Z';
  t.id = id; t.calls.length = 0;
  t.cache = () => t.Store.getCases().find((c) => c.id === id);
  t.edit = (fn) => { const cs = t.Store.getCases(); fn(cs.find((c) => c.id === id)); t.Store.setCases(cs); };
  return t;
}
const J = (x) => JSON.parse(JSON.stringify(x));                          // values made inside the vm sandbox have that realm's Array and Object: compare plain copies
const hrs = (c) => Array.from(c.values[GRP] || [], (r) => r.hr);

test('37a client: a row another user added appears, in the cache and in the screen copy, and nothing is sent back', async () => {
  const t = await withCase();
  const live = t.cache();                                              // the screen's working copy is a separate object
  const sum = t.Store.applyChanges(t.id, empty({ rows: [srvRow('r1', 70)], latest: { byName: 'Sam', at: '2026-01-01T00:00:05Z' } }), live);
  assert.equal(sum.rows, 1); assert.equal(sum.changed, true); assert.equal(sum.latest.byName, 'Sam');
  assert.deepEqual(hrs(live), [70]); assert.deepEqual(hrs(t.cache()), [70]);
  assert.equal(live.values[GRP][0].__id, 'r1');
  t.Store.setCases([live]); await t.Store.flush();                     // the screen saves its copy: nothing to send
  assert.deepEqual(t.writes(), []);
});

test('37a client: the same answer twice, and the person\'s own row coming back, change nothing', async () => {
  const t = await withCase();
  const ch = empty({ rows: [srvRow('r1', 70)] });
  assert.equal(t.Store.applyChanges(t.id, ch, null).rows, 1);
  const again = t.Store.applyChanges(t.id, ch, null);
  assert.equal(again.changed, false); assert.equal(again.skipped, 0); assert.deepEqual(hrs(t.cache()), [70]);
  t.edit((c) => { c.values[GRP].push({ hr: 80 }); }); await t.Store.flush();   // my own new reading, sent; the server's answer repeats it at version 1
  const mine = t.cache().values[GRP].find((r) => r.hr === 80);
  const echo = t.Store.applyChanges(t.id, empty({ rows: [srvRow(mine.__id, 80)] }), null);
  assert.equal(echo.changed, false); assert.equal(hrs(t.cache()).length, 2);
});

test('37a client: a reading the person has changed and not yet sent is never overwritten', async () => {
  const t = await withCase();
  t.Store.applyChanges(t.id, empty({ rows: [srvRow('r1', 70)] }), null);
  const live = t.cache(); live.values[GRP][0].hr = 71;                    // typed in the working copy, not saved yet
  const sum = t.Store.applyChanges(t.id, empty({ rows: [srvRow('r1', 99, 2)] }), live);
  assert.equal(sum.skipped, 1); assert.equal(sum.changed, false);
  assert.equal(live.values[GRP][0].hr, 71);
  t.Store.setCases([live]); await t.Store.flush();
  const w = t.writes().find((x) => x.method === 'PATCH');
  assert.equal(w.body.expectedVersion, 1);                             // still the version the person saw: the server answers 409 and the conflict screen opens
  assert.equal(w.body.row.hr, 71);
});

test('37a client: an item the person has open (editing) is skipped even before any change is typed', async () => {
  const t = await withCase();
  t.Store.applyChanges(t.id, empty({ rows: [srvRow('r1', 70)] }), null);
  const live = t.cache(), seen = [];
  const sum = t.Store.applyChanges(t.id, empty({ rows: [srvRow('r1', 99, 2)] }), live, { editing: (k, ref) => { seen.push([k, ref]); return k === 'row' && ref === 'r1'; } });
  assert.equal(sum.skipped, 1); assert.equal(live.values[GRP][0].hr, 70); assert.deepEqual(seen[0], ['row', 'r1']);
  const next = t.Store.applyChanges(t.id, empty({ rows: [srvRow('r1', 99, 2)] }), live);   // the person closed it: the next poll takes it
  assert.equal(next.rows, 1); assert.equal(live.values[GRP][0].hr, 99);
});

test('37a client: a reading entered in error disappears from the screen without sending anything; an unsent edit of it stays', async () => {
  const t = await withCase();
  t.Store.applyChanges(t.id, empty({ rows: [srvRow('r1', 70), srvRow('r2', 72)] }), null);
  const live = t.cache(); live.values[GRP].find((r) => r.__id === 'r2').hr = 73;
  const sum = t.Store.applyChanges(t.id, empty({ rows: [{ id: 'r1', setId: 'care.vitals', groupId: 'vit', status: 'entered_in_error', version: 2 }, { id: 'r2', setId: 'care.vitals', groupId: 'vit', status: 'entered_in_error', version: 2 }] }), live);
  assert.equal(sum.rows, 1); assert.equal(sum.skipped, 1);
  assert.deepEqual(hrs(live), [73]); assert.deepEqual(hrs(t.cache()), [72]);
  t.Store.setCases([live]); await t.Store.flush();
  assert.ok(!t.writes().some((w) => /\/error$/.test(w.path) && /r1/.test(w.path)));            // nobody marks a colleague's row "entered in error" because the screen lacked it
  const again = t.Store.applyChanges(t.id, empty({ rows: [{ id: 'r1', setId: 'care.vitals', groupId: 'vit', status: 'entered_in_error', version: 2 }] }), t.cache());
  assert.equal(again.changed, false);                                  // the overlap returns it again: no second notice
});

test('37a client: single values merge unless changed here; notes and acknowledgements merge', async () => {
  const t = await withCase();
  const k = 'care.vitals/__ref';
  t.Store.applyChanges(t.id, empty({ values: [{ key: k, value: { x: 1 }, version: 1 }] }), null);
  assert.deepEqual(J(t.cache().values[k]), { x: 1 });
  const live = t.cache(); live.values[k] = { x: 5 };
  assert.equal(t.Store.applyChanges(t.id, empty({ values: [{ key: k, value: { x: 2 }, version: 2 }] }), live).skipped, 1);
  assert.deepEqual(J(live.values[k]), { x: 5 });

  const note = { id: 'n1', type: 'narrative', text: 'hello', status: 'draft', version: 1, createdAt: '2026-01-01T00:00:00Z', signedByName: null };
  const s2 = t.Store.applyChanges(t.id, empty({ notes: [note], acks: [{ id: 7, ruleId: 'r', setId: 'care.vitals', sig: 's', ackedAt: '2026-01-01T00:00:03Z', by: 'u2', byName: 'Sam', source: 'user' }] }), null);
  assert.equal(s2.notes, 1); assert.equal(s2.acks, 1);
  assert.equal(t.cache().notes[0].text, 'hello'); assert.equal(t.cache().alertLog[0].byName, 'Sam');
  t.Store.applyChanges(t.id, empty({ notes: [Object.assign({}, note, { text: 'hello again', version: 2 })] }), null);
  assert.equal(t.cache().notes[0].text, 'hello again');
  const dup = t.Store.applyChanges(t.id, empty({ acks: [{ id: 7, ruleId: 'r', setId: 'care.vitals', sig: 's', ackedAt: '2026-01-01T00:00:03Z', byName: 'Sam' }] }), null);
  assert.equal(dup.acks, 0); assert.equal(t.cache().alertLog.length, 1);
  const l2 = t.cache(); l2.notes[0].text = 'my edit';                          // an unsent edit of a draft note stays
  assert.equal(t.Store.applyChanges(t.id, empty({ notes: [Object.assign({}, note, { text: 'theirs', version: 3 })] }), l2).skipped, 1);
  assert.equal(l2.notes[0].text, 'my edit');
  t.Store.setCases([t.cache()]); await t.Store.flush();
  assert.deepEqual(t.writes().filter((w) => /ack|notes/.test(w.path) && w.method !== 'PATCH'), []);
});

test('37a client: the case record (narrative, sets) is taken when nothing of it was changed here, kept when it was', async () => {
  const t = await withCase();
  const cs = (v, n) => ({ version: v, narrative: n, applied: [], pathways: [], pinned: null, patient: { name: 'Demo', ageSex: '', bed: '', mrn: '' }, patientId: null, encounterId: null, patientRecord: null, encounterRecord: null, updatedAt: '2026-01-01T00:00:09Z' });
  const live = t.cache();
  assert.equal(t.Store.applyChanges(t.id, empty({ case: cs(2, 'theirs') }), live).case, true);
  assert.equal(live.narrative, 'theirs'); assert.equal(t.cache().narrative, 'theirs');
  live.narrative = 'mine, unsent';
  const sum = t.Store.applyChanges(t.id, empty({ case: cs(3, 'theirs 2') }), live);
  assert.equal(sum.case, false); assert.equal(sum.skipped, 1); assert.equal(live.narrative, 'mine, unsent');
  t.Store.setCases([live]); await t.Store.flush();
  assert.equal(t.writes().find((w) => w.method === 'PATCH').body.expectedVersion, 2);   // the version the person last saw, so the server refuses and the conflict screen opens
});

test('37a client: polling asks /changes with the cursor and the case version, merges, and moves the cursor', async () => {
  const t = await withCase(); const seen = [];
  let n = 0;
  t.custom = async (m, p) => {
    if (m === 'GET' && p.includes('/changes')) { seen.push(decodeURIComponent(p)); return [200, ++n === 1 ? empty({ cursor: '2026-01-01T00:00:20Z', rows: [srvRow('r1', 70)], latest: { byName: 'Sam', at: '2026-01-01T00:00:15Z' } }) : empty({ cursor: '2026-01-01T00:00:30Z' })]; }
    return null;
  };
  const got = []; t.Store.live.start(t.id, { onMerged: (id, s) => got.push([id, s.rows, s.latest.byName]), interval: 15 });
  await until(() => seen.length >= 2, 'two polls');
  t.Store.live.stop();
  assert.ok(seen[0].includes('since=2026-01-01T00:00:00Z') && seen[0].includes('caseVersion=1'));
  assert.ok(seen[1].includes('since=2026-01-01T00:00:20Z'));
  assert.deepEqual(got, [[t.id, 1, 'Sam']]);                           // only a poll that changed something reports
  assert.deepEqual(hrs(t.cache()), [70]);
});

test('37a client: no polling while the tab is hidden; it starts again when the tab is shown', async () => {
  const listeners = [], doc = { hidden: true, addEventListener: (ev, fn) => { if (ev === 'visibilitychange') listeners.push(fn); } };
  const t = boot(async (m, p, b) => (t.custom && (await t.custom(m, p, b))) || happy()(m, p, b), doc);
  await t.Store.init(); const id = crypto.randomUUID();
  t.Store.setCases([mkCase(id)]); await t.Store.flush(); t.Store._test.ASOF[id] = '2026-01-01T00:00:00Z';
  let polls = 0; t.custom = async (m, p) => (m === 'GET' && p.includes('/changes') ? (polls++, [200, empty()]) : null);
  t.Store.live.start(id, { interval: 10 });
  await tick(120); assert.equal(polls, 0);                             // hidden: not one request
  doc.hidden = false; listeners.forEach((f) => f());
  await until(() => polls >= 2, 'polling to resume');
  doc.hidden = true; await tick(40); const at = polls; await tick(120);
  assert.ok(polls <= at + 1, 'polling stopped after the tab was hidden'); t.Store.live.stop();
});

test('37a client: an answer that was cut off (truncated) is replaced by a full read, merged the same careful way', async () => {
  const t = await withCase();
  const full = { id: t.id, patient: { name: 'Demo', ageSex: '', bed: '', mrn: '' }, narrative: 'v1', applied: [], pathways: [], pinned: null, alertLog: [], version: 1, updatedAt: '2026-01-01T00:00:00Z', asOf: '2026-01-01T00:00:40Z',
    values: { [GRP]: [{ hr: 66, __id: 'r9', __v: 1, __by: 'u2', __at: '2026-01-01T00:00:01Z', __time: null, __status: 'active' }] }, valueVersions: {}, notes: [] };
  t.custom = async (m, p) => {
    if (m === 'GET' && p.includes('/changes')) return [200, { cursor: 'x', truncated: true, rows: [], values: [], notes: [], acks: [], case: null, latest: null }];
    if (m === 'GET' && p === '/cases/' + t.id) return [200, full];
    return null;
  };
  const sum = await t.Store.live.now(t.id);
  assert.equal(sum.rows, 1); assert.deepEqual(hrs(t.cache()), [66]);
  assert.equal(t.Store._test.ASOF[t.id], '2026-01-01T00:00:40Z');
});

test('37a client: a case with no cursor yet is read in full first; a case not yet on the server, a conflict, signed out, or Demo mode asks nothing', async () => {
  const t = await withCase(); delete t.Store._test.ASOF[t.id];
  const full = { id: t.id, patient: { name: 'Demo', ageSex: '', bed: '', mrn: '' }, narrative: 'v1', applied: [], pathways: [], pinned: null, alertLog: [], version: 1, updatedAt: 'x', asOf: '2026-01-01T00:00:50Z', values: {}, valueVersions: {}, notes: [] };
  t.custom = async (m, p) => (m === 'GET' && p === '/cases/' + t.id ? [200, full] : null);
  await t.Store.live.now(t.id);
  assert.equal(t.calls.filter((c) => c.method === 'GET').length, 1); assert.equal(t.Store._test.ASOF[t.id], '2026-01-01T00:00:50Z');
  t.calls.length = 0;
  assert.equal(await t.Store.live.now(crypto.randomUUID()), null); assert.equal(t.calls.length, 0);
  t.Store._test.conflicts[t.id] = { entity: 'case:' + t.id };
  assert.equal(await t.Store.live.now(t.id), null); assert.equal(t.calls.length, 0);
});

test('37a client: Demo mode never polls', async () => {
  const fresh = (() => { const s = { localStorage: { getItem: (k) => (k === 'storeMode' ? 'local' : null), setItem() {} }, crypto, setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => { throw new Error('network'); } }; s.window = s; vm.createContext(s); vm.runInContext(SRC, s); return s.Store; })();
  assert.equal(fresh.mode, 'local');
  assert.equal(fresh.live.start('x'), false); assert.equal(fresh.live.active(), null);
  assert.equal(await fresh.live.now('x'), null);
});
