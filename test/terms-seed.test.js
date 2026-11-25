'use strict';
// Row R2f-3: example local terms (scripts/seed-terms.js). It goes through the app's own routes, so these tests check the result in the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, PW } = require('./helpers');
const { seedTerms, EXAMPLES } = require('../scripts/seed-terms');

let env;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });
const q = async (sql, args) => (await env.pool.query(sql, args)).rows;
const seed = (reset = false) => seedTerms({ base: env.base, password: PW, reset });
const published = async () => q(`SELECT code, version, display FROM local_terms WHERE status = 'published' ORDER BY code`);

test('the examples use no licensed vocabulary: our own codes, plain words, no numbers, no doses or thresholds', () => {
  assert.equal(EXAMPLES.length, 12);
  assert.equal(new Set(EXAMPLES.map(e => e.code)).size, 12);
  for (const e of EXAMPLES) {
    assert.match(e.code, /^demo\.[a-z-]+$/);
    assert.ok(!/\d/.test(e.display + e.definition), e.code + ' has a digit (no numbers, doses or thresholds)');
    assert.ok(e.definition.endsWith('Example term.'), e.code);
    assert.ok(!/\b(loinc|icd|snomed|mg|mmol|units?)\b/i.test(e.display + ' ' + e.definition), e.code);
  }
});

test('seed: every example ends up published through the real rules, with a different reviewer, and the audit log shows each step', async () => {
  const r = await seed();
  assert.deepEqual(r, { published: 0, made: 12, resumed: 0, retired: 0 });
  assert.deepEqual((await published()).map(t => [t.code, t.version]), EXAMPLES.map(e => [e.code, 1]).sort());
  const rows = await q(`SELECT c.username author, s.username submitter, p.username publisher, (SELECT u.username FROM local_term_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.term_id = t.id) reviewer
                          FROM local_terms t JOIN users c ON c.id = t.created_by JOIN users s ON s.id = t.submitted_by JOIN users p ON p.id = t.published_by`);
  assert.equal(rows.length, 12);
  assert.ok(rows.every(x => x.author === 'doctor1' && x.submitter === 'doctor1' && x.reviewer === 'informatician1' && x.publisher === 'admin1'));
  for (const action of ['term.create', 'term.submit', 'term.approve', 'term.publish']) assert.equal((await q('SELECT count(*)::int n FROM audit_log WHERE action = $1', [action]))[0].n, 12, action);
});

test('seeding again changes nothing', async () => {
  const before = await q('SELECT count(*)::int n, max(id) m FROM local_terms');
  assert.deepEqual(await seed(), { published: 12, made: 0, resumed: 0, retired: 0 });
  assert.deepEqual(await q('SELECT count(*)::int n, max(id) m FROM local_terms'), before);
});

test('reset retires the published examples (never deletes) and publishes fresh versions: one published version per code', async () => {
  const r = await seed(true);
  assert.deepEqual(r, { published: 0, made: 12, resumed: 0, retired: 12 });
  assert.equal((await q('SELECT count(*)::int n FROM local_terms'))[0].n, 24);
  assert.deepEqual((await q(`SELECT DISTINCT status FROM local_terms WHERE version = 1`)).map(x => x.status), ['retired']);
  assert.deepEqual((await published()).map(t => t.version), Array(12).fill(2));
  assert.equal((await q(`SELECT count(*)::int n FROM local_terms WHERE status = 'published'`))[0].n, 12);
});

test('an interrupted run is carried on from where it stopped, not restarted', async () => {
  // leave one example half-way: retire its published version, then add a new draft by hand through the route
  const code = EXAMPLES[0].code;
  const [t] = await q(`SELECT id FROM local_terms WHERE code = $1 AND status = 'published'`, [code]);
  await env.pool.query(`UPDATE local_terms SET status = 'retired', retired_by = 1, retired_at = now() WHERE id = $1`, [t.id]);
  const { client } = require('./helpers'); const d = client(env.base); await d.login('doctor1');
  assert.equal((await d.post('/api/local-terms', EXAMPLES[0])).body.term.status, 'draft');
  assert.deepEqual(await seed(), { published: 11, made: 0, resumed: 1, retired: 0 });
  assert.equal((await q(`SELECT max(version)::int v FROM local_terms WHERE code = $1`, [code]))[0].v, 3);
  assert.equal((await q(`SELECT status FROM local_terms WHERE code = $1 AND version = 3`, [code]))[0].status, 'published');
});

test('the seed touches no clinical table and a wrong password stops it with a clear message', async () => {
  const sql = `SELECT (SELECT count(*) FROM patients) p, (SELECT count(*) FROM clinical_cases) c, (SELECT count(*) FROM observations) o, (SELECT count(*) FROM element_sets) s`;
  const before = (await q(sql))[0];
  await seed(true);
  assert.deepEqual((await q(sql))[0], before);
  await assert.rejects(seedTerms({ base: env.base, password: 'wrong-password' }), /Login as doctor1 failed/);
});
