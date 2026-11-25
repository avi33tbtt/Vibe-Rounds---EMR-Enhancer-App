'use strict';
// Tasks R2f-1 and R2f-2: local terms, drafts and the review workflow (local-terms.js, migrations 016 and 017). The permission matrix and the audit scenario are in safety-routes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');

let env, admin, doctor, nurse, viewer, informatician, informatician2;
const login = async u => { const c = client(env.base); assert.equal((await c.login(u)).status, 200, u); return c; };
test.before(async () => {
  env = await setup();
  [admin, doctor, nurse, viewer, informatician, informatician2] = await Promise.all(['admin1', 'doctor1', 'nurse1', 'viewer1', 'informatician1', 'informatician2'].map(login));
});
test.after(async () => { await env.close(); });
const add = (c, body) => c.post('/api/local-terms', body);

test('a doctor adds a draft; the author comes from the session and status starts as draft', async () => {
  const r = await add(doctor, { code: 'snake.fang-marks', display: 'Fang marks seen', category: 'finding', definition: 'Puncture marks at the bite site.' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual({ code: r.body.term.code, version: r.body.term.version, status: r.body.term.status, by: r.body.term.created_by, cat: r.body.term.category },
    { code: 'snake.fang-marks', version: 1, status: 'draft', by: 'doctor1', cat: 'finding' });
  const a = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'term.create' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(a.detail.code, 'snake.fang-marks');
  assert.ok(!JSON.stringify(a.detail).includes('Puncture'), 'the audit row holds the code and version, not the free text');
});

test('only admin and doctor add; every signed-in role reads; signed out is refused', async () => {
  for (const who of [nurse, viewer, informatician]) assert.equal((await add(who, { code: 'role.x', display: 'X' })).status, 403);
  assert.equal((await add(admin, { code: 'role.admin', display: 'Admin made' })).status, 201);
  for (const who of [admin, doctor, nurse, viewer, informatician]) assert.equal((await who.get('/api/local-terms')).status, 200);
  assert.equal((await client(env.base).get('/api/local-terms')).status, 401);
});

test('a body that names anything else is refused, not ignored (createdBy, status, version, id, system)', async () => {
  for (const extra of [{ createdBy: 1 }, { status: 'published' }, { version: 5 }, { id: 9 }, { system: 'loinc' }]) {
    const r = await add(doctor, { code: 'bad.extra', display: 'Extra', ...extra });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_field');
  }
  assert.equal((await env.pool.query(`SELECT 1 FROM local_terms WHERE code = 'bad.extra'`)).rowCount, 0);
});

test('bad input is refused: code shape, display, category, definition, control characters', async () => {
  const cases = [{ code: 'Upper', display: 'x' }, { code: '-lead', display: 'x' }, { code: 'a b', display: 'x' }, { code: 'a'.repeat(65), display: 'x' }, { code: 5, display: 'x' },
    { code: 'ok.code', display: '' }, { code: 'ok.code', display: '   ' }, { code: 'ok.code', display: 'x'.repeat(201) }, { code: 'ok.code', display: 'two\nlines' },
    { code: 'ok.code', display: 'nul\u0000' }, { code: 'ok.code', display: 'lone\ud800' }, { code: 'ok.code', display: 'x', category: 'icd10' },
    { code: 'ok.code', display: 'x', definition: 'y'.repeat(501) }, { code: 'ok.code', display: 'x', definition: '' }];
  for (const body of cases) assert.equal((await add(doctor, body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await env.pool.query(`SELECT 1 FROM local_terms WHERE code = 'ok.code'`)).rowCount, 0);
  assert.equal((await add(doctor, { code: 'ok.code', display: 'Fine', definition: 'Line one\nline two' })).status, 201, 'a definition may have line breaks');
});

test('an open version blocks another; after a terminal status the next add is version + 1', async () => {
  assert.equal((await add(doctor, { code: 'ver.term', display: 'First' })).status, 201);
  const again = await add(doctor, { code: 'ver.term', display: 'Second' });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'open_version');
  assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM local_terms WHERE code = 'ver.term'`)).rows[0].n, 1);
  await env.pool.query(`UPDATE local_terms SET status = 'in_review', submitted_by = created_by, submitted_at = now() WHERE code = 'ver.term'`);   // owner connection: a shortcut to a final status
  await env.pool.query(`UPDATE local_terms SET status = 'rejected' WHERE code = 'ver.term'`);
  const next = await add(doctor, { code: 'ver.term', display: 'Second' });
  assert.equal(next.status, 201, JSON.stringify(next.body)); assert.equal(next.body.term.version, 2);
});

test('two adds of the same new code at once: one version 1 is made and the other is refused, never two', async () => {
  const rs = await Promise.all([add(doctor, { code: 'race.term', display: 'A' }), add(admin, { code: 'race.term', display: 'B' })]);
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 409]);
  assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM local_terms WHERE code = 'race.term'`)).rows[0].n, 1);
});

