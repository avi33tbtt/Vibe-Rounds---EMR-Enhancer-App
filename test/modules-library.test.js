'use strict';
// Row R0d-1: the server library screen (sets, pathways, demo import) lives in modules/60-library.js and behaves as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '60-library.js'), 'utf8');
const NAMES = ['libDef', 'copyFieldKeys', 'libApply', 'libLoad', 'pwLoad', 'renderLibSrv', 'libPwImport', 'libImport'];
const CONSTS = ['LIB', 'SRV_RO', 'srvLocked', 'DEMO_IMPORT', 'DEF_FIELD_KEYS', 'pwTodo'];

test('60-library.js loads after 50-cases.js and before the inline script; none of it is inline any more', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/60-library.js'), l.indexOf('modules/58-assessment.js') + 1, l.join(', '));   // R1e: 58-assessment.js now sits right before 60-library (R1d: 56-exam.js before it); R1c: 54-adaptive.js sits between 52-complaints and 60-library   // R1a: 52-complaints.js now sits between 50-cases and 60-library
  assert.equal(l.indexOf('modules/52-complaints.js'), l.indexOf('modules/50-cases.js') + 1, l.join(', '));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    const re = new RegExp(`(async )?function ${n}\\(`);
    assert.ok(!re.test(inline), 'still inline: ' + n);
    assert.ok(re.test(mod), 'missing from the module: ' + n);
  }
  for (const c of CONSTS) { assert.ok(!new RegExp(`^const ${c}=`, 'm').test(inline), 'constant still inline: ' + c); assert.ok(new RegExp(`^const ${c}=`, 'm').test(mod), 'constant missing: ' + c); }
  const tops = mod.split('\n').filter(x => /^(const|let|var) /.test(x)).map(x => x.split('=')[0].replace(/^(const|let|var) /, ''));
  assert.deepEqual(tops, CONSTS, 'no other top-level variables');
  assert.ok(!/Set versions: status badges/.test(inline), 'the versions and review screens moved to 70-review.js (R0d-2)');
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });

test('libDef sends only the whitelisted field keys, and bindings only when asked', async () => {
  const w = await page();
  const s = { title: 'S', desc: 'd', fields: [{ id: 'a', label: 'A', type: 'text', junk: 'no', secret: { x: 1 }, bindings: [{ system: 'loinc', code: '1', display: 'x', source: 'manual', extra: 1 }] }] };
  const withC = JSON.parse(w.eval(`JSON.stringify(libDef(${JSON.stringify(s)}, true))`));
  assert.deepEqual(Object.keys(withC.fields[0]).sort(), ['bindings', 'id', 'label', 'type']);
  assert.deepEqual(withC.fields[0].bindings, [{ system: 'loinc', code: '1', display: 'x', source: 'manual' }]);
  const noC = JSON.parse(w.eval(`JSON.stringify(libDef(${JSON.stringify(s)}, false))`));
  assert.ok(!('bindings' in noC.fields[0]));
});

test('libApply puts server sets in the registry (locked read-only) and keeps custom sets; srvLocked tells them apart', async () => {
  const w = await page();
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: [] }; REGISTRY = [{ id: 'mine', title: 'Mine', fields: [] }]`);
  w.eval(`libApply([{ id: 'srvset', title: 'S', fields: [], srv: { setId: 1, version: 1 } }], [{ id: 'pw1', members: [] }])`);
  assert.equal(w.eval('LIB.loaded'), true);
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(REGISTRY.map(x => x.id).sort())')), ['mine', 'srvset']);
  assert.equal(w.eval(`srvLocked('srvset')`), true);
  assert.equal(w.eval(`srvLocked('mine')`), false);
  assert.equal(w.eval('PATHWAYS.length'), 1);
});

test('libLoad without sets:read shows a message, loads nothing and asks the server nothing', async () => {
  const calls = [];
  const w = await page(async (u, o) => { calls.push(u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'v', role: 'viewer', perms: ['cases:read'] }`);
  calls.length = 0;
  await w.eval('libLoad()');
  assert.equal(w.eval('LIB.msg'), 'Your role cannot read the library.');
  assert.deepEqual(calls, []);
});

test('libLoad signed in reads the library from the server and applies only published versions', async () => {
  const calls = [];
  const w = await page(async (u, o) => {
    calls.push(u);
    if (u === '/api/element-sets') return res(200, { sets: [{ id: 1, slug: 'pubset', published_version: 2 }, { id: 2, slug: 'draftonly', published_version: null }] });
    if (u === '/api/element-sets/1/versions/2') return res(200, { version: { version: 2, status: 'published', definition: { title: 'Published set', fields: [{ id: 'f1', label: 'F', type: 'text' }] } } });
    return res(404, {});
  });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['sets:read'] }`);
  calls.length = 0;
  await w.eval('libLoad()');
  assert.ok(calls.includes('/api/element-sets'), calls.join(', '));
  assert.ok(!calls.some(u => u.startsWith('/api/element-sets/2/')), 'the draft-only set was not fetched');
  assert.equal(w.eval('LIB.slugs.has("pubset") && LIB.slugs.has("draftonly")'), true);
});

test('libImport and libPwImport do nothing without the permissions (no confirm, no request)', async () => {
  const calls = []; let asked = 0;
  const w = await page(async (u, o) => { calls.push(u); return res(404, {}); });
  w.confirm = () => { asked++; return true; };
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['sets:read'] }`);
  calls.length = 0;
  await w.eval('libImport()'); await w.eval('libPwImport()');
  assert.equal(asked, 0); assert.deepEqual(calls, []);
});

test('pwTodo splits demo pathways into ready (every member set published on the server) and waiting', async () => {
  const w = await page();
  w.eval(`REGISTRY = [{ id: 'basic_emr', srv: { setId: 1, version: 1 } }, { id: 'vitals', srv: { setId: 2, version: 1 } }]; LIB.pwSlugs = new Set()`);
  const r = JSON.parse(w.eval('JSON.stringify({ ready: pwTodo().ready.map(x => x.id), waiting: pwTodo().waiting.map(x => x.id) })'));
  assert.deepEqual(r.ready, ['pw_basic']);
  assert.ok(r.waiting.includes('pw_dm') && !r.waiting.includes('pw_basic'));
  w.eval(`LIB.pwSlugs = new Set(['pw_basic'])`);
  assert.equal(w.eval(`pwTodo().ready.length`), 0, 'a pathway already on the server in any state is not offered again');
});
