'use strict';
// node --test patients.test.js  (needs DATABASE_URL; creates and drops its own database)
// Chunk 34a: patients, duplicate warning, merge, encounters and linking a case. Real login sessions and the restricted emr_app database role, as in users.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');
const { Client } = require('pg');
const { createDb, migrate, createApp } = require('./server.js');
const { hashPassword } = require('./auth.js');
const { mrnFor, mrnValid } = require('./patients.js');
const P = require('./permissions.js');

try { fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (_) {}
const base = new URL(process.env.DATABASE_URL || 'postgres://x@127.0.0.1/x');
const dbName = 'emr_pat_' + crypto.randomBytes(4).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const withDb = (n) => { const u = new URL(base); u.pathname = '/' + n; return u.toString(); };
const PW = 'correct horse battery';
let owner, appDb, app, hash;
const who = {};

async function mk(role) {
  const id = (await owner.query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', ['p_' + role, 'Name ' + role, role, hash])).rows[0].id;
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/login').send({ username: 'p_' + role, password: PW })).status, 200);
  agent.set('x-csrf-token', (await agent.get('/api/csrf')).body.token);
  return { id, agent };
}
const maxId = async () => Number((await owner.query('SELECT coalesce(max(id),0) m FROM audit_log')).rows[0].m);
const since = async (id) => (await owner.query("SELECT * FROM audit_log WHERE id > $1 AND action NOT LIKE 'auth.%' ORDER BY id", [id])).rows;
let seq = 0;
const reg = async (extra = {}, as = 'doctor') => (await who[as].agent.post('/api/patients').send({ name: 'Person Number' + (++seq) + ' Test', sex: 'female', dateOfBirth: '1980-05-17', ...extra }));
const mkPatient = async (extra = {}) => { const r = await reg(extra); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };

test.before(async () => {
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`CREATE DATABASE ${dbName}`); await a.end();
  owner = createDb(withDb(dbName)); await migrate(owner, __dirname);
  await owner.query(`ALTER ROLE emr_app LOGIN PASSWORD '${appPw}'`);
  const u = new URL(withDb(dbName)); u.username = 'emr_app'; u.password = appPw;
  appDb = createDb(u.toString());
  app = createApp({ db: appDb });
  hash = await hashPassword(PW);
  for (const role of P.ROLES) who[role] = await mk(role);
});
test.after(async () => {
  if (appDb) await appDb.close();
  if (owner) { await owner.query('ALTER ROLE emr_app NOLOGIN PASSWORD NULL'); await owner.close(); }
  const a = new Client({ connectionString: withDb('postgres') });
  await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a.end();
});

test('MRN: 7 digits from the sequence plus a Luhn check digit; any single wrong digit is detected', () => {
  const m = mrnFor(1000000);
  assert.match(m, /^\d{8}$/); assert.ok(mrnValid(m)); assert.ok(mrnValid(mrnFor(9999999)));
  for (let i = 0; i < 8; i++) for (let d = 0; d <= 9; d++) { if (String(d) === m[i]) continue; assert.equal(mrnValid(m.slice(0, i) + d + m.slice(i + 1)), false, `position ${i} -> ${d}`); }
  assert.equal(mrnValid('1234'), false); assert.equal(mrnValid('M-aud'), false);
});

test('roles: nurse, doctor and admin register; viewer and informatician cannot; an informatician cannot even search; a viewer can read', async () => {
  for (const role of ['viewer', 'informatician']) {
    const r = await who[role].agent.post('/api/patients').send({ name: 'No Way', sex: 'male', dateOfBirth: '1990-01-01' });
    assert.equal(r.status, 403); assert.equal(r.body.error.action, 'patient.write');
  }
  assert.equal((await who.informatician.agent.get('/api/patients?q=Person')).status, 403);
  assert.equal((await who.viewer.agent.get('/api/patients?q=Person')).status, 200);
  for (const role of ['nurse', 'doctor', 'admin']) assert.equal((await reg({}, role)).status, 201, role);
  assert.equal((await request(app).post('/api/patients').send({})).status, 401);
});

test('create: server makes the MRN (a client MRN is refused), the session user is the creator, validation is strict', async () => {
  const before = await maxId(), r = await reg({ phone: '+91 98200 11111', nationalId: 'AB-1234' }, 'nurse');
  assert.equal(r.status, 201); assert.ok(mrnValid(r.body.mrn)); assert.equal(r.body.sex, 'female'); assert.equal(r.body.dateOfBirth, '1980-05-17'); assert.equal(r.body.ageEstimated, false);
  assert.equal(r.body.version, 1); assert.equal(r.body.nationalId, 'AB-1234'); assert.equal(r.body.active, true);
  assert.equal((await owner.query('SELECT created_by FROM patients WHERE id=$1', [r.body.id])).rows[0].created_by, who.nurse.id);
  const rows = await since(before);
  assert.equal(rows.length, 1); assert.equal(rows[0].action, 'patient.create'); assert.equal(rows[0].user_id, who.nurse.id); assert.equal(rows[0].patient_id, r.body.id);
  assert.ok(!JSON.stringify(rows[0]).includes('AB-1234'), 'the national id is never written to the audit log'); assert.equal(rows[0].after.nationalIdSet, true);
  const bad = async (body, re) => { const x = await who.doctor.agent.post('/api/patients').send({ name: 'Valid Name', sex: 'male', dateOfBirth: '1990-01-01', ...body }); assert.equal(x.status, 400, JSON.stringify(body)); assert.match(x.body.error.message, re); };
  await bad({ mrn: '12345678' }, /mrn/i);
  await bad({ dateOfBirth: '2999-01-01' }, /not a real date/); await bad({ dateOfBirth: '1990-02-30' }, /not a real date/);
  await bad({ ageYears: 40 }, /not both/); await bad({ phone: 'call me' }, /digits/); await bad({ sex: 'robot' }, /sex/); await bad({ name: 'A' }, /name/);
  const none = await who.doctor.agent.post('/api/patients').send({ name: 'Valid Name', sex: 'male' }); assert.equal(none.status, 400);
  const est = await who.doctor.agent.post('/api/patients').send({ name: 'Estimated Age Person', sex: 'unknown', ageYears: 30 });
  assert.equal(est.status, 201); assert.equal(est.body.ageEstimated, true);
  const yr = +est.body.dateOfBirth.slice(0, 4), now = new Date().getUTCFullYear(); assert.ok(yr === now - 30 || yr === now - 31, 'about 30 years ago');
});

test('duplicate warning: same name and birth date, or same phone, gives 409 with candidates until confirmDifferent is sent', async () => {
  const a = await mkPatient({ name: 'Asha Kumari', dateOfBirth: '1975-03-02', phone: '+91 98200 55555' });
  const same = await reg({ name: '  ASHA   kumari ', dateOfBirth: '1975-03-02' });
  assert.equal(same.status, 409); assert.equal(same.body.error.code, 'possible_duplicate');
  assert.equal(same.body.candidates.length, 1); assert.equal(same.body.candidates[0].id, a.id); assert.deepEqual(same.body.candidates[0].matchedOn, ['name_and_birth']);
  assert.equal(same.body.candidates[0].phone, undefined, 'a candidate shows who, not a phone number');
  const ph = await reg({ name: 'Someone Else Entirely', dateOfBirth: '2001-01-01', phone: '9820055555' });                // same digits as '+91 98200 55555'? no: country code differs
  assert.equal(ph.status, 201, 'different digits (no 91 prefix) are a different phone');
  const ph2 = await reg({ name: 'Another Person Here', dateOfBirth: '2001-01-01', phone: '(+91) 98200-55555' });
  assert.equal(ph2.status, 409); assert.deepEqual(ph2.body.candidates[0].matchedOn, ['phone']);
  assert.equal((await reg({ name: 'Short Phone Person', dateOfBirth: '2001-01-01', phone: '12345' })).status, 201);
  assert.equal((await reg({ name: 'Short Phone Person2', dateOfBirth: '2001-01-01', phone: '12345' })).status, 201, 'under 6 digits is not a match key');
  assert.equal((await reg({ name: 'Asha Kumari', dateOfBirth: '1975-03-03' })).status, 201, 'same name, different birth date: not a duplicate');
  const est = await reg({ name: 'Asha Kumari', dateOfBirth: undefined, ageYears: new Date().getUTCFullYear() - 1976 });
  assert.equal(est.status, 409, 'an estimated age within two years of a known birth year is flagged'); assert.ok(est.body.candidates.some((c) => c.id === a.id));
  const before = await maxId(), ok = await reg({ name: 'Asha Kumari', dateOfBirth: '1975-03-02', confirmDifferent: true });
  assert.equal(ok.status, 201); assert.notEqual(ok.body.id, a.id); assert.notEqual(ok.body.mrn, a.mrn);
  const rows = await since(before); assert.equal(rows.length, 1); assert.ok(rows[0].after.confirmedDifferentFrom.includes(a.id));
});

test('simultaneous registrations of the same person: exactly one succeeds, the rest get the duplicate warning', async () => {
  const body = { name: 'Race Condition Person', sex: 'male', dateOfBirth: '1966-06-06' };
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => [who.doctor, who.nurse, who.admin][i % 3].agent.post('/api/patients').send(body)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join());
  assert.equal(rs.filter((r) => r.status === 409 && r.body.error.code === 'possible_duplicate').length, 7);
  assert.equal((await owner.query("SELECT count(*)::int n FROM patients WHERE name='Race Condition Person'")).rows[0].n, 1);
});

