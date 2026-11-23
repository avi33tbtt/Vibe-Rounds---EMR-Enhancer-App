'use strict';
// Chunk 05, check 7: clinical data is never hard-deleted, and signed notes cannot be edited.
//   - database: every table is classified; clinical tables reject DELETE; the audit log rejects UPDATE too
//   - page: a signed note can only be changed by an amendment with a reason; nothing removes notes or cases
// (The route half of "no hard delete" is in safety-routes.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { setup, client } = require('./helpers');
const { exportEnvelope, runRecord } = require('./ccis-helpers');

let env;
test.before(async () => { env = await setup({ contextSecret: 'test-secret-test-secret-test-secret-1234' }); });
test.after(async () => { await env.close(); });

// ---------- database ----------
// Every table must be listed here. A new table fails this test until someone decides which kind it is.
const CLINICAL = ['patients', 'encounters', 'audit_log', 'clinical_cases', 'case_encounters', 'case_narrative_entries', 'element_sets', 'element_set_versions', 'element_set_reviews', 'case_applied_sets', 'observations', 'clinical_events', 'case_notes', 'case_note_amendments', 'pathways', 'pathway_versions', 'pathway_version_steps', 'case_applied_pathways', 'context_exports', 'ccis_runs', 'ccis_run_acks'];        // never deleted: rows are archived, closed, appended or retired
const NOT_CLINICAL = ['users', 'sessions', 'schema_migrations', 'ai_settings'];   // accounts, logins, bookkeeping, settings

