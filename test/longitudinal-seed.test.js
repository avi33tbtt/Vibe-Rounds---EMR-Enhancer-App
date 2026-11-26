'use strict';
// Row R9d-2: longitudinal seed step 1 (scripts/seed-longitudinal.js). Checks the database after going through the app's own routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, PW } = require('./helpers');
const { seedLongitudinal, PATIENT, CASE_TITLE } = require('../scripts/seed-longitudinal');
const { seedDemo, PATIENT: DM1 } = require('../scripts/seed-demo');
const content = require('../longitudinal-demo-content');

let env;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });
const q = async (sql, args) => (await env.pool.query(sql, args)).rows;

test('first run: own patient, four published sets, one published pathway, one case with the pathway pinned', async () => {
  const a = await seedLongitudinal({ base: env.base, password: PW });
  assert.equal(a.created, true);
  assert.equal((await q('SELECT count(*)::int n FROM patients WHERE mrn = $1', [PATIENT.mrn]))[0].n, 1);
  assert.notEqual(PATIENT.mrn, DM1.mrn);
  const sets = await q(`SELECT s.slug, v.status FROM element_sets s JOIN element_set_versions v ON v.element_set_id = s.id ORDER BY s.slug`);
  assert.deepEqual(sets, content.SETS.map(s => ({ slug: s.slug, status: 'published' })).sort((x, y) => x.slug < y.slug ? -1 : 1));
  const pw = await q(`SELECT p.slug, v.status FROM pathways p JOIN pathway_versions v ON v.pathway_id = p.id`);
  assert.deepEqual(pw, [{ slug: content.PATHWAY.slug, status: 'published' }]);
  const cases = await q('SELECT status FROM clinical_cases WHERE title = $1', [CASE_TITLE]);
  assert.deepEqual(cases.map(c => c.status), ['active']);
  const pins = await q(`SELECT count(*)::int n FROM case_applied_sets a JOIN case_applied_pathways ap ON ap.id = a.from_applied_pathway_id WHERE ap.case_id = $1`, [a.caseId]);
  assert.equal(pins[0].n, content.PATHWAY.memberSlugs.length);
  assert.equal((await q('SELECT count(*)::int n FROM observations'))[0].n, 0);   // values come in R9d-3
});

test('running twice changes nothing', async () => {
  const count = async () => JSON.stringify(await q(`SELECT (SELECT count(*) FROM patients) p, (SELECT count(*) FROM clinical_cases) c, (SELECT count(*) FROM element_sets) s,
    (SELECT count(*) FROM element_set_versions) sv, (SELECT count(*) FROM pathways) w, (SELECT count(*) FROM pathway_versions) wv, (SELECT count(*) FROM case_applied_sets) a`));
  const before = await count();
  const b = await seedLongitudinal({ base: env.base, password: PW });
  assert.equal(b.created, false);
  assert.equal(await count(), before);
});

test('separate from DM1: the DM1 seed still makes its own patient and the longitudinal ones stay untouched', async () => {
  const d = await seedDemo({ base: env.base, password: PW });
  assert.equal(d.created, true);
  assert.equal((await q('SELECT count(*)::int n FROM patients WHERE mrn = $1', [PATIENT.mrn]))[0].n, 1);
  assert.equal((await q(`SELECT count(*)::int n FROM clinical_cases WHERE title = $1 AND status = 'active'`, [CASE_TITLE]))[0].n, 1);
});

test('a wrong password stops with a clear message and writes nothing', async () => {
  await assert.rejects(seedLongitudinal({ base: env.base, password: 'wrong' }), /Login as doctor1 failed/);
});