test('MRN is unique and valid under many simultaneous registrations of different people', async () => {
  const rs = await Promise.all(Array.from({ length: 24 }, (_, i) => who[['doctor', 'nurse', 'admin'][i % 3]].agent.post('/api/patients').send({ name: 'Concurrent Mrn Person ' + i, sex: 'other', dateOfBirth: '1970-01-01' })));
  assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join());
  const mrns = rs.map((r) => r.body.mrn); assert.equal(new Set(mrns).size, 24); assert.ok(mrns.every(mrnValid));
  assert.equal((await owner.query("SELECT count(DISTINCT mrn)::int n FROM patients")).rows[0].n, (await owner.query('SELECT count(*)::int n FROM patients')).rows[0].n);
});

test('search and read: name part, MRN prefix, phone digits; lists carry no phone or national id; the national id is shown to staff who can register, not to a viewer', async () => {
  const p = await mkPatient({ name: 'Searchable Zebra', phone: '+977 9841 234567', nationalId: 'NID-777' });
  const names = async (q) => (await who.nurse.agent.get('/api/patients').query({ q })).body.map((x) => x.id);
  assert.ok((await names('zebra')).includes(p.id)); assert.ok((await names(p.mrn.slice(0, 7))).includes(p.id)); assert.deepEqual((await names(p.mrn))[0], p.id);
  assert.ok((await names('9841 234')).includes(p.id), 'phone digits');
  assert.equal((await who.nurse.agent.get('/api/patients?q=z')).status, 400, 'at least 2 characters');
  assert.equal((await who.nurse.agent.get('/api/patients?q=%25%25')).status, 200, 'percent signs are plain text, not wildcards');
  const list = (await who.nurse.agent.get('/api/patients').query({ q: 'Searchable Zebra' })).body[0];
  assert.equal(list.phone, undefined); assert.equal(list.nationalId, undefined); assert.equal(list.hasNationalId, true);
  const nurse = (await who.nurse.agent.get('/api/patients/' + p.id)).body, viewer = (await who.viewer.agent.get('/api/patients/' + p.id)).body;
  assert.equal(nurse.nationalId, 'NID-777'); assert.equal(nurse.phone, '+977 9841 234567');
  assert.equal(viewer.nationalId, undefined); assert.equal(viewer.hasNationalId, true);
  assert.equal((await who.nurse.agent.get('/api/patients/00000000-0000-4000-8000-000000000000')).status, 404); assert.equal((await who.nurse.agent.get('/api/patients/not-a-uuid')).status, 404);
  const v = await maxId(); await who.doctor.agent.get('/api/patients/' + p.id); await who.doctor.agent.get('/api/patients/' + p.id);
  const views = (await since(v)).filter((x) => x.action === 'view' && x.entity === 'patient'); assert.equal(views.length, 1, 'one view row per user per patient per 10 minutes'); assert.equal(views[0].patient_id, p.id);
});