test('every table is classified, and every clinical table refuses DELETE', async () => {
  const tables = (await env.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map(r => r.table_name).sort();
  assert.deepEqual(tables, [...CLINICAL, ...NOT_CLINICAL].sort(), 'a new table must be added to CLINICAL (with a delete-blocking trigger) or NOT_CLINICAL in this test');

  const a = client(env.base); assert.equal((await a.login('nurse1')).status, 200);
  const p = await a.post('/api/patients', { name: 'Keep Me', mrn: 'KEEP-1', dob: '1980-01-01', sex: 'F' });
  assert.equal(p.status, 201);
  assert.equal((await a.post(`/api/patients/${p.body.patient.id}/encounters`, { bed: 'KEEP-BED' })).status, 201);
  // a case opened while the encounter is open links to it; one narrative entry: every case table has rows to protect (task B1a)
  const kc = await a.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Keep case' });
  assert.equal(kc.status, 201);
  assert.equal((await a.post(`/api/cases/${kc.body.case.id}/narrative`, { body: 'Keep narrative' })).status, 201);
  // one element set with a version: the set tables have rows to protect too (task B2a)
  const d = client(env.base); assert.equal((await d.login('doctor1')).status, 200);
  assert.equal((await d.post('/api/element-sets', { slug: 'keep-set', kind: 'custom', definition: { title: 'Keep set', fields: [{ id: 'k', label: 'K', type: 'text' }] } })).status, 201);
  // submitted and reviewed: the review table has a row to protect too (task 8c)
  const ks = (await env.pool.query(`SELECT id FROM element_sets WHERE slug = 'keep-set'`)).rows[0].id;
  assert.equal((await d.post(`/api/element-sets/${ks}/versions/1/submit`, {})).status, 200);
  const inf = client(env.base); assert.equal((await inf.login('informatician1')).status, 200);
  assert.equal((await inf.post(`/api/element-sets/${ks}/versions/1/approve`, { reason: 'Keep review' })).status, 200);

  // published, applied and a value recorded: the applied-set, observation and event tables have rows to protect too (task B3a)
  const adm = client(env.base); assert.equal((await adm.login('admin1')).status, 200);
  assert.equal((await adm.post(`/api/element-sets/${ks}/versions/1/publish`, {})).status, 200);
  const as = await a.post(`/api/cases/${kc.body.case.id}/applied-sets`, { setId: ks, version: 1 });
  assert.equal(as.status, 201, JSON.stringify(as.body));
  assert.equal((await a.post(`/api/cases/${kc.body.case.id}/observations`, { observations: [{ appliedSetId: as.body.appliedSet.id, fieldKey: 'k', value: 'Keep value', effectiveAt: '2020-01-01T10:00:00Z', sourceType: 'clinician' }] })).status, 201);

  // a published pathway, applied to a second case: the pathway tables have rows to protect too (task B4a; a set already on the first case would leave nothing to apply)
  const pw = await d.post('/api/pathways', { slug: 'keep-pathway', title: 'Keep pathway', steps: [{ setId: ks, version: 1 }] });
  assert.equal(pw.status, 201, JSON.stringify(pw.body));
  assert.equal((await adm.post(`/api/pathways/${pw.body.pathway.id}/versions/1/publish`, {})).status, 200);
  const kc2 = await a.post(`/api/patients/${p.body.patient.id}/cases`, { title: 'Keep pathway case' });
  assert.equal(kc2.status, 201);
  assert.equal((await a.post(`/api/cases/${kc2.body.case.id}/applied-pathways`, { pathwayId: pw.body.pathway.id, version: 1 })).status, 201);

  // a signed and amended note: the note tables have rows to protect too (task B3c-1)
  const nt = await a.post(`/api/cases/${kc.body.case.id}/notes`, { body: 'Keep note' });
  assert.equal(nt.status, 201, JSON.stringify(nt.body));
  assert.equal((await a.post(`/api/notes/${nt.body.note.id}/sign`, { rowVersion: 1 })).status, 200);
  assert.equal((await a.post(`/api/notes/${nt.body.note.id}/amend`, { body: 'Keep note, amended', reason: 'Keep reason', amendmentCount: 0 })).status, 201);

  // one context export: the export log has a row to protect too (task B5b)
  assert.equal((await d.get(`/api/cases/${kc.body.case.id}/context`)).status, 200);

  // one imported CCIS run record and one acknowledgement: the run tables have rows to protect too (task DM2a)
  const ex = await exportEnvelope(d, env.pool, kc.body.case.id);
  const run = await d.post(`/api/cases/${kc.body.case.id}/ccis-runs`, runRecord(ex));
  assert.equal(run.status, 201, JSON.stringify(run.body));
  assert.equal((await d.post(`/api/ccis-runs/${run.body.run.id}/ack`, {})).status, 201);

  for (const t of CLINICAL) {
    const n = Number((await env.pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);
    assert.ok(n > 0, `${t} has rows to protect`);
    await assert.rejects(env.pool.query(`DELETE FROM ${t}`), /not allowed/, `DELETE FROM ${t}`);
    await assert.rejects(env.pool.query(`DELETE FROM ${t} WHERE id = (SELECT min(id) FROM ${t})`), /not allowed/, `single-row DELETE FROM ${t}`);
    assert.equal(Number((await env.pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n), n, `${t} unchanged`);
  }
});

test('the audit log also refuses UPDATE and TRUNCATE; a person with history cannot be deleted', async () => {
  await assert.rejects(env.pool.query(`UPDATE audit_log SET action = 'edited'`), /append-only/);
  await assert.rejects(env.pool.query(`UPDATE audit_log SET detail = '{}'::jsonb`), /append-only/);
  await assert.rejects(env.pool.query(`TRUNCATE audit_log`), /append-only/);
  // nurse1 registered a patient and opened an encounter above, so the account is pinned by those rows
  await assert.rejects(env.pool.query(`DELETE FROM users WHERE username = 'nurse1'`), /violates foreign key/);
});

test('patients are archived, not deleted: archive and restore keep the row, who and when', async () => {
  const d = client(env.base); assert.equal((await d.login('doctor1')).status, 200);
  const n = client(env.base); assert.equal((await n.login('nurse1')).status, 200);
  const pid = (await n.post('/api/patients', { name: 'Arch Ive', mrn: 'ARCH-KEEP', dob: '1975-03-03', sex: 'M' })).body.patient.id;
  assert.equal((await d.patch(`/api/patients/${pid}/archive`, { archived: true })).status, 200);
  const row = (await env.pool.query('SELECT archived, archived_at, archived_by FROM patients WHERE id = $1', [pid])).rows[0];
  assert.equal(row.archived, true); assert.ok(row.archived_at); assert.ok(row.archived_by);
  assert.equal((await d.patch(`/api/patients/${pid}/archive`, { archived: false })).status, 200);
  assert.equal((await env.pool.query('SELECT count(*) n FROM patients WHERE id = $1', [pid])).rows[0].n, '1');
});

// Chunk 06c closes the old gap: TRUNCATE is refused by trigger for everyone, and the app's database role cannot delete or alter anything.
test('patients and encounters refuse TRUNCATE even for the owner connection (trigger), like audit_log', async () => {
  // encounters is now also referenced by case_encounters (B1a), and Postgres refuses a referenced table before any trigger runs: still a refusal
  await assert.rejects(env.pool.query('TRUNCATE encounters'), /append-only|cannot truncate a table referenced/);
  await assert.rejects(env.pool.query('TRUNCATE patients, encounters'), /append-only|cannot truncate a table referenced/);
  await assert.rejects(env.pool.query('TRUNCATE patients CASCADE'), /append-only/);
  // patients is also held by a foreign key, which hides its own trigger; drop the FK inside a rolled-back transaction to prove the trigger alone refuses it
  const c = await env.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE encounters DROP CONSTRAINT encounters_patient_id_fkey');
    await c.query('ALTER TABLE clinical_cases DROP CONSTRAINT clinical_cases_patient_id_fkey');   // cases also reference patients (B1a)
    await assert.rejects(c.query('TRUNCATE patients'), /patients is append-only; TRUNCATE is not allowed/);
  } finally { await c.query('ROLLBACK'); }
  try {   // same proof for encounters: drop the case link's foreign key (a failed statement aborts a transaction, so this is a second one)
    await c.query('BEGIN');
    await c.query('ALTER TABLE case_encounters DROP CONSTRAINT case_encounters_encounter_id_patient_id_fkey');
    await assert.rejects(c.query('TRUNCATE encounters'), /encounters is append-only; TRUNCATE is not allowed/);
  } finally { await c.query('ROLLBACK'); c.release(); }
});

test('the server runs as the restricted emr_app role: no DDL, no DELETE, no TRUNCATE on clinical tables', async () => {
  assert.equal((await env.appPool.query('SELECT current_user u')).rows[0].u, 'emr_app');
  const role = (await env.pool.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = 'emr_app'`)).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: false }, 'no login until an operator sets a password');
  const denied = /permission denied|must be owner/;
  const bad = [
    'DROP TABLE patients', 'DROP TABLE audit_log', 'ALTER TABLE patients ADD COLUMN x text', 'ALTER TABLE encounters DROP COLUMN bed',
    'CREATE TABLE sneaky(id int)', 'DROP SCHEMA public CASCADE', 'DROP TRIGGER patients_no_delete ON patients',
    'DELETE FROM patients', 'DELETE FROM encounters', 'DELETE FROM audit_log',
    'TRUNCATE patients', 'TRUNCATE encounters', 'TRUNCATE audit_log', 'TRUNCATE users',
    `UPDATE audit_log SET action = 'x'`, `UPDATE users SET role = 'admin'`, 'DELETE FROM users', 'SELECT * FROM schema_migrations',
    `ALTER TABLE patients DISABLE TRIGGER USER`,
  ];
  for (const q of bad) await assert.rejects(env.appPool.query(q), denied, q);
});

test('the app role still does what the app needs: register, archive, open and close an encounter, sign in, audit', async () => {
  const c = env.appPool;
  const pid = (await c.query(`INSERT INTO patients(mrn, name, dob, sex, created_by) VALUES ('ROLE-1','Role Test','1980-01-01','F',(SELECT id FROM users WHERE username='nurse1')) RETURNING id`)).rows[0].id;
  assert.equal((await c.query('UPDATE patients SET archived = true WHERE id = $1', [pid])).rowCount, 1);
  const eid = (await c.query(`INSERT INTO encounters(patient_id, bed, opened_by) VALUES ($1,'R-1',(SELECT id FROM users WHERE username='nurse1')) RETURNING id`, [pid])).rows[0].id;
  assert.equal((await c.query(`UPDATE encounters SET status = 'closed' WHERE id = $1`, [eid])).rowCount, 1);
  await c.query(`INSERT INTO audit_log(action) VALUES ('role.check')`);
  assert.equal((await c.query('SELECT count(*) n FROM audit_log')).rows.length, 1);
});

test('guard for later migrations: the app role never gets DELETE or TRUNCATE on a table other than sessions', async () => {
  const tables = (await env.pool.query(`SELECT table_name t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map(r => r.t);
  assert.ok(tables.includes('patients') && tables.length >= 6);
  for (const t of tables.filter(t => t !== 'sessions')) {
    for (const priv of ['DELETE', 'TRUNCATE']) {
      assert.equal((await env.pool.query(`SELECT has_table_privilege('emr_app', $1, $2) ok`, [t, priv])).rows[0].ok, false, `${priv} on ${t}`);
    }
  }
});

// ---------- page: notes ----------
const HTML = require('./html').pageHtml();
function page() {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.confirm = () => true; w.fetch = async () => new Response('{}', { status: 401 }); } });
  const w = dom.window, d = w.document;
  return { w, d, errors, $: id => d.getElementById(id),
    notes: () => JSON.parse(JSON.stringify(w.eval('CASE.notes'))),
    note: id => JSON.parse(JSON.stringify(w.eval(`CASE.notes.find(n=>n.id==='${id}')`))) };
}
// The signer comes from the signed-in session (Srv.user, filled by /api/me or login). Tests set that directly.
const signIn = (p, name) => p.w.eval(name ? `Srv.user = { username: ${JSON.stringify(name)}, role: 'doctor', perms: [] }` : 'Srv.user = null');
function draft(p, who, body) {
  signIn(p, who); p.$('n_title').value = 'Round note'; p.$('n_body').value = body;
  p.w.addNote('free');
  return p.notes()[0].id;
}