test('list shows each code once (latest version), filters by status and text; get shows all versions; bad ids and filters are refused', async () => {
  const list = (await doctor.get('/api/local-terms')).body.terms;
  assert.equal(new Set(list.map(t => t.code)).size, list.length);
  assert.equal(list.find(t => t.code === 'ver.term').version, 2);
  assert.ok((await doctor.get('/api/local-terms?status=draft')).body.terms.every(t => t.status === 'draft'));
  assert.deepEqual((await doctor.get('/api/local-terms?q=fang')).body.terms.map(t => t.code), ['snake.fang-marks']);
  assert.deepEqual((await doctor.get('/api/local-terms?q=%25')).body.terms, [], 'a % in the search is plain text, not a wildcard');
  assert.equal((await doctor.get('/api/local-terms?status=bogus')).status, 400);
  const one = (await doctor.get(`/api/local-terms/${list.find(t => t.code === 'ver.term').id}`)).body;
  assert.deepEqual(one.versions.map(v => v.version), [2, 1]);
  assert.equal((await doctor.get('/api/local-terms/999999')).status, 404);
  assert.equal((await doctor.get('/api/local-terms/abc')).status, 404);
});

test('database rules: no delete or truncate for anyone; the app role cannot touch the words; submitted content and status direction are locked', async () => {
  await assert.rejects(env.pool.query(`DELETE FROM local_terms`));
  await assert.rejects(env.pool.query(`TRUNCATE local_terms`));
  await assert.rejects(env.appPool.query(`UPDATE local_terms SET display = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE local_terms SET definition = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`UPDATE local_terms SET code = 'x'`), /permission denied/);
  await assert.rejects(env.appPool.query(`DELETE FROM local_terms`), /permission denied/);
  await env.pool.query(`UPDATE local_terms SET display = 'Edited draft' WHERE code = 'snake.fang-marks'`);   // a draft may still change (owner connection)
  await env.pool.query(`UPDATE local_terms SET status = 'in_review', submitted_by = created_by, submitted_at = now() WHERE code = 'snake.fang-marks'`);
  await assert.rejects(env.pool.query(`UPDATE local_terms SET display = 'Sneaky' WHERE code = 'snake.fang-marks'`), /immutable/);
  await assert.rejects(env.pool.query(`UPDATE local_terms SET status = 'draft' WHERE code = 'snake.fang-marks'`), /cannot go back/);
  await assert.rejects(env.pool.query(`UPDATE local_terms SET code = 'other' WHERE code = 'snake.fang-marks'`), /identity/);
});

test('local terms touch no clinical table', async () => {
  const q = `SELECT (SELECT count(*) FROM patients) p, (SELECT count(*) FROM observations) o, (SELECT count(*) FROM element_sets) s`;
  const before = (await env.pool.query(q)).rows[0];
  assert.equal((await add(doctor, { code: 'iso.term', display: 'Isolated' })).status, 201);
  assert.deepEqual((await env.pool.query(q)).rows[0], before);
});

// ---------- R2f-2: review workflow ----------
const act = (c, id, action, body = {}) => c.post(`/api/local-terms/${id}/${action}`, body);
const mk = async (code, who = doctor) => (await add(who, { code, display: 'Term ' + code })).body.term.id;
const status = async id => (await env.pool.query('SELECT status FROM local_terms WHERE id = $1', [id])).rows[0].status;

test('the full path: submit, approve, publish, retire; who and when come from the session; audit rows hold no free text', async () => {
  const id = await mk('flow.ok');
  assert.equal((await act(doctor, id, 'submit')).body.term.status, 'in_review');
  const ap = await act(informatician, id, 'approve', { reason: 'Looks right' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body)); assert.equal(ap.body.term.status, 'reviewed');
  assert.equal((await act(admin, id, 'publish')).body.term.status, 'published');
  const row = (await env.pool.query(`SELECT s.username sub, p.username pub, t.published_at FROM local_terms t JOIN users s ON s.id = t.submitted_by JOIN users p ON p.id = t.published_by WHERE t.id = $1`, [id])).rows[0];
  assert.deepEqual([row.sub, row.pub], ['doctor1', 'admin1']); assert.ok(row.published_at);
  const one = (await doctor.get(`/api/local-terms/${id}`)).body;
  assert.deepEqual(one.reviews.map(r => [r.reviewer, r.decision, r.reason]), [['informatician1', 'approve', 'Looks right']]);
  assert.equal((await act(admin, id, 'retire')).body.term.status, 'retired');
  const audit = (await env.pool.query(`SELECT detail FROM audit_log WHERE action LIKE 'term.%' AND entity_id = $1`, [String(id)])).rows;
  assert.ok(audit.length >= 5); assert.ok(!JSON.stringify(audit).includes('Looks right'), 'the review reason is not copied into the audit log');
});

test('permissions: only admin and doctor submit; only an informatician reviews; only admin publishes or retires', async () => {
  const id = await mk('perm.term');
  for (const who of [nurse, viewer, informatician]) assert.equal((await act(who, id, 'submit')).status, 403);
  assert.equal((await act(admin, id, 'submit')).status, 200);   // an admin may submit (and so cannot also review: not an informatician)
  for (const who of [admin, doctor, nurse, viewer]) assert.equal((await act(who, id, 'approve', { reason: 'x' })).status, 403);
  assert.equal((await act(informatician, id, 'approve', { reason: 'ok' })).status, 200);
  for (const who of [doctor, nurse, viewer, informatician]) { assert.equal((await act(who, id, 'publish')).status, 403); assert.equal((await act(who, id, 'retire')).status, 403); }
  assert.equal(await status(id), 'reviewed');
});

test('a reason is required to approve or reject; a body that names anything else is refused', async () => {
  const id = await mk('reason.term'); await act(doctor, id, 'submit');
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(1001) }, { reason: 5 }, { reason: 'a\u0000b' }]) assert.equal((await act(informatician, id, 'reject', body)).status, 400);
  assert.equal((await act(informatician, id, 'reject', { reason: 'ok', reviewer: 'x' })).body.error, 'unknown_field');
  for (const [code, extra] of [['extra.a', { status: 'published' }], ['extra.b', { submittedBy: 1 }]]) assert.equal((await act(doctor, await mk(code), 'submit', extra)).body.error, 'unknown_field');
  assert.equal(await status(id), 'in_review');
});

test('the author or submitter cannot review their own term; the same reviewer cannot review twice (both refused and audited)', async () => {
  const id = await mk('own.term');
  await act(doctor, id, 'submit');
  await env.pool.query(`UPDATE users SET role = 'informatician' WHERE username = 'doctor1'`);   // a doctor who is also made a reviewer still cannot review a term they wrote
  try {
    const own = await act(doctor, id, 'approve', { reason: 'mine' });
    assert.equal(own.status, 403); assert.equal(own.body.error, 'own_term');
  } finally { await env.pool.query(`UPDATE users SET role = 'doctor' WHERE username = 'doctor1'`); }
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'term.refused' AND entity_id = $1`, [String(id)])).rows[0].n, 1);
  assert.equal(await status(id), 'in_review');
  assert.equal((await act(informatician, id, 'approve', { reason: 'ok' })).status, 200);
  assert.equal((await act(informatician, id, 'approve', { reason: 'again' })).status, 409);   // no longer in review
});