test('correct a patient: reason required, stale version is a 409 with current, before/after audited, a national id never reaches the audit log', async () => {
  const p = await mkPatient({ name: 'Typo Persn', phone: '5551234' });
  const put = (body, as = 'nurse') => who[as].agent.patch('/api/patients/' + p.id).send(body);
  assert.equal((await put({ expectedVersion: 1, name: 'Typo Person' })).status, 400, 'no reason');
  assert.equal((await put({ expectedVersion: 1, reason: 'ab' })).status, 400, 'nothing to change / reason too short');
  const before = await maxId(), ok = await put({ expectedVersion: 1, reason: 'spelling corrected from ID card', name: 'Typo Person', nationalId: 'SECRET-ID-99', dateOfBirth: '1981-02-03' });
  assert.equal(ok.status, 200); assert.equal(ok.body.name, 'Typo Person'); assert.equal(ok.body.version, 2); assert.equal(ok.body.ageEstimated, false);
  const rows = await since(before); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'patient.update'); assert.equal(rows[0].reason, 'spelling corrected from ID card');
  assert.equal(rows[0].before.name, 'Typo Persn'); assert.equal(rows[0].after.name, 'Typo Person'); assert.equal(rows[0].after.nationalIdChanged, true); assert.ok(!JSON.stringify(rows[0]).includes('SECRET-ID-99'));
  const stale = await put({ expectedVersion: 1, reason: 'second editor', phone: '5559999' });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'conflict'); assert.equal(stale.body.current.version, 2); assert.equal(stale.body.current.name, 'Typo Person');
  assert.equal((await put({ expectedVersion: 2, reason: 'phone removed', phone: null })).status, 200);
  assert.equal((await put({ expectedVersion: 3, reason: 'estimate', ageYears: 45 })).body.ageEstimated, true);
  assert.equal((await put({ expectedVersion: 4, reason: 'not allowed', name: 'Viewer Edit' }, 'viewer')).status, 403);
});

