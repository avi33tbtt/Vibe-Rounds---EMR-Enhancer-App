'use strict';
// Row R0e-4: values (server observations as a view; B3b-2 and B3b-3) live in modules/86-values.js and behave as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { pageHtml, localScripts } = require('./html');

const raw = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', '86-values.js'), 'utf8');
const NAMES = ['valuesRebuild', 'toTyped', 'obsSave', 'allRows', 'setRows', 'addRow', 'obsError', 'markRowError', 'markValError', 'setVal'];
const CONSTS = ['vkey', 'pad2', 'localDT', 'fmtT', 'srvCase', 'dispVal', 'OBS_BUSY', 'SHOW_ERR', 'rowBad', 'getRows', 'OBS_ERR'];

test('86-values.js loads after 84-notes.js and before the inline script; none of it is inline any more', () => {
  const l = localScripts();
  assert.equal(l.indexOf('modules/86-values.js'), l.indexOf('modules/84-notes.js') + 1, l.join(', '));
  assert.ok(l.indexOf('modules/86-values.js') < l.indexOf('modules/90-wire.js'));
  const inline = raw.slice(raw.indexOf('<script>'));
  for (const n of NAMES) {
    const re = new RegExp(`(async )?function ${n}\\(`);
    assert.ok(!re.test(inline), 'still inline: ' + n);
    assert.ok(re.test(mod), 'missing from the module: ' + n);
  }
  for (const c of CONSTS) {
    assert.ok(!new RegExp(`^(const|let) ${c}=`, 'm').test(inline), 'constant still inline: ' + c);
    assert.ok(new RegExp(`^(const|let) ${c}=`, 'm').test(mod), 'constant missing: ' + c);
  }
  const tops = mod.split('\n').filter(x => /^(const|let|var) /.test(x)).map(x => x.split('=')[0].replace(/^(const|let|var) /, ''));
  assert.deepEqual(tops, CONSTS, 'no other top-level variables');
  assert.match(inline, /\/\* Render \*\//, 'the render code after the values stays in the page');
});

test('R0e closing check: no inline event handler attribute in the page or any module', () => {
  const dir = path.join(__dirname, '..', 'modules');
  const files = [['emr-enhancer.html', raw], ...fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')])];
  for (const [name, text] of files) assert.ok(!/\son[a-z]+\s*=\s*["'\\]/i.test(text.replace(/data-ev=/g, '')), 'inline handler in ' + name);
});

async function page(fetchImpl) {
  const dom = new JSDOM(pageHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) { w.fetch = fetchImpl || (async () => { throw new Error('offline'); }); w.confirm = () => true; } });
  await new Promise(r => setTimeout(r, 150));
  return dom.window;
}
const res = (status, body) => ({ status, json: async () => body });
const j = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));

test('vkey keys a server pin per set, so two sets sharing a field id keep separate values', async () => {
  const w = await page();
  assert.equal(w.eval(`vkey({ srvAs: '1', srvSet: '7' }, 'glu')`), '7:glu');
  assert.equal(w.eval(`vkey({ srvAs: '2', srvSet: '8' }, 'glu')`), '8:glu');
  assert.equal(w.eval(`vkey(null, 'glu')`), 'glu');
});

test('toTyped never stores a blank and checks each type', async () => {
  const w = await page();
  assert.match(j(w, `toTyped({ type: 'number' }, '  ')`).err, /Unknown/);
  assert.deepEqual(j(w, `toTyped({ type: 'number' }, '5.5')`), { v: 5.5 });
  assert.equal(j(w, `toTyped({ type: 'number' }, 'abc')`).err, 'Enter a number.');
  assert.equal(j(w, `toTyped({ type: 'integer' }, '2.5')`).err, 'Enter a whole number.');
  assert.deepEqual(j(w, `toTyped({ type: 'boolean' }, 'Yes')`), { v: true });
  assert.equal(j(w, `toTyped({ type: 'boolean' }, 'maybe')`).err, 'Choose Yes or No.');
  assert.deepEqual(j(w, `toTyped({ type: 'select', options: ['a'] }, 'a')`), { v: 'a' });
  assert.equal(j(w, `toTyped({ type: 'select', options: ['a'] }, 'b')`).err, 'Choose one of the listed options.');
  assert.match(j(w, `toTyped({ type: 'image' }, 'x')`).err, /cannot hold a value here/);
});

