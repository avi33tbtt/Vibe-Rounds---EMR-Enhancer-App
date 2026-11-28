'use strict';
// Task D6: package staging on the server (stage, list, read, reject). Route matrix is in safety-routes.test.js; the table classification is in safety-data.test.js.
// Fixtures are small hand-written synthetic documents, checksummed with the vendored CCIS code. Prototype. Synthetic data only. Not for clinical use.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setup, client } = require('./helpers');

let env, C;
test.before(async () => { env = await setup(); C = await import(pathToFileURL(path.join(__dirname, '..', 'vendor', 'ccis', 'ccis-compile.js')).href); });
test.after(async () => { await env.close(); });

const as = async user => { const c = client(env.base); assert.equal((await c.login(user)).status, 200); return c; };
const count = async t => Number((await env.pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);
const sum = doc => C.checksumOf(C.canonicalize(doc).text);
const art = doc => ({ checksum: sum(doc), document: doc });
const clone = x => JSON.parse(JSON.stringify(x));
const man = (id, type, name) => ({ id, name, type, version: '0.1.0', status: 'draft', publisher: { name: 'Synthetic test publisher' }, standard: { version: '0.2.0' } });
const loc = code => ({ codeSystem: { id: 'local', version: '0.1.0' }, code, mapping: { status: 'mapped' } });
const TERMS = { manifest: man('t.terms', 'terminology-package', 'Terms'), codeSystem: { id: 'local', version: '0.1.0' }, concepts: [{ key: 'pulse-rate', display: 'Pulse rate' }] };
const VITALS = { manifest: man('core.vitals', 'contextual-element', 'Vitals'), intent: { purpose: 'Record vital signs.' }, provenance: { origin: 'x', basis: 'Synthetic basis.' },
  fields: [{ key: 'hr', label: 'Heart rate', type: 'quantity', units: ['/min'], cardinality: { min: 0, max: 'unbounded' }, concept: loc('pulse-rate'), 'x-emrFieldId': 'hr_bpm' }] };
const withName = (name, id = 'core.vitals') => { const d = clone(VITALS); d.manifest.name = name; d.manifest.id = id; return d; };
const bundle = (...docs) => ({ format: 'ccis-package-bundle/1', artefacts: docs.map(art) });
const stage = (c, b) => c.post('/api/import/packages', b);

test('1. stage: a doctor can; the stager is the session user; the raw bundle is stored nowhere', async () => {
  const d = await as('doctor1');
  const r = await stage(d, bundle(TERMS, VITALS));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const imp = r.body.import;
  assert.equal(imp.staged_by, 'doctor1'); assert.match(imp.bundle_hash, /^[0-9a-f]{64}$/);
  assert.equal(imp.proposals.length, 1); assert.equal(imp.proposals[0].kind, 'set'); assert.equal(imp.proposals[0].status, 'staged'); assert.equal(imp.proposals[0].row_version, 1);
  assert.equal(await count('package_proposals'), 1);
  const all = JSON.stringify((await env.pool.query('SELECT * FROM package_imports')).rows) + JSON.stringify((await env.pool.query('SELECT * FROM package_proposals')).rows);
  assert.ok(!all.includes(sum(VITALS)), 'no artefact checksum from the raw bundle entries'); assert.ok(!all.includes('"document"') && !all.includes('ccis-package-bundle'), 'no raw bundle');
});

test('2. the same bundle again gives 409 with the first id', async () => {
  const d = await as('doctor1');
  const r = await stage(d, bundle(TERMS, VITALS));
  assert.equal(r.status, 409); assert.equal(r.body.error, 'already_staged'); assert.ok(r.body.importId >= 1);
  assert.equal(await count('package_imports'), 1);
});

test('3. blockers are staged and readable; a package with no readable element, or a bad checksum alone, is refused with an audit row', async () => {
  const d = await as('doctor1');
  const blocked = withName('Vitals B', 'core.vitalsb'); blocked.fields.push({ key: 'x', label: 'X', type: 'weird', cardinality: { min: 0, max: 1 } });
  const r = await stage(d, bundle(TERMS, blocked));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = r.body.import.proposals[0];
  assert.equal(p.ready, false); assert.ok(p.blockers.length >= 1);
  const bad = bundle(VITALS); bad.artefacts[0].checksum = 'sha256:' + '0'.repeat(64);
  const r2 = await stage(d, bad);
  assert.equal(r2.status, 400); assert.equal(r2.body.error, 'invalid_package');
  assert.equal((await stage(d, { format: 'nope' })).status, 400);
  assert.ok(Number((await env.pool.query(`SELECT count(*) n FROM audit_log WHERE action = 'import.package_refused'`)).rows[0].n) >= 2);
});

test('4. permissions: nurse, viewer, informatician and signed-out callers cannot use any of the four routes', async () => {
  const before = await count('package_imports');
  for (const u of ['nurse1', 'viewer1', 'informatician1']) {
    const c = await as(u);
    for (const [m, p] of [['post', '/api/import/packages'], ['get', '/api/import/packages'], ['get', '/api/import/packages/1'], ['post', '/api/import/package-proposals/1/reject']]) {
      const r = await c[m](p, ...(m === 'post' ? [{}] : [])); assert.equal(r.status, 403, `${u} ${m} ${p}`); assert.equal(r.body.perm, 'import:write');
    }
  }
  const anon = client(env.base);
  assert.equal((await anon.post('/api/import/packages', bundle(TERMS, VITALS))).status, 401);
  assert.equal(await count('package_imports'), before);
});

test('5. list and read return counts and the concept map; the audit holds no text', async () => {
  const d = await as('admin1');
  const list = (await d.get('/api/import/packages')).body.imports;
  assert.ok(list.length >= 2); assert.equal(typeof list[0].staged_count, 'number');
  const one = (await d.get('/api/import/packages/' + list[list.length - 1].id)).body.import;
  assert.ok(Array.isArray(one.concept_map)); assert.equal(one.summary.elements, 1);
  assert.equal((await d.get('/api/import/packages/999999')).status, 404);
  const rows = (await env.pool.query(`SELECT detail FROM audit_log WHERE action LIKE 'import.package%'`)).rows;
  assert.ok(rows.length >= 3);
  for (const x of rows) assert.ok(!/Vitals|Heart rate|Synthetic/.test(JSON.stringify(x.detail)), 'audit has no package text');
});

test('6. reject needs a reason and the current rowVersion; stale and repeat are 409; unknown fields are refused', async () => {
  const d = await as('doctor1');
  const imp = (await stage(d, bundle(TERMS, withName('Vitals C', 'core.vitalsc')))).body.import, p = imp.proposals[0], url = `/api/import/package-proposals/${p.id}/reject`;
  assert.equal((await d.post(url, { rowVersion: 1 })).status, 400);
  assert.equal((await d.post(url, { reason: 'x' })).status, 400);
  assert.equal((await d.post(url, { reason: 'x', rowVersion: 1, status: 'accepted' })).status, 400);
  assert.equal((await d.post(url, { reason: 'x', rowVersion: 5 })).status, 409);
  const ok = await d.post(url, { reason: '  Not needed here  ', rowVersion: 1 });
  assert.equal(ok.status, 200); assert.equal(ok.body.proposal.status, 'rejected'); assert.equal(ok.body.proposal.rejected_by, 'doctor1'); assert.equal(ok.body.proposal.reject_reason, 'Not needed here'); assert.equal(ok.body.proposal.row_version, 2);
  assert.equal((await d.post(url, { reason: 'again', rowVersion: 2 })).body.error, 'proposal_final');
});

test('7. database: emr_app has no DELETE or TRUNCATE; staged content cannot change; a rejected row is final', async () => {
  for (const t of ['package_imports', 'package_proposals']) for (const priv of ['DELETE', 'TRUNCATE'])
    assert.equal((await env.pool.query(`SELECT has_table_privilege('emr_app', $1, $2) ok`, [t, priv])).rows[0].ok, false, `${priv} on ${t}`);
  await assert.rejects(env.pool.query(`DELETE FROM package_proposals`), /cannot|not allowed|forbid|never/i);
  await assert.rejects(env.pool.query(`UPDATE package_imports SET summary = '{}'::jsonb`), /./);
  const { id } = (await env.pool.query(`SELECT id FROM package_proposals WHERE status = 'staged' LIMIT 1`)).rows[0];
  await assert.rejects(env.appPool.query(`UPDATE package_proposals SET body = '{}'::jsonb WHERE id = $1`, [id]), /permission denied/);
  await assert.rejects(env.pool.query(`UPDATE package_proposals SET ready = NOT ready WHERE id = $1`, [id]), /./);
  await assert.rejects(env.pool.query(`UPDATE package_proposals SET body = '{}'::jsonb WHERE id = $1`, [id]), /what was staged cannot be changed/);
  const rej = (await env.pool.query(`SELECT id FROM package_proposals WHERE status = 'rejected' LIMIT 1`)).rows[0].id;
  await assert.rejects(env.pool.query(`UPDATE package_proposals SET status = 'staged', row_version = row_version + 1 WHERE id = $1`, [rej]), /./);
});

test('8. hostile strings come back as plain text and are never executed or echoed in errors', async () => {
  const d = await as('doctor1'), H = '<img src=x onerror=alert(1)>';
  const r = await stage(d, bundle(TERMS, withName(H, 'core.vitalsh')));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = r.body.import.proposals[0];
  assert.equal(p.ready, false); assert.ok(p.blockers.length >= 1);
  assert.ok(!JSON.stringify(p.blockers).includes('onerror'), 'blocker messages never echo package text');
  const rej = await d.post(`/api/import/package-proposals/${p.id}/reject`, { reason: H, rowVersion: 1 });
  assert.equal(rej.status, 200); assert.equal(rej.body.proposal.reject_reason, H);
  const aud = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'import.package_proposal_reject' ORDER BY id DESC LIMIT 1`)).rows[0].detail;
  assert.ok(!JSON.stringify(aud).includes('onerror'));
});