test('merge: admin only, nothing is deleted or moved, kept record lists the duplicate\'s encounters, merged records are hidden from search and take no new work, unmerge undoes it', async () => {
  const keep = await mkPatient({ name: 'Keep Me Record' }), dup = await mkPatient({ name: 'Dup Me Record' });
  const enc = (await who.nurse.agent.post(`/api/patients/${dup.id}/encounters`).send({ type: 'admission', ward: 'MW', bed: 'M1' })).body;
  const cs = (await who.doctor.agent.post('/api/cases').send({})).body;
  assert.equal((await who.doctor.agent.post(`/api/cases/${cs.id}/link`).send({ expectedVersion: cs.version, patientId: dup.id, encounterId: enc.id })).status, 200);
  const counts = async () => (await owner.query('SELECT (SELECT count(*) FROM patients)::int p, (SELECT count(*) FROM encounters)::int e, (SELECT count(*) FROM cases)::int c')).rows[0];
  const c0 = await counts(), url = `/api/patients/${dup.id}/merge`;
  for (const role of ['doctor', 'nurse', 'viewer', 'informatician']) assert.equal((await who[role].agent.post(url).send({ intoPatientId: keep.id, reason: 'duplicate' })).status, 403, role);
  assert.equal((await who.admin.agent.post(url).send({ intoPatientId: dup.id, reason: 'duplicate' })).status, 400, 'into itself');
  assert.equal((await who.admin.agent.post(url).send({ intoPatientId: keep.id, reason: 'x' })).status, 400, 'reason needed');
  assert.equal((await who.admin.agent.post(url).send({ intoPatientId: '00000000-0000-4000-8000-000000000000', reason: 'duplicate' })).status, 422);
  const before = await maxId(), m = await who.admin.agent.post(url).send({ intoPatientId: keep.id, reason: 'same person registered twice' });
  assert.equal(m.status, 200); assert.equal(m.body.mergedInto, keep.id); assert.equal(m.body.active, false);
  assert.deepEqual(await counts(), c0, 'nothing deleted');
  const rows = await since(before); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'patient.merge'); assert.equal(rows[0].reason, 'same person registered twice');
  assert.equal(rows[0].after.casesLeftOnDuplicate, 1); assert.equal(rows[0].after.encountersLeftOnDuplicate, 1);
  assert.equal((await owner.query('SELECT patient_id FROM cases WHERE id=$1', [cs.id])).rows[0].patient_id, dup.id, 'the chart stays where it was; reads follow the pointer');
  assert.equal((await who.nurse.agent.get('/api/patients').query({ q: 'Dup Me Record' })).body.length, 0, 'hidden from search');
  assert.equal((await who.nurse.agent.get('/api/patients/' + dup.id)).body.mergedInto, keep.id, 'opening the duplicate says where to go');
  const list = (await who.nurse.agent.get(`/api/patients/${keep.id}/encounters`)).body; assert.equal(list.length, 1); assert.equal(list[0].fromMergedPatient, true);
  assert.equal((await who.nurse.agent.post(`/api/patients/${dup.id}/encounters`).send({ type: 'OPD' })).body.error.code, 'patient_merged');
  assert.equal((await who.nurse.agent.patch('/api/patients/' + dup.id).send({ expectedVersion: 2, reason: 'edit merged', name: 'Nope Nope' })).body.error.code, 'patient_merged');
  const c1 = (await who.doctor.agent.post('/api/cases').send({})).body;
  assert.equal((await who.doctor.agent.post(`/api/cases/${c1.id}/link`).send({ expectedVersion: c1.version, patientId: dup.id })).body.error.code, 'patient_merged');
  assert.equal((await who.admin.agent.post(url).send({ intoPatientId: keep.id, reason: 'again' })).body.error.code, 'already_merged');
  const third = await mkPatient({ name: 'Third Record' });
  assert.equal((await who.admin.agent.post(`/api/patients/${third.id}/merge`).send({ intoPatientId: dup.id, reason: 'into a merged record' })).body.error.code, 'target_unusable');
  assert.equal((await who.doctor.agent.post(`/api/patients/${dup.id}/unmerge`).send({ reason: 'mistake' })).status, 403);
  const un = await who.admin.agent.post(`/api/patients/${dup.id}/unmerge`).send({ reason: 'merged by mistake' });
  assert.equal(un.status, 200); assert.equal(un.body.active, true); assert.equal(un.body.mergedInto, null);
  assert.equal((await who.admin.agent.post(`/api/patients/${dup.id}/unmerge`).send({ reason: 'again' })).body.error.code, 'not_merged');
  assert.equal((await who.nurse.agent.get('/api/patients').query({ q: 'Dup Me Record' })).body.length, 1, 'visible again');
});