test('one reject is final: the term cannot be approved, published or resubmitted; a new version can be added', async () => {
  const id = await mk('rej.term'); await act(doctor, id, 'submit');
  assert.equal((await act(informatician, id, 'reject', { reason: 'Wrong meaning' })).body.term.status, 'rejected');
  for (const a of ['submit', 'publish', 'retire']) assert.equal((await act(admin, id, a)).status, 409, a);
  assert.equal((await act(informatician2, id, 'approve', { reason: 'late' })).status, 409);
  assert.equal((await add(doctor, { code: 'rej.term', display: 'Better' })).body.term.version, 2);
});

test('steps cannot be skipped: publish needs approval, approve needs submit, retire needs published', async () => {
  const id = await mk('skip.term');
  for (const [who, a] of [[admin, 'publish'], [informatician, 'approve'], [admin, 'retire']]) assert.equal((await act(who, id, a, a === 'approve' ? { reason: 'x' } : {})).status, 409, a);
  assert.equal(await status(id), 'draft');
  assert.equal((await act(doctor, 999999, 'submit')).status, 404);
  assert.equal((await act(doctor, 'abc', 'submit')).status, 404);
});

test('publishing a newer version retires the older published one: one published version per code', async () => {
  const publish = async code => { const id = await mk(code); await act(doctor, id, 'submit'); await act(informatician, id, 'approve', { reason: 'ok' }); assert.equal((await act(admin, id, 'publish')).status, 200); return id; };
  const v1 = await publish('twice.term');
  const v2 = (await add(doctor, { code: 'twice.term', display: 'Newer display' })).body.term.id;
  await act(doctor, v2, 'submit'); await act(informatician, v2, 'approve', { reason: 'ok' });
  assert.equal(await status(v1), 'published', 'the old version stays published until the new one is');
  assert.equal((await act(admin, v2, 'publish')).status, 200);
  assert.equal(await status(v1), 'retired'); assert.equal(await status(v2), 'published');
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM local_terms WHERE code = 'twice.term' AND status = 'published'`)).rows[0].n, 1);
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'term.retire' AND entity_id = $1`, [String(v1)])).rows[0].n, 1);
});

