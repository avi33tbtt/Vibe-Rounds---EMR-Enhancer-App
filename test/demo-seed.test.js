'use strict';
// Row DM1: the demo seed and reset (scripts/seed-demo.js). It goes through the app's own routes, so these tests check the result in the database
// and that the envelope (B5a) of the seeded case validates against the vendored CCIS schema and carries no identity.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { setup, client, PW } = require('./helpers');
const { seedDemo, PATIENT, CASE_TITLE } = require('../scripts/seed-demo');

const C = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', f), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(C('manifest.schema.json'));
const validate = ajv.compile(C('context-envelope.schema.json'));

let env;
test.before(async () => { env = await setup({ contextSecret: 'demo-secret-demo-secret-demo-secret-12' }); });
test.after(async () => { await env.close(); });
const q = async (sql, args) => (await env.pool.query(sql, args)).rows;

test('seeding twice gives one patient and one active demo case with the pathway pinned at published versions', async () => {
  const a = await seedDemo({ base: env.base, password: PW });
  assert.equal(a.created, true);
  const b = await seedDemo({ base: env.base, password: PW });
  assert.equal(b.created, false);
  assert.equal(b.caseId, a.caseId);

  const pats = await q('SELECT id, name FROM patients WHERE mrn = $1', [PATIENT.mrn]);
  assert.equal(pats.length, 1);
  assert.equal(pats[0].name, 'DEMO, Patient A');
  const cases = await q(`SELECT id, status FROM clinical_cases WHERE title = $1`, [CASE_TITLE]);
  assert.deepEqual(cases.map(c => c.status), ['active']);

  const pins = await q(`SELECT pv.status AS pathway_status, sv.status AS set_status FROM case_applied_pathways ap
                          JOIN pathway_versions pv ON pv.id = ap.pathway_version_id
                          JOIN case_applied_sets a ON a.from_applied_pathway_id = ap.id
                          JOIN element_set_versions sv ON sv.id = a.element_set_version_id WHERE ap.case_id = $1`, [a.caseId]);
  assert.deepEqual(pins, [{ pathway_status: 'published', set_status: 'published' }]);
  assert.equal((await q('SELECT count(*)::int AS n FROM element_sets'))[0].n, 1);     // the second run made no second set or pathway
  assert.equal((await q('SELECT count(*)::int AS n FROM pathways'))[0].n, 1);
});

test('the demo values: 8 timed observations, one explicit Unknown, one item deliberately missing', async () => {
  const [{ id: caseId }] = await q(`SELECT id FROM clinical_cases WHERE title = $1 AND status = 'active'`, [CASE_TITLE]);
  const obs = await q('SELECT field_key, value_type, effective_at, recorded_at FROM observations WHERE case_id = $1 ORDER BY id', [caseId]);
  assert.equal(obs.length, 8);
  assert.deepEqual(obs.filter(o => o.value_type === 'unknown').map(o => o.field_key), ['clotting_result']);
  assert.equal(obs.some(o => o.field_key === 'antivenom_start_time'), false);
  assert.ok(new Set(obs.map(o => +o.effective_at)).size >= 5, 'effective times are spread out');
  assert.ok(obs.every(o => +o.effective_at < +o.recorded_at), 'every effective time is earlier than its recorded time');
  assert.ok(+obs[obs.length - 1].effective_at < Date.now());
});

test('the envelope of the seeded case validates and carries no name, MRN or case title', async () => {
  const [{ id: caseId }] = await q(`SELECT id FROM clinical_cases WHERE title = $1 AND status = 'active'`, [CASE_TITLE]);
  const doctor = client(env.base);
  assert.equal((await doctor.login('doctor1')).status, 200);
  const r = await doctor.get(`/api/cases/${caseId}/context`);
  assert.equal(r.status, 200);
  assert.equal(validate(r.body), true, JSON.stringify(validate.errors, null, 1));
  assert.equal(r.body.observations.length, 8);
  const bytes = JSON.stringify(r.body);
  for (const s of ['DEMO, Patient A', 'Patient A', PATIENT.mrn, PATIENT.dob, CASE_TITLE]) assert.equal(bytes.includes(s), false, s);
});

test('reset archives the previous demo case (nothing is deleted) and makes one fresh active case', async () => {
  const [{ id: oldId }] = await q(`SELECT id FROM clinical_cases WHERE title = $1 AND status = 'active'`, [CASE_TITLE]);
  const before = (await q('SELECT count(*)::int AS n FROM observations WHERE case_id = $1', [oldId]))[0].n;
  const r = await seedDemo({ base: env.base, password: PW, reset: true });
  assert.equal(r.created, true);
  assert.notEqual(r.caseId, oldId);
  const cases = await q(`SELECT id, status FROM clinical_cases WHERE title = $1 ORDER BY id`, [CASE_TITLE]);
  assert.deepEqual(cases.map(c => c.status), ['archived', 'active']);
  assert.equal((await q('SELECT count(*)::int AS n FROM observations WHERE case_id = $1', [oldId]))[0].n, before);   // the old case keeps its values
  assert.equal((await q('SELECT count(*)::int AS n FROM patients WHERE mrn = $1', [PATIENT.mrn]))[0].n, 1);
  assert.equal((await seedDemo({ base: env.base, password: PW })).created, false);                                       // still one active case after a plain seed
});

test('a wrong password says what to do and writes nothing', async () => {
  const n = (await q('SELECT count(*)::int AS n FROM clinical_cases'))[0].n;
  await assert.rejects(() => seedDemo({ base: env.base, password: 'not-the-password' }), /npm run seed/);
  assert.equal((await q('SELECT count(*)::int AS n FROM clinical_cases'))[0].n, n);
});