test('merge race: A into B and B into A at the same time, exactly one wins and no loop is created', async () => {
  const a = await mkPatient({ name: 'Loop Alpha Record' }), b = await mkPatient({ name: 'Loop Beta Record' });
  const rs = await Promise.all([who.admin.agent.post(`/api/patients/${a.id}/merge`).send({ intoPatientId: b.id, reason: 'race one' }), who.admin.agent.post(`/api/patients/${b.id}/merge`).send({ intoPatientId: a.id, reason: 'race two' })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await owner.query('SELECT count(*)::int n FROM patients WHERE id = ANY($1) AND merged_into IS NOT NULL', [[a.id, b.id]])).rows[0].n, 1);
});

test('encounters: create, attending must be an active doctor or admin, a bed has one open encounter, close frees the bed, versions, no future start', async () => {
  const p1 = await mkPatient({}), p2 = await mkPatient({});
  const mkEnc = (pid, body, as = 'nurse') => who[as].agent.post(`/api/patients/${pid}/encounters`).send(body);
  assert.equal((await mkEnc(p1.id, { type: 'surgery' })).status, 400);
  assert.equal((await mkEnc(p1.id, { type: 'admission', bed: 'B1' })).status, 400, 'a bed needs a ward');
  assert.equal((await mkEnc(p1.id, { type: 'admission', startAt: new Date(Date.now() + 3600e3).toISOString() })).status, 400, 'not in the future');
  assert.equal((await mkEnc(p1.id, { type: 'admission', attendingId: who.nurse.id })).body.error.code, 'attending_invalid');
  assert.equal((await mkEnc(p1.id, { type: 'admission' }, 'viewer')).status, 403);
  assert.equal((await mkEnc('00000000-0000-4000-8000-000000000000', { type: 'OPD' })).status, 404);
  const before = await maxId(), e1 = await mkEnc(p1.id, { type: 'admission', ward: 'Ward A', bed: 'Bed 1', attendingId: who.doctor.id });
  assert.equal(e1.status, 201); assert.equal(e1.body.status, 'open'); assert.equal(e1.body.attendingId, who.doctor.id); assert.equal(e1.body.version, 1);
  const rows = await since(before); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'encounter.create'); assert.equal(rows[0].patient_id, p1.id);
  const clash = await mkEnc(p2.id, { type: 'admission', ward: ' ward a ', bed: 'BED 1' });
  assert.equal(clash.status, 409); assert.equal(clash.body.error.code, 'bed_occupied', 'same bed, ignoring case and end spaces');
  const e2 = (await mkEnc(p2.id, { type: 'admission', ward: 'Ward A', bed: 'Bed 2' })).body, id = e2.id;
  assert.equal((await who.nurse.agent.patch('/api/encounters/' + id).send({ expectedVersion: 1, bed: 'Bed 1' })).body.error.code, 'bed_occupied', 'a transfer into an occupied bed');
  const mv = await who.nurse.agent.patch('/api/encounters/' + id).send({ expectedVersion: 1, bed: 'Bed 3', attendingId: who.admin.id });
  assert.equal(mv.status, 200); assert.equal(mv.body.bed, 'Bed 3'); assert.equal(mv.body.version, 2);
  const stale = await who.nurse.agent.patch('/api/encounters/' + id).send({ expectedVersion: 1, bed: 'Bed 9' });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'conflict'); assert.equal(stale.body.current.bed, 'Bed 3');
  assert.equal((await who.nurse.agent.patch('/api/encounters/' + id).send({ expectedVersion: 2, ward: null })).body.error.code, 'validation', 'clearing the ward while a bed is set');
  assert.equal((await who.nurse.agent.post(`/api/encounters/${e1.body.id}/close`).send({ expectedVersion: 1, endAt: '2000-01-01T00:00:00Z' })).status, 400, 'end before start');
  const bc = await maxId(), cl = await who.nurse.agent.post(`/api/encounters/${e1.body.id}/close`).send({ expectedVersion: 1 });
  assert.equal(cl.status, 200); assert.equal(cl.body.status, 'closed'); assert.ok(cl.body.endAt);
  assert.equal((await since(bc)).length, 1);
  assert.equal((await mkEnc(p2.id, { type: 'emergency', ward: 'Ward A', bed: 'Bed 1' })).status, 201, 'the bed is free after the close');
  assert.equal((await who.nurse.agent.patch('/api/encounters/' + e1.body.id).send({ expectedVersion: 2, bed: 'Bed 7' })).body.error.code, 'encounter_not_open');
  assert.equal((await who.nurse.agent.post(`/api/encounters/${e1.body.id}/close`).send({ expectedVersion: 2 })).body.error.code, 'encounter_not_open');
  const list = (await who.viewer.agent.get(`/api/patients/${p2.id}/encounters`)).body; assert.equal(list.length, 2);
});