test('the database enforces the same rules without the server: reviews, approval and publish cannot be faked', async () => {
  const id = await mk('db.term'); const uid = async u => (await env.pool.query('SELECT id FROM users WHERE username = $1', [u])).rows[0].id;
  await assert.rejects(env.pool.query(`UPDATE local_terms SET status = 'published', published_by = 1, published_at = now() WHERE id = $1`, [id]), /only an approved/);
  await env.pool.query(`UPDATE local_terms SET status = 'in_review', submitted_by = $2, submitted_at = now() WHERE id = $1`, [id, await uid('doctor1')]);
  await assert.rejects(env.pool.query(`UPDATE local_terms SET status = 'reviewed' WHERE id = $1`, [id]), /needs an approval/);
  await assert.rejects(env.pool.query(`INSERT INTO local_term_reviews(term_id, reviewer_id, decision, reason) VALUES ($1,$2,'approve','x')`, [id, await uid('doctor1')]), /author or the submitter|only an informatician/);
  await assert.rejects(env.pool.query(`INSERT INTO local_term_reviews(term_id, reviewer_id, decision, reason) VALUES ($1,$2,'approve','x')`, [id, await uid('nurse1')]), /only an informatician/);
  await env.pool.query(`INSERT INTO local_term_reviews(term_id, reviewer_id, decision, reason) VALUES ($1,$2,'approve','ok')`, [id, await uid('informatician1')]);
  await assert.rejects(env.pool.query(`UPDATE local_term_reviews SET reason = 'changed'`), /not allowed|append/);
  await assert.rejects(env.pool.query(`DELETE FROM local_term_reviews`), /not allowed|append/);
  await assert.rejects(env.pool.query(`TRUNCATE local_term_reviews`), /not allowed|append/);
  await assert.rejects(env.appPool.query(`UPDATE local_term_reviews SET reason = 'x'`), /permission denied/);
  await env.pool.query(`UPDATE local_terms SET status = 'reviewed' WHERE id = $1`, [id]);
  await assert.rejects(env.pool.query(`UPDATE local_terms SET status = 'published' WHERE id = $1`, [id]), /needs who and when/);
});
