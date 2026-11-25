'use strict';
// Row R2f-4b: scripts/bind-demo-codes.js restores LOCAL codes on the demo vitals, glucose and DKA sets as new, reviewed versions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client, PW, reviewers, approveVersion } = require('./helpers');
const { seedTerms } = require('../scripts/seed-terms');
const { bindDemoCodes, MAP } = require('../scripts/bind-demo-codes');

let env, admin, doctor;
const LIMITS = { limits: { write: { max: 100000 }, loginIp: { max: 100000 }, loginUser: { max: 100000 } } };
const q = async (sql, args) => (await env.pool.query(sql, args)).rows;
const bind = () => bindDemoCodes({ base: env.base, password: PW });

// The demo sets as the page imports them: uncoded, v1, reviewed and published through the real routes.
const DEFS = {
  vitals: ['care', [['hr', 'Heart rate', 'integer'], ['bp_sys', 'Systolic BP', 'integer'], ['bp_dia', 'Diastolic BP', 'integer'], ['rr', 'Respiratory rate', 'integer'], ['temp', 'Temperature', 'number'], ['spo2', 'SpO2', 'integer']]],
  glucose_ss: ['care', [['glu', 'Capillary glucose', 'number'], ['ss_notes', 'Notes', 'text']]],
  dka_ctx: ['disease', [['dka_arr', 'ED arrival', 'datetime'], ['dka_glu', 'Glucose at presentation', 'number']]],
};
async function publishDemoSet(slug) {
  const [kind, fields] = DEFS[slug];
  const r = await doctor.post('/api/element-sets', { slug, kind, definition: { title: slug, fields: fields.map(([id, label, type]) => ({ id, label, type })) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await approveVersion(await reviewers(env.base), r.body.set.id, 1);
  assert.equal((await admin.post(`/api/element-sets/${r.body.set.id}/versions/1/publish`, {})).status, 200);
}
const published = async slug => (await q(`SELECT v.version, v.definition_json AS def FROM element_set_versions v JOIN element_sets s ON s.id = v.element_set_id WHERE s.slug = $1 AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`, [slug]))[0];

test.before(async () => {
  env = await setup(LIMITS);
  doctor = client(env.base); admin = client(env.base);
  assert.equal((await doctor.login('doctor1')).status, 200); assert.equal((await admin.login('admin1')).status, 200);
});
test.after(async () => { await env.close(); });

test('the mapping uses only example local terms (demo.*) and the fields named in it exist in the demo sets', () => {
  for (const [slug, m] of Object.entries(MAP)) {
    assert.ok(DEFS[slug], slug);
    const ids = DEFS[slug][1].map(f => f[0]);
    for (const [field, code] of Object.entries(m)) { assert.ok(ids.includes(field), `${slug}.${field}`); assert.match(code, /^demo\.[a-z-]+$/); }
  }
});

test('a set that is not in the published library is skipped (nothing to change)', async () => {
  assert.deepEqual(await bind(), { bound: 0, current: 0, skipped: 3 });
});

test('without the example terms published, it stops with a clear message and changes nothing', async () => {
  for (const s of Object.keys(DEFS)) await publishDemoSet(s);
  await assert.rejects(bind(), /not published\. Run "npm run terms:seed"/);
  for (const s of Object.keys(DEFS)) assert.equal((await published(s)).version, 1);
});

test('it adds local codes as new reviewed versions; mapped fields carry code, display and version as text; others stay uncoded', async () => {
  await seedTerms({ base: env.base, password: PW });
  const r = await bind();
  assert.deepEqual(r, { bound: 3, current: 0, skipped: 0 });
  const v = await published('vitals');
  assert.equal(v.version, 2);
  const byId = Object.fromEntries(v.def.fields.map(f => [f.id, f]));
  assert.deepEqual(byId.hr.bindings, [{ system: 'local', code: 'demo.heart-rate', display: 'Heart rate', version: '1' }]);
  assert.equal(byId.bp_sys.bindings[0].code, 'demo.blood-pressure'); assert.equal(byId.bp_dia.bindings[0].code, 'demo.blood-pressure');
  assert.equal(byId.temp.bindings, undefined);
  assert.equal((await published('glucose_ss')).def.fields[0].bindings[0].code, 'demo.raised-glucose');
  assert.equal((await published('dka_ctx')).def.fields[1].bindings[0].code, 'demo.raised-glucose');
  // v1 stays as history, and the new version went through submit, approve and publish by different people
  const hist = await q(`SELECT v.version, v.status FROM element_set_versions v JOIN element_sets s ON s.id = v.element_set_id WHERE s.slug = 'vitals' ORDER BY v.version`);
  assert.deepEqual(hist.map(h => h.version), [1, 2]);
  const row = (await q(`SELECT cu.username AS author, su.username AS submitter, v.published_by FROM element_set_versions v JOIN element_sets s ON s.id = v.element_set_id JOIN users cu ON cu.id = v.created_by JOIN users su ON su.id = v.submitted_by WHERE s.slug = 'vitals' AND v.version = 2`))[0];
  assert.equal(row.author, 'doctor1'); assert.equal(row.submitter, 'doctor1');
  assert.equal((await q(`SELECT count(*)::int AS n FROM element_set_reviews r JOIN element_sets s ON s.id = r.element_set_id WHERE s.slug = 'vitals' AND r.version = 2 AND r.decision = 'approve'`))[0].n, 1);
});

test('a later submit of a set using these bindings passes server lint (the codes are verified)', async () => {
  const def = (await published('vitals')).def;
  const r = await doctor.post('/api/element-sets', { slug: 'vitals-copy', kind: 'care', definition: def });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const s = await doctor.post(`/api/element-sets/${r.body.set.id}/versions/1/submit`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
});

test('running it again changes nothing', async () => {
  const before = (await q('SELECT count(*)::int AS n FROM element_set_versions'))[0].n;
  assert.deepEqual(await bind(), { bound: 0, current: 3, skipped: 0 });
  assert.equal((await q('SELECT count(*)::int AS n FROM element_set_versions'))[0].n, before);
});

test('a reworded term makes the bindings stale; running it again adds a new version with the new display and version', async () => {
  await seedTerms({ base: env.base, password: PW, reset: true });   // new published versions of every example term (version 2)
  const r = await bind();
  assert.equal(r.bound, 3);
  const f = (await published('vitals')).def.fields.find(x => x.id === 'hr');
  assert.equal(f.bindings[0].version, '2'); assert.equal((await published('vitals')).version, 3);
});

test('an open version stops it and nothing is changed', async () => {
  const s = (await doctor.get('/api/element-sets')).body.sets.find(x => x.slug === 'glucose_ss');
  const d = (await published('glucose_ss')).def;
  assert.equal((await doctor.post(`/api/element-sets/${s.id}/versions`, { definition: d })).status, 201);
  await assert.rejects(bind(), /open version/);
  assert.equal((await published('glucose_ss')).version, 3);
});