test('simultaneous encounters for one bed: exactly one is created', async () => {
  const ps = await Promise.all(Array.from({ length: 5 }, () => mkPatient({})));
  const rs = await Promise.all(ps.map((p, i) => [who.doctor, who.nurse, who.admin][i % 3].agent.post(`/api/patients/${p.id}/encounters`).send({ type: 'admission', ward: 'Race Ward', bed: 'R1' })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409]); assert.ok(rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'bed_occupied'));
});

test('cancel an encounter: reason required, refused when a chart is linked, frees the bed', async () => {
  const p = await mkPatient({}), e = (await who.nurse.agent.post(`/api/patients/${p.id}/encounters`).send({ type: 'admission', ward: 'Cancel Ward', bed: 'C1' })).body;
  const cs = (await who.doctor.agent.post('/api/cases').send({})).body;
  assert.equal((await who.nurse.agent.post(`/api/encounters/${e.id}/cancel`).send({ expectedVersion: 1 })).status, 400, 'reason required');
  assert.equal((await who.doctor.agent.post(`/api/cases/${cs.id}/link`).send({ expectedVersion: cs.version, patientId: p.id, encounterId: e.id })).status, 200);
  assert.equal((await who.nurse.agent.post(`/api/encounters/${e.id}/cancel`).send({ expectedVersion: 1, reason: 'opened by mistake' })).body.error.code, 'encounter_in_use');
  const e2 = (await who.nurse.agent.post(`/api/patients/${p.id}/encounters`).send({ type: 'OPD', ward: 'Cancel Ward', bed: 'C2' })).body;
  const c = await who.nurse.agent.post(`/api/encounters/${e2.id}/cancel`).send({ expectedVersion: 1, reason: 'opened by mistake' });
  assert.equal(c.status, 200); assert.equal(c.body.status, 'cancelled'); assert.equal(c.body.cancelReason, 'opened by mistake');
  assert.equal((await who.nurse.agent.post(`/api/patients/${p.id}/encounters`).send({ type: 'OPD', ward: 'Cancel Ward', bed: 'C2' })).status, 201, 'bed free again');
});