test('valuesRebuild builds the view from server rows: latest scalar, repeat rows newest first, wrong rows kept apart', async () => {
  const w = await page();
  w.eval(`PIN.defs['7:1'] = { id: 's', title: 'S', fields: [{ id: 'a', type: 'number' }, { id: 'r', type: 'number', repeat: true }] }`);
  const c = { applied: [{ setId: 's', srvAs: '1', srvSet: '7', version: 1 }], obs: [
    { id: 1, element_set_id: 7, field_key: 'a', value: 1, value_type: 'number', effective_at: '2026-01-01T00:00:00Z', status: 'final' },
    { id: 2, element_set_id: 7, field_key: 'a', value: 2, value_type: 'number', effective_at: '2026-01-02T00:00:00Z', status: 'final' },
    { id: 3, element_set_id: 7, field_key: 'r', value: 10, value_type: 'number', effective_at: '2026-01-01T00:00:00Z', status: 'final' },
    { id: 4, element_set_id: 7, field_key: 'r', value: 20, value_type: 'number', effective_at: '2026-01-02T00:00:00Z', status: 'final' },
  ] };
  w.eval(`window.__c = ${JSON.stringify(c)}; valuesRebuild(window.__c)`);
  assert.equal(w.eval(`window.__c.values['7:a']`), '2');
  assert.deepEqual(j(w, `window.__c.values['7:r'].map(x => x.id)`), [4, 3]);
  w.eval(`window.__c.obs.push({ id: 5, element_set_id: 7, field_key: 'a', value: 9, value_type: 'number', effective_at: '2026-01-03T00:00:00Z', status: 'entered_in_error' }); valuesRebuild(window.__c)`);
  assert.equal(w.eval(`window.__c.values['7:a']`), '2', 'a wrong row is not the current value');
  assert.equal(w.eval(`window.__c.vbad['7:a'].length`), 1);
});

test('rowBad and getRows hide rows marked entered in error but allRows keeps them', async () => {
  const w = await page();
  w.eval(`CASE.values = { x: [{ id: 1, status: 'entered_in_error' }, { id: 2 }] }`);
  assert.equal(w.eval(`allRows('x').length`), 2);
  assert.equal(w.eval(`getRows('x').length`), 1);
});

test('obsSave sends nothing for a missing field, without cases:write, or with the case not fully loaded', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.eval(`PIN.defs['7:1'] = { id: 's', title: 'S', fields: [{ id: 'a', type: 'number' }] }; CASE.serverId = 5; CASE.applied = [{ setId: 's', srvAs: '1', srvSet: '7', version: 1 }]; CASE.pinsOk = true`);
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }`);
  calls.length = 0;
  await w.eval(`obsSave('nope', '1', 's')`);
  w.eval(`Srv.user = { username: 'v', role: 'viewer', perms: [] }`); await w.eval(`obsSave('a', '1', 's')`);
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }; CASE.pinsOk = false`); await w.eval(`obsSave('a', '1', 's')`);
  assert.deepEqual(calls, []);
});

test('obsSave posts one typed observation with the pin id, never a blank, and the server row joins the view', async () => {
  const calls = [];
  const w = await page(async (u, o) => {
    calls.push((o && o.method) + ' ' + u + ' ' + (o && o.body));
    return res(201, { observations: [{ id: 11, element_set_id: 7, field_key: 'a', value: 5, value_type: 'number', effective_at: '2026-11-25T10:00:00Z', status: 'final' }] });
  });
  w.eval(`PIN.defs['7:1'] = { id: 's', title: 'S', fields: [{ id: 'a', type: 'number' }] }; CASE.serverId = 5; CASE.applied = [{ setId: 's', srvAs: '1', srvSet: '7', version: 1 }]; CASE.pinsOk = true; CASE.obs = []`);
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }`);
  calls.length = 0;
  await w.eval(`obsSave('a', '', 's')`);
  assert.deepEqual(calls, [], 'a blank is not sent');
  await w.eval(`obsSave('a', '5', 's')`);
  assert.equal(calls.length, 1);
  const [m, u, b] = [calls[0].split(' ')[0], calls[0].split(' ')[1], JSON.parse(calls[0].split(' ').slice(2).join(' '))];
  assert.equal(m, 'POST'); assert.equal(u, '/api/cases/5/observations');
  assert.equal(b.observations[0].appliedSetId, 1); assert.equal(b.observations[0].fieldKey, 'a'); assert.equal(b.observations[0].value, 5);
  assert.equal(w.eval(`CASE.values['7:a']`), '5');
});

test('obsError needs a reason before it asks the server anything', async () => {
  const calls = [];
  const w = await page(async (u) => { calls.push(u); return res(404, {}); });
  w.prompt = () => '   ';
  w.eval(`Srv.user = { username: 'd', role: 'doctor', perms: ['cases:write'] }`);
  calls.length = 0;
  await w.eval(`obsError(3)`);
  assert.deepEqual(calls, []);
});