test('local drafts: a signed-out page keeps editable drafts and refuses to sign or amend; a legacy signed note cannot be edited, discarded or re-signed', () => {
  const p = page();
  assert.deepEqual(p.errors, []);
  const id = draft(p, null, 'Plan A');
  assert.equal(p.note(id).status, 'draft');
  p.w.editNote(id, 'Plan A, edited while a draft');                    // local drafts may change
  assert.equal(p.note(id).body, 'Plan A, edited while a draft');
  p.w.signNote(id);                                                     // signing exists only on the server (B3c-2): nobody is signed in here
  assert.equal(p.note(id).status, 'draft'); assert.equal(p.note(id).signedBy, undefined);

  // a signed note from older demo data in the browser: the page cannot change it
  p.w.eval(`CASE.notes.unshift({id:'n_old',kind:'free',title:'Old',body:'Signed long ago',status:'signed',signedBy:'old user',signedAt:'2026-01-01T00:00:00.000Z',createdAt:'2026-01-01T00:00:00.000Z',amendments:[]})`);
  p.w.renderNotes();
  assert.doesNotMatch(p.$('noteList').innerHTML, /<textarea[^>]*>Signed long ago/, 'the text of a signed note is not editable in the page');
  p.w.editNote('n_old', 'TAMPERED'); p.w.discardNote('n_old'); p.w.signNote('n_old');
  assert.deepEqual(p.note('n_old'), { id: 'n_old', kind: 'free', title: 'Old', body: 'Signed long ago', status: 'signed', signedBy: 'old user', signedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', amendments: [] });
  p.w.toggleAmend('n_old');
  p.$('am_r_n_old').value = 'Reason'; p.$('am_b_n_old').value = 'New text'; p.w.submitAmend('n_old');
  assert.equal(p.note('n_old').amendments.length, 0, 'no amendment without a sign-in');
  // a drafted note signed in with a made-up session and no server case is not signed either: only the server signs
  signIn(p, 'doctor1'); p.w.signNote(id); p.w.submitAmend('n_old');
  assert.equal(p.note(id).status, 'draft'); assert.equal(p.note('n_old').amendments.length, 0);
});

test('notes are never removed: discarded local drafts stay in the list, marked discarded', async () => {
  const p = page();
  const ids = [];
  // note ids are built from the clock (to the millisecond), so create them a few ms apart
  for (const t of ['one', 'two', 'three']) { ids.push(draft(p, null, 'Body ' + t)); await new Promise(r => setTimeout(r, 5)); }
  assert.equal(new Set(ids).size, 3);
  p.w.discardNote(ids[1]);
  const notes = p.notes();
  assert.equal(notes.length, 3, 'no note disappeared');
  assert.deepEqual(notes.map(n => n.status).sort(), ['discarded', 'draft', 'draft']);
  assert.ok(notes.find(n => n.status === 'discarded').discardedAt);
  // survives a reload (localStorage round trip). Since B1b-1 a signed-in page never writes vr_traj; this page is signed out.
  p.w.save();
  const saved = JSON.parse(p.w.localStorage.getItem('vr_traj'));
  assert.equal(saved.cases.reduce((n, c) => n + c.notes.length, 0), 3);
});

test('the page contains no code that removes notes or cases', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'emr-enhancer.html'), 'utf8');
  const forbidden = [
    /\.notes\s*\.\s*(splice|pop|shift)\s*\(/, /\.notes\s*=\s*[^;\n]*\.filter\s*\(/, /delete\s+[\w.\[\]'"]*notes/,
    /\bCASES\s*\.\s*(splice|pop|shift)\s*\(/, /\bCASES\s*=\s*CASES\s*\.\s*filter/, /delete\s+CASES\b/,
    /localStorage\s*\.\s*(clear\s*\(|removeItem\s*\(\s*['"]vr_traj['"])/,
  ];
  for (const re of forbidden) assert.ok(!re.test(src), 'found ' + re);
});

// Known gaps, found while writing this pack. They are real departures from the core rules, kept visible here:
// ---------- chunk 8e: signer, author and amender come from the session ----------
test('no typed field or stored name can become the signer; without a sign-in, signing and amending are refused', () => {
  const p = page();
  assert.deepEqual(p.errors, []);
  assert.equal(p.$('n_user'), null, 'the typed "Signing as" box is gone');
  assert.doesNotMatch(HTML, /getElementById\(['"]n_user['"]\)|\$\(['"]n_user['"]\)/, 'no code reads a typed signer field');
  // hostile attempts: a stray input with the old id, and the old localStorage key
  const evil = p.d.createElement('input'); evil.id = 'n_user'; evil.value = 'Evil Typed'; p.d.body.appendChild(evil);
  p.w.localStorage.setItem('vr_user', 'Evil Stored');

  signIn(p, null);                                           // nobody signed in
  p.$('n_title').value = 'T'; p.$('n_body').value = 'Plan A'; p.w.addNote('free');
  const id = p.notes()[0].id;
  p.w.renderNotes();
  assert.match(p.$('n_who').textContent, /Not signed in/);
  assert.ok(p.d.querySelector('[data-act="signNote"]').disabled, 'Sign button is disabled when nobody is signed in');
  p.w.signNote(id);
  assert.equal(p.note(id).status, 'draft', 'signing is refused without a session');

  signIn(p, 'doctor1');
  p.w.renderNotes();
  assert.match(p.$('n_who').textContent, /doctor1/);
  assert.doesNotMatch(HTML, /signedBy\s*=\s*(user\(\)|Srv)|\.by\s*=\s*user\(\)|by:\s*user\(\)/, 'the page never writes a signer or amender into a note itself: the server sets both (B3c-2)');
  assert.doesNotMatch(JSON.stringify(p.note(id)), /Evil|doctor1/);
  assert.match(p.w.eval('String(user)'), /Srv\.user/);
  signIn(p, null);
  assert.equal(p.w.eval('user()'), '', 'no session, no name');
});

test('sign-in through /api/me fills the signer; an old stored name is purged on load', async () => {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.confirm = () => true;
      w.localStorage.setItem('vr_user', 'Evil Stored');
      const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
      // never 401 after sign-in: a 401 means "session expired" and clears the user
      w.fetch = async (u) => String(u).endsWith('/api/me') ? json({ user: { username: 'nurse1', role: 'nurse', perms: [] } })
        : String(u).endsWith('/api/ai/status') ? json({ ai: { enabled: false, configured: false, canUse: false, model: '', provider: '', hourlyLimit: 0, usedThisHour: 0 } })
        : json({});
    } });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(errors, []);
  assert.equal(w.localStorage.getItem('vr_user'), null, 'the stored typed name is removed');
  assert.equal(w.eval('user()'), 'nurse1');
  assert.match(w.document.getElementById('n_who').textContent, /nurse1 \(nurse\)/);
});
// ---------- chunk 8f: observation rows are marked entered in error, never removed ----------
test('a wrong observation row is marked entered in error (who, when) and stays stored, shown struck through, and exported', () => {
  const p = page();
  assert.deepEqual(p.errors, []);
  const set = { id: 'rep_set', kind: 'care', title: 'Rep set', desc: '', custom: true, version: 1, fields: [{ id: 'rr', label: 'Rate', type: 'number', unit: 'n', repeat: true }] };
  p.w.eval(`REGISTRY.push(${JSON.stringify(set)});applySet('rep_set')`);
  for (const v of ['10', '20', '30']) p.w.addRow('rr', v);                  // newest first: 30, 20, 10
  const raw = () => JSON.parse(JSON.stringify(p.w.eval("CASE.values['rr']")));
  const stored = () => JSON.parse(p.w.localStorage.getItem('vr_traj')).cases.flatMap(c => c.values.rr || []);
  assert.deepEqual(raw().map(r => r.value), ['30', '20', '10']);
  const idx = raw().findIndex(r => r.value === '20');

  signIn(p, null); p.w.renderForms();                                      // no session: refused, button disabled
  assert.ok(p.d.querySelector('#forms [data-act="markRowError"]').disabled);
  p.w.markRowError('rr', idx);
  assert.equal(raw()[idx].status, undefined);

  signIn(p, 'doctor1'); p.w.renderForms();
  p.w.markRowError('rr', idx);
  let r = raw();
  assert.equal(r.length, 3, 'the row is still stored');
  assert.equal(r[idx].status, 'entered_in_error'); assert.equal(r[idx].value, '20');
  assert.equal(r[idx].errorBy, 'doctor1', 'who comes from the session'); assert.ok(r[idx].errorAt);
  assert.equal(stored().length, 3, 'and still saved in browser storage');

  // hidden by default; shown struck through on request; the other rows still have their buttons
  const forms = () => p.$('forms').innerHTML;
  assert.doesNotMatch(forms(), /<td>20<\/td>/); assert.doesNotMatch(forms(), /<s>20<\/s>/);
  assert.match(forms(), /Show 1 entered in error/);
  const box = p.d.querySelector('#forms [data-act="toggleShowErr"]'); box.checked = true; box.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.match(forms(), /<s>20<\/s>/); assert.match(forms(), /entered in error · doctor1/);
  assert.equal(p.d.querySelectorAll('#forms [data-act="markRowError"]').length, 2, 'only rows not in error can be marked');

  // marking again by someone else does not rewrite who or when
  const when = r[idx].errorAt; signIn(p, 'someone'); p.w.markRowError('rr', idx);
  assert.equal(raw()[idx].errorBy, 'doctor1'); assert.equal(raw()[idx].errorAt, when);

  // rows in error are left out of the working views (snapshot note) ...
  assert.doesNotMatch(p.w.eval('snapshotText()'), /\b20 @/);   // the value 20 (not the year in the time stamp)
  assert.match(p.w.eval('snapshotText()'), /30 @.*10 @/);
  assert.deepEqual(JSON.parse(JSON.stringify(p.w.eval("getRows('rr')"))).map(x => x.value), ['30', '10']);
  // ... but kept in the FHIR export, as entered-in-error with a note
  p.w.buildBundle();
  const obs = JSON.parse(p.$('bj').textContent).entry.map(e => e.resource).filter(x => x.resourceType === 'Observation');
  assert.equal(obs.length, 3);
  const bad = obs.filter(o => o.status === 'entered-in-error');
  assert.equal(bad.length, 1); assert.equal(bad[0].valueQuantity.value, 20); assert.match(bad[0].note[0].text, /doctor1/);
  assert.equal(obs.filter(o => o.status === 'final').length, 2);

  // nothing in the page removes a row any more
  assert.doesNotMatch(HTML, /function delRow|rows\.splice|data-act="delRow"/);
});
test('server-side: a signed note cannot be changed by any route or by the app\'s own database role; an amendment keeps the original and the reason (task B3c-1)', async () => {
  const n = client(env.base); assert.equal((await n.login('nurse1')).status, 200);
  const d = client(env.base); assert.equal((await d.login('doctor1')).status, 200);
  const pid = (await n.post('/api/patients', { name: 'Signed Note', mrn: 'SIGNED-1', dob: '1980-01-01', sex: 'F' })).body.patient.id;
  const cid = (await n.post(`/api/patients/${pid}/cases`, { title: 'Signed case' })).body.case.id;
  const note = (await n.post(`/api/cases/${cid}/notes`, { body: 'Original signed text' })).body.note;
  assert.equal((await n.post(`/api/notes/${note.id}/sign`, { rowVersion: 1 })).status, 200);
  // no route edits, re-signs or discards it, for the author or for anyone else
  for (const c of [n, d]) {
    assert.notEqual((await c.patch(`/api/notes/${note.id}`, { body: 'changed', rowVersion: 2 })).status, 200);
    assert.notEqual((await c.post(`/api/notes/${note.id}/sign`, { rowVersion: 2 })).status, 200);
    assert.notEqual((await c.post(`/api/notes/${note.id}/discard`, { rowVersion: 2 })).status, 200);
  }
  // the database refuses it too, for the owner and for the restricted app role
  await assert.rejects(env.pool.query(`UPDATE case_notes SET body = 'changed' WHERE id = $1`, [note.id]), /cannot be changed/);
  await assert.rejects(env.appPool.query(`UPDATE case_notes SET body = 'changed' WHERE id = $1`, [note.id]), /cannot be changed|permission denied/);
  // an amendment needs a reason, is by the session user, and leaves the original text in place
  assert.equal((await d.post(`/api/notes/${note.id}/amend`, { body: 'Amended text', amendmentCount: 0 })).status, 400);
  const am = await d.post(`/api/notes/${note.id}/amend`, { body: 'Amended text', reason: 'Unit corrected', amendmentCount: 0 });
  assert.equal(am.status, 201);
  const r = (await env.pool.query('SELECT n.body, n.status, m.body AS amended, m.reason, u.username FROM case_notes n JOIN case_note_amendments m ON m.note_id = n.id JOIN users u ON u.id = m.amended_by WHERE n.id = $1', [note.id])).rows[0];
  assert.deepEqual(r, { body: 'Original signed text', status: 'signed', amended: 'Amended text', reason: 'Unit corrected', username: 'doctor1' });
});
