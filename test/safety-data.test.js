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

let env;
test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

// ---------- database ----------
// Every table must be listed here. A new table fails this test until someone decides which kind it is.
const CLINICAL = ['patients', 'encounters', 'audit_log', 'clinical_cases', 'case_encounters', 'case_narrative_entries', 'element_sets', 'element_set_versions', 'element_set_reviews'];        // never deleted: rows are archived, closed, appended or retired
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

test('a signed note cannot be edited, re-signed or discarded; only amended, with a reason', () => {
  const p = page();
  assert.deepEqual(p.errors, []);
  const id = draft(p, 'Dr Real', 'Plan A');
  assert.equal(p.note(id).status, 'draft');

  p.w.editNote(id, 'Plan A, edited while a draft');                    // drafts may change
  assert.equal(p.note(id).body, 'Plan A, edited while a draft');

  p.w.signNote(id);
  const signed = p.note(id);
  assert.equal(signed.status, 'signed'); assert.equal(signed.signedBy, 'Dr Real'); assert.ok(signed.signedAt);

  p.w.editNote(id, 'TAMPERED');                                          // no longer editable
  assert.equal(p.note(id).body, 'Plan A, edited while a draft');

  p.w.discardNote(id);                                                   // cannot be discarded either (confirm() says yes)
  assert.equal(p.note(id).status, 'signed');

  signIn(p, 'Someone Else'); p.w.signNote(id);                // cannot be re-signed by another name or time
  assert.equal(p.note(id).signedBy, 'Dr Real'); assert.equal(p.note(id).signedAt, signed.signedAt);

  // the text area of a signed note is not editable in the page at all
  assert.doesNotMatch(p.$('noteList').innerHTML, /<textarea onchange="editNote/);

  // amendments: need a reason, need a name, need a change
  p.w.toggleAmend(id);
  const setForm = (reason, text) => { p.$('am_r_' + id).value = reason; p.$('am_b_' + id).value = text; };
  setForm('', 'Plan B'); p.w.submitAmend(id);
  assert.equal(p.note(id).amendments.length, 0, 'no reason, no amendment');
  setForm('Dose corrected', 'Plan A, edited while a draft'); p.w.submitAmend(id);
  assert.equal(p.note(id).amendments.length, 0, 'unchanged text is not an amendment');
  signIn(p, null); setForm('Dose corrected', 'Plan B'); p.w.submitAmend(id);
  assert.equal(p.note(id).amendments.length, 0, 'not signed in, no amendment');

  signIn(p, 'Dr Amend'); setForm('Dose corrected', 'Plan B'); p.w.submitAmend(id);
  let n = p.note(id);
  assert.equal(n.amendments.length, 1);
  assert.equal(n.amendments[0].reason, 'Dose corrected'); assert.equal(n.amendments[0].by, 'Dr Amend');
  assert.equal(n.body, 'Plan A, edited while a draft', 'the text as signed is kept');
  assert.equal(p.w.eval(`noteCurrent(CASE.notes.find(n=>n.id==='${id}'))`), 'Plan B');
  assert.match(p.$('noteList').textContent, /Original \(as signed\)/);

  p.w.toggleAmend(id); setForm('Second fix', 'Plan C'); p.w.submitAmend(id);
  n = p.note(id);
  assert.equal(n.amendments.length, 2); assert.equal(n.amendments[0].body, 'Plan B', 'earlier amendments are kept');
  assert.equal(n.body, 'Plan A, edited while a draft');
  assert.equal(n.signedBy, 'Dr Real');
});

test('notes are never removed: discarded drafts stay in the list, marked discarded', async () => {
  const p = page();
  const ids = [];
  // note ids are built from the clock (to the millisecond), so create them a few ms apart
  for (const t of ['one', 'two', 'three']) { ids.push(draft(p, 'Dr Real', 'Body ' + t)); await new Promise(r => setTimeout(r, 5)); }
  assert.equal(new Set(ids).size, 3);
  p.w.signNote(ids[0]);
  p.w.discardNote(ids[1]);
  const notes = p.notes();
  assert.equal(notes.length, 3, 'no note disappeared');
  assert.deepEqual(notes.map(n => n.status).sort(), ['discarded', 'draft', 'signed']);
  assert.ok(notes.find(n => n.status === 'discarded').discardedAt);
  // survives a reload (localStorage round trip). Since B1b-1 a signed-in page never writes vr_traj, so go back to demo mode first.
  signIn(p, null); p.w.save();
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
  p.w.signNote(id);
  assert.equal(p.note(id).signedBy, 'doctor1', 'the signer is the session user, not the typed or stored name');
  assert.doesNotMatch(JSON.stringify(p.note(id)), /Evil/);

  p.w.toggleAmend(id);
  p.$('am_r_' + id).value = 'Fix'; p.$('am_b_' + id).value = 'Plan B'; p.w.submitAmend(id);
  assert.equal(p.note(id).amendments[0].by, 'doctor1', 'the amender is the session user');
  // the FHIR export author is also the session user
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
test.todo('server-side: signed notes are immutable on the server (notes live in the browser until a later chunk stores them there)');
