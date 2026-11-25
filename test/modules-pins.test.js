'use strict';
// Row R0e-1: pins (applied sets as server pins) live in modules/80-pins.js and behave as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '80-pins.js'), 'utf8');
const NAMES = ['pinDef', 'pinsLoad', 'pinPost', 'applySetSrv', 'applyPathwaySrv', 'removeSetSrv', 'upgradeSrv'];
const CONSTS = ['pinEntry'];

test('80-pins.js loads after 79-timeline.js and before the inline script; none of it is inline any more', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/80-pins.js'), l.indexOf('modules/79-timeline.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/80-pins.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    const re = new RegExp(`(async )?function ${n}\\(`);
    assert.ok(!re.test(inline), 'still inline: ' + n);
    assert.ok(re.test(mod), 'missing from the module: ' + n);
  }
  for (const c of CONSTS) {
    assert.ok(!new RegExp(`^const ${c}=`, 'm').test(inline), 'constant still inline: ' + c);
    assert.ok(new RegExp(`^const ${c}=`, 'm').test(mod), 'constant missing: ' + c);
  }
  const tops = mod.split('\n').filter(x => /^(const|let|var) /.test(x)).map(x => x.split('=')[0].replace(/^(const|let|var) /, ''));
  assert.deepEqual(tops, CONSTS, 'no other top-level variables');
  assert.match(inline, /const PIN=\{defs:\{\},busy:false\}/, 'PIN state stays in the page');
  assert.match(inline, /function savePatient\(/, 'the patient banner code next to the pins stays in the page');
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });

test('pinEntry maps a server row to a page entry and keeps the source pathway from the server', async () => {
  const w = await page();
  const e = JSON.parse(w.eval(`JSON.stringify(pinEntry({ slug: 's', id: 7, element_set_id: 3, version: 2, checksum: 'c', set_title: 'T', applied_at: 'a', applied_by: 'u', from_pathway_slug: 'pw', from_pathway_title: 'P', from_pathway_version: 4 }))`));
  assert.deepEqual(e, { setId: 's', srvAs: '7', srvSet: '3', version: 2, checksum: 'c', title: 'T', addedAt: 'a', appliedBy: 'u', fromPathway: 'pw', fromPathwayTitle: 'P', fromPathwayVersion: 4 });
  const n = JSON.parse(w.eval(`JSON.stringify(pinEntry({ slug: 's', id: 1, element_set_id: 1, version: 1 }))`));
  assert.equal(n.fromPathway, null);
});

test('pinDef reads the exact pinned version once and caches it by set and version', async () => {
  const calls = [];
  const w = await page(async (u) => {
    calls.push(u);
    if (u === '/api/element-sets/3/versions/2') return res(200, { set: { kind: 'form' }, version: { version: 2, checksum: 'c', definition: { title: 'T', fields: [{ id: 'f' }] } } });
    return res(404, {});
  });
  const ok1 = await w.eval(`pinDef({ setId: 's', srvSet: '3', version: 2 })`);
  const ok2 = await w.eval(`pinDef({ setId: 's', srvSet: '3', version: 2 })`);
  assert.equal(ok1, true); assert.equal(ok2, true);
  assert.equal(calls.filter(u => u === '/api/element-sets/3/versions/2').length, 1);
  assert.equal(w.eval(`PIN.defs['3:2'].fields.length`), 1);
  assert.equal(await w.eval(`pinDef({ setId: 'x', srvSet: '9', version: 1 })`), false, 'a missing definition is a failure');
});

test('applySetSrv refuses without a saved case, without cases:write, and while the pins are not loaded (no request)', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }; REGISTRY = [{ id: 'a', title: 'A', fields: [], srv: { setId: 1, version: 1 } }]`);
  calls.length = 0;
  w.eval(`CASE.serverId = null`); await w.eval(`applySetSrv('a')`);
  w.eval(`CASE.serverId = 5; CASE.pinsOk = false`); await w.eval(`applySetSrv('a')`);
  w.eval(`Srv.user = { username: 'v', role: 'viewer', perms: [] }; CASE.pinsOk = true`); await w.eval(`applySetSrv('a')`);
  assert.deepEqual(calls, []);
});

test('removeSetSrv asks first and sends nothing when the user says no', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.confirm = () => false;
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }; CASE.serverId = 5; CASE.applied = [{ setId: 'a', srvAs: '9', title: 'A', version: 1 }]`);
  calls.length = 0;
  await w.eval(`removeSetSrv('a')`);
  assert.deepEqual(calls, []);
  assert.equal(w.eval('CASE.applied.length'), 1);
});