test('link a case: needs the case version, one patient per case, the encounter must be that patient\'s and open, the case version moves, and the case reads back linked', async () => {
  const p = await mkPatient({}), other = await mkPatient({}), e = (await who.nurse.agent.post(`/api/patients/${p.id}/encounters`).send({ type: 'admission', ward: 'Link Ward', bed: 'L1' })).body;
  const eo = (await who.nurse.agent.post(`/api/patients/${other.id}/encounters`).send({ type: 'admission', ward: 'Link Ward', bed: 'L2' })).body;
  const cs = (await who.nurse.agent.post('/api/cases').send({})).body, link = (body, as = 'nurse') => who[as].agent.post(`/api/cases/${cs.id}/link`).send(body);
  assert.equal((await link({ expectedVersion: cs.version, patientId: p.id }, 'viewer')).status, 403);
  assert.equal((await link({ expectedVersion: cs.version, patientId: p.id, encounterId: eo.id })).body.error.code, 'encounter_mismatch');
  const stale = await link({ expectedVersion: cs.version + 5, patientId: p.id }); assert.equal(stale.status, 409); assert.equal(stale.body.current.id, cs.id);
  const before = await maxId(), ok = await link({ expectedVersion: cs.version, patientId: p.id, encounterId: e.id });
  assert.equal(ok.status, 200); assert.equal(ok.body.patientId, p.id); assert.equal(ok.body.encounterId, e.id); assert.equal(ok.body.version, cs.version + 1);
  const rows = await since(before); assert.equal(rows.length, 1); assert.equal(rows[0].action, 'case.link'); assert.equal(rows[0].patient_id, p.id); assert.equal(rows[0].before.patientId, null);
  const read = (await who.viewer.agent.get('/api/cases/' + cs.id)).body; assert.equal(read.patientId, p.id); assert.equal(read.encounterId, e.id);
  const moved = await link({ expectedVersion: ok.body.version, patientId: other.id }); assert.equal(moved.status, 409); assert.equal(moved.body.error.code, 'patient_locked');
  assert.equal((await link({ expectedVersion: ok.body.version, patientId: p.id })).status, 200, 'linking again to the same patient keeps the encounter');
  assert.equal((await owner.query('SELECT encounter_id FROM cases WHERE id=$1', [cs.id])).rows[0].encounter_id, e.id);
  await who.nurse.agent.post(`/api/encounters/${e.id}/close`).send({ expectedVersion: 1 });
  const c2 = (await who.nurse.agent.post('/api/cases').send({})).body;
  assert.equal((await who.nurse.agent.post(`/api/cases/${c2.id}/link`).send({ expectedVersion: c2.version, patientId: p.id, encounterId: e.id })).body.error.code, 'encounter_not_open');
  assert.equal((await who.nurse.agent.post(`/api/cases/${c2.id}/link`).send({ expectedVersion: c2.version, patientId: '00000000-0000-4000-8000-000000000000' })).status, 404);
});

test('records are never deleted: not by the app role, not even by the owner', async () => {
  for (const t of ['patients', 'encounters']) {
    await assert.rejects(appDb.query(`DELETE FROM ${t}`), /permission denied/); await assert.rejects(appDb.query(`TRUNCATE ${t}`), /permission denied/);
    await assert.rejects(owner.query(`DELETE FROM ${t}`), /append-only|not allowed|forbid/i);
  }
  await assert.rejects(owner.query("UPDATE patients SET merged_into=id, active=false, merged_at=now(), merged_by=(SELECT id FROM users LIMIT 1) WHERE id=(SELECT id FROM patients LIMIT 1)"), /patients_merge_shape/, 'a record cannot be merged into itself');
});
