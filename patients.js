'use strict';
/**
 * Patients, encounters and linking a case to them (chunk 34a). Called from api.js (mountApi) with the guarded router, so every route here must have an
 * action in permissions.js ROUTE_ACTIONS, and every write inserts its audit row on the same transaction client as the change (audit.js).
 *
 * Rules this file enforces:
 *  - The MRN is made here from a database sequence plus a Luhn check digit. A client can never send one.
 *  - Registering checks for duplicates (same name + date of birth, or same phone) and answers 409 possible_duplicate with the candidates until the caller
 *    sends confirmDifferent: true. Registrations of the same name or phone are serialised by advisory locks, so two simultaneous clicks cannot both skip the warning.
 *  - Nothing is deleted. A duplicate is merged by pointing it at the record that is kept (merged_into); nothing is moved, and an admin can undo it (unmerge).
 *  - A merged or inactive patient takes no new encounter and no new case link.
 *  - Identity changes (name, sex, date of birth, phone, national id) need a reason. national_id is never written to the audit log (it is append-only), only the fact it changed.
 *  - One open encounter per ward and bed (unique index), so a bed cannot belong to two patients at once.
 *  - A case already linked to a patient cannot be moved to another patient; the fix for a duplicate is a merge.
 */
const { z } = require('zod');

const VIEW_THROTTLE_MIN = 10;
// the same expressions as the indexes in 005_patients.sql
const NORM = (p) => `lower(regexp_replace(btrim(${p}), '\\s+', ' ', 'g'))`;
const DIGITS = (p) => `regexp_replace(${p}, '\\D', '', 'g')`;
const PCOLS = `id, mrn, name, sex, to_char(date_of_birth, 'YYYY-MM-DD') AS dob, age_estimated, phone, national_id, (national_id IS NOT NULL) AS has_nid,
  active, merged_into, version, created_at, updated_at`;
const ECOLS = 'id, patient_id, type, start_at, end_at, ward, bed, attending, status, cancel_reason, version, updated_at';

// ---------- MRN: 7 digits from the sequence + 1 Luhn check digit (catches any single mistyped digit and most swaps of neighbouring digits) ----------
function luhnDigit(payload) {
  let sum = 0, dbl = true;
  for (let i = payload.length - 1; i >= 0; i--, dbl = !dbl) { let d = +payload[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return (10 - (sum % 10)) % 10;
}
const mrnFor = (n) => { const s = String(n).padStart(7, '0'); return s + luhnDigit(s); };
const mrnValid = (m) => /^\d{8}$/.test(m) && luhnDigit(m.slice(0, 7)) === +m[7];

// ---------- validators ----------
const uuid = z.string().uuid(), ver = z.number().int().min(1);
const isoTime = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date-time');
const reasonText = z.string().trim().min(3).max(1000);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1880-01-01' && s <= new Date().toISOString().slice(0, 10);
}, 'not a real date between 1880 and today');
const name = z.string().trim().min(2).max(200), sex = z.enum(['female', 'male', 'other', 'unknown']);
const phone = z.string().trim().min(3).max(40).regex(/^[0-9+()\-. ]+$/, 'digits, spaces and + ( ) - . only');
const nid = z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9 -]+$/, 'letters, digits, spaces and - only');
const age = z.number().int().min(0).max(120);
const place = z.string().trim().min(1).max(50);
const oneOfDobAge = [(o) => !(o.dateOfBirth !== undefined && o.ageYears !== undefined), 'give dateOfBirth or ageYears, not both'];
const S = {
  search: z.object({ q: z.string().trim().min(2).max(100), limit: z.string().regex(/^\d{1,2}$/).optional() }).strict(),
  create: z.object({ name, sex, dateOfBirth: isoDay.optional(), ageYears: age.optional(), phone: phone.optional(), nationalId: nid.optional(), confirmDifferent: z.boolean().optional() }).strict()
    .refine(...oneOfDobAge).refine((o) => o.dateOfBirth !== undefined || o.ageYears !== undefined, 'give dateOfBirth, or ageYears as an estimate'),
  patch: z.object({ expectedVersion: ver, reason: reasonText, name: name.optional(), sex: sex.optional(), dateOfBirth: isoDay.optional(), ageYears: age.optional(),
    phone: phone.nullable().optional(), nationalId: nid.nullable().optional() }).strict()
    .refine(...oneOfDobAge).refine((o) => Object.keys(o).length > 2, 'nothing to change'),
  merge: z.object({ intoPatientId: uuid, reason: reasonText }).strict(),
  unmerge: z.object({ reason: reasonText }).strict(),
  encCreate: z.object({ type: z.enum(['admission', 'OPD', 'emergency']), startAt: isoTime.optional(), ward: place.optional(), bed: place.optional(), attendingId: uuid.optional() }).strict()
    .refine((o) => o.bed === undefined || o.ward !== undefined, 'a bed needs a ward'),
  encPatch: z.object({ expectedVersion: ver, ward: place.nullable().optional(), bed: place.nullable().optional(), attendingId: uuid.nullable().optional() }).strict()
    .refine((o) => Object.keys(o).length > 1, 'nothing to change'),
  encClose: z.object({ expectedVersion: ver, endAt: isoTime.optional() }).strict(),
  encCancel: z.object({ expectedVersion: ver, reason: reasonText }).strict(),
  link: z.object({ expectedVersion: ver, patientId: uuid, encounterId: uuid.optional() }).strict(),
};

function mountPatients(r, { db, ApiError, wrap, parse, idParam, iso, audit, auditOnce, can, loadCase }) {
  const fail = (s, c, m, x) => new ApiError(s, c, m, x);
  const patOut = (p, { detail = false, nid: showNid = false } = {}) => ({
    id: p.id, mrn: p.mrn, name: p.name, sex: p.sex, dateOfBirth: p.dob, ageEstimated: p.age_estimated, active: p.active, mergedInto: p.merged_into, hasNationalId: p.has_nid, version: p.version,
    ...(detail ? { phone: p.phone, createdAt: iso(p.created_at), updatedAt: iso(p.updated_at) } : {}), ...(showNid ? { nationalId: p.national_id } : {}),
  });
  const snap = (p) => ({ name: p.name, sex: p.sex, dateOfBirth: p.dob, ageEstimated: p.age_estimated, phone: p.phone });      // audit content: no national id
  const encOut = (e, home) => ({ id: e.id, patientId: e.patient_id, type: e.type, startAt: iso(e.start_at), endAt: iso(e.end_at), ward: e.ward, bed: e.bed, attendingId: e.attending,
    status: e.status, cancelReason: e.cancel_reason, version: e.version, ...(home && e.patient_id !== home ? { fromMergedPatient: true } : {}) });
  const ESNAP = (e) => ({ ward: e.ward, bed: e.bed, attendingId: e.attending, status: e.status });
  const lockPatient = async (c, id, mode = 'UPDATE') => (await c.query(`SELECT ${PCOLS} FROM patients WHERE id=$1 FOR ${mode}`, [id])).rows[0];
  const usable = (p) => { if (!p) throw fail(404, 'not_found', 'Patient not found'); if (p.merged_into) throw fail(409, 'patient_merged', 'This record was merged into another; use that one'); if (!p.active) throw fail(409, 'patient_inactive', 'This patient record is inactive'); return p; };
  const checkVersion = (row, v, what, current) => { if (row.version !== v) throw fail(409, 'conflict', `${what} was changed by someone else`, { current }); };
  const attendingOk = async (c, id) => { if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND active AND role IN ('doctor','admin')", [id])).rowCount) throw fail(422, 'attending_invalid', 'The attending must be an active doctor or admin'); };
  const bedGuard = async (fn) => {                                                    // a unique-index clash is a plain answer, not a 500
    try { return await fn(); } catch (e) { if (e && e.code === '23505' && e.constraint === 'encounters_open_bed_uq') throw fail(409, 'bed_occupied', 'That bed already has an open encounter'); throw e; }
  };
  const dobSql = (n) => `(CURRENT_DATE - make_interval(years => $${n}))::date`;     // an estimated age is stored as a date of birth with age_estimated = true

  // ================= patients =================
  r.get('/patients', wrap(async (req, res) => {
    const b = parse(S.search, req.query), n = Math.min(+(b.limit || 20) || 20, 50), digits = b.q.replace(/\D/g, '');
    const rows = (await db.query(`SELECT ${PCOLS} FROM patients WHERE merged_into IS NULL AND (name ILIKE $1 ESCAPE '\\'
        OR ($2 <> '' AND length($2) >= 3 AND (mrn LIKE $2 || '%' OR (length($2) >= 4 AND ${DIGITS('phone')} LIKE '%' || $2 || '%'))))
      ORDER BY (mrn = $2) DESC, name, id LIMIT ${n}`, ['%' + b.q.replace(/[\\%_]/g, '\\$&') + '%', digits])).rows;
    res.json(rows.map((p) => patOut(p)));                                               // no phone or national id in a list
  }));
  r.get('/patients/:id', wrap(async (req, res) => {
    const p = (await db.query(`SELECT ${PCOLS} FROM patients WHERE id=$1`, [idParam(req.params.id)])).rows[0];
    if (!p) throw fail(404, 'not_found', 'Patient not found');
    // like the case view (33c1): a patient record opened is logged, once per user per patient per VIEW_THROTTLE_MIN minutes; if it cannot be logged the read fails
    await db.withTx((cl) => auditOnce(cl, { action: 'view', entity: 'patient', entity_id: p.id, patient_id: p.id }, VIEW_THROTTLE_MIN));
    res.json(patOut(p, { detail: true, nid: can(req.actor, 'patient.write') }));
  }));

  r.post('/patients', wrap(async (req, res) => {
    const b = parse(S.create, req.body), pd = (b.phone || '').replace(/\D/g, '');
    const out = await db.withTx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('pn|' || ${NORM('$1')}, 0))`, [b.name]);       // fixed order (name, then phone) so two registrations cannot deadlock
      if (pd.length >= 6) await c.query("SELECT pg_advisory_xact_lock(hashtextextended('pp|' || $1, 0))", [pd]);
      const dob = b.dateOfBirth || (await c.query("SELECT to_char(CURRENT_DATE - make_interval(years => $1), 'YYYY-MM-DD') AS d", [b.ageYears])).rows[0].d;
      const cands = (await c.query(`SELECT ${PCOLS},
          (${NORM('name')} = ${NORM('$1')} AND date_of_birth IS NOT NULL AND (date_of_birth = $2::date
            OR ((age_estimated OR $3::boolean) AND abs(extract(year FROM date_of_birth) - extract(year FROM $2::date)) <= 2))) AS by_name_dob,
          ($4 <> '' AND length($4) >= 6 AND ${DIGITS('phone')} = $4) AS by_phone
        FROM patients WHERE merged_into IS NULL AND (${NORM('name')} = ${NORM('$1')} OR ($4 <> '' AND length($4) >= 6 AND ${DIGITS('phone')} = $4))
        ORDER BY by_name_dob DESC, by_phone DESC, id`, [b.name, dob, b.ageYears !== undefined, pd])).rows.filter((x) => x.by_name_dob || x.by_phone);
      if (cands.length && !b.confirmDifferent) {
        throw fail(409, 'possible_duplicate', 'A patient with the same name and date of birth, or the same phone, already exists. Open that record, or confirm this is a different person.',
          { candidates: cands.map((x) => ({ ...patOut(x), matchedOn: [x.by_name_dob && 'name_and_birth', x.by_phone && 'phone'].filter(Boolean) })) });
      }
      const mrn = mrnFor(Number((await c.query("SELECT nextval('patient_mrn_seq') AS n")).rows[0].n));
      const p = (await c.query(`INSERT INTO patients (mrn, name, sex, date_of_birth, age_estimated, phone, national_id, created_by) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8) RETURNING ${PCOLS}`,
        [mrn, b.name, b.sex, dob, b.ageYears !== undefined, b.phone || null, b.nationalId || null, req.actor.id])).rows[0];
      await audit(c, { action: 'patient.create', entity: 'patient', entity_id: p.id, patient_id: p.id,
        after: { mrn, ...snap(p), nationalIdSet: p.has_nid, ...(cands.length ? { confirmedDifferentFrom: cands.map((x) => x.id) } : {}) } });
      return p;
    });
    res.status(201).json(patOut(out, { detail: true, nid: true }));
  }));

  r.patch('/patients/:id', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.patch, req.body);
    const out = await db.withTx(async (c) => {
      const p = usable(await lockPatient(c, id));
      checkVersion(p, b.expectedVersion, 'The patient', patOut(p, { detail: true }));
      const set = [], v = [id], add = (sql, val) => { v.push(val); set.push(sql.replace('?', '$' + v.length)); };
      if (b.name !== undefined) add('name=?', b.name);
      if (b.sex !== undefined) add('sex=?', b.sex);
      if (b.dateOfBirth !== undefined) { add('date_of_birth=?::date', b.dateOfBirth); set.push('age_estimated=false'); }
      if (b.ageYears !== undefined) { v.push(b.ageYears); set.push(`date_of_birth=${dobSql(v.length)}`, 'age_estimated=true'); }
      if (b.phone !== undefined) add('phone=?', b.phone);
      if (b.nationalId !== undefined) add('national_id=?', b.nationalId);
      const n = (await c.query(`UPDATE patients SET ${set.join(', ')}, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${PCOLS}`, v)).rows[0];
      await audit(c, { action: 'patient.update', entity: 'patient', entity_id: id, patient_id: id, before: snap(p), after: { ...snap(n), ...(b.nationalId !== undefined ? { nationalIdChanged: true } : {}) }, reason: b.reason });
      return n;
    });
    res.json(patOut(out, { detail: true, nid: true }));
  }));

  // Merge: the record in the URL (the duplicate) is pointed at intoPatientId (the one kept). Both rows are locked in id order, so two admins merging A into B and B into A at once cannot both win.
  r.post('/patients/:id/merge', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.merge, req.body);
    if (b.intoPatientId === id) throw fail(400, 'validation', 'A patient cannot be merged into itself');
    const out = await db.withTx(async (c) => {
      const rows = (await c.query(`SELECT ${PCOLS} FROM patients WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[id, b.intoPatientId]])).rows;
      const src = rows.find((x) => x.id === id), dst = rows.find((x) => x.id === b.intoPatientId);
      if (!src) throw fail(404, 'not_found', 'Patient not found');
      if (!dst) throw fail(422, 'target_not_found', 'The patient to keep was not found');
      if (src.merged_into) throw fail(409, 'already_merged', 'This record is already merged into another');
      if (dst.merged_into || !dst.active) throw fail(409, 'target_unusable', 'The patient to keep is merged or inactive; choose the record it was merged into');
      const n = (await c.query(`UPDATE patients SET merged_into=$2, merged_at=now(), merged_by=$3, active=false, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${PCOLS}`, [id, dst.id, req.actor.id])).rows[0];
      const [cs, es] = await Promise.all([c.query('SELECT count(*)::int n FROM cases WHERE patient_id=$1', [id]), c.query('SELECT count(*)::int n FROM encounters WHERE patient_id=$1', [id])]);
      await audit(c, { action: 'patient.merge', entity: 'patient', entity_id: id, patient_id: id, reason: b.reason,
        before: { mrn: src.mrn, active: true }, after: { mergedInto: dst.id, keptMrn: dst.mrn, nothingMoved: true, casesLeftOnDuplicate: cs.rows[0].n, encountersLeftOnDuplicate: es.rows[0].n } });
      return n;
    });
    res.json(patOut(out, { detail: true }));
  }));
  r.post('/patients/:id/unmerge', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.unmerge, req.body);
    const out = await db.withTx(async (c) => {
      const p = await lockPatient(c, id);
      if (!p) throw fail(404, 'not_found', 'Patient not found');
      if (!p.merged_into) throw fail(409, 'not_merged', 'This record is not merged');
      const n = (await c.query(`UPDATE patients SET merged_into=NULL, merged_at=NULL, merged_by=NULL, active=true, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${PCOLS}`, [id])).rows[0];
      await audit(c, { action: 'patient.unmerge', entity: 'patient', entity_id: id, patient_id: id, reason: b.reason, before: { mergedInto: p.merged_into }, after: { active: true } });
      return n;
    });
    res.json(patOut(out, { detail: true }));
  }));

  // ================= encounters =================
  r.get('/patients/:id/encounters', wrap(async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await db.query('SELECT 1 FROM patients WHERE id=$1', [id])).rowCount) throw fail(404, 'not_found', 'Patient not found');
    // the kept record also lists the encounters still sitting on records merged into it
    const rows = (await db.query(`SELECT ${ECOLS} FROM encounters WHERE patient_id=$1 OR patient_id IN (SELECT id FROM patients WHERE merged_into=$1) ORDER BY start_at DESC, id LIMIT 200`, [id])).rows;
    res.json(rows.map((e) => encOut(e, id)));
  }));
  r.post('/patients/:id/encounters', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.encCreate, req.body);
    if (b.startAt && Date.parse(b.startAt) > Date.now() + 5 * 60000) throw fail(400, 'validation', 'startAt: an encounter cannot start in the future');
    const e = await bedGuard(() => db.withTx(async (c) => {
      usable(await lockPatient(c, id, 'SHARE'));                                       // SHARE conflicts with the UPDATE lock of a merge, so no encounter lands on a record being merged
      if (b.attendingId) await attendingOk(c, b.attendingId);
      const row = (await c.query(`INSERT INTO encounters (patient_id, type, start_at, ward, bed, attending, created_by) VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7) RETURNING ${ECOLS}`,
        [id, b.type, b.startAt || null, b.ward || null, b.bed || null, b.attendingId || null, req.actor.id])).rows[0];
      await audit(c, { action: 'encounter.create', entity: 'encounter', entity_id: row.id, patient_id: id, after: { type: row.type, startAt: iso(row.start_at), ...ESNAP(row) } });
      return row;
    }));
    res.status(201).json(encOut(e));
  }));
  // one lock-and-check shape for patch, close and cancel: lock the row, require 'open' and the caller's version, run `change`, audit
  const encAction = (schema, action, change) => wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(schema, req.body);
    const e = await bedGuard(() => db.withTx(async (c) => {
      const old = (await c.query(`SELECT ${ECOLS} FROM encounters WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!old) throw fail(404, 'not_found', 'Encounter not found');
      checkVersion(old, b.expectedVersion, 'The encounter', encOut(old));
      if (old.status !== 'open') throw fail(409, 'encounter_not_open', `This encounter is ${old.status}`);
      const { sets, vals, reason, after } = await change(c, old, b, req);
      const n = (await c.query(`UPDATE encounters SET ${sets}, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${ECOLS}`, [id, ...vals])).rows[0];
      await audit(c, { action, entity: 'encounter', entity_id: id, patient_id: old.patient_id, before: ESNAP(old), after: after(n), reason });
      return n;
    }));
    res.json(encOut(e));
  });
  r.patch('/encounters/:id', encAction(S.encPatch, 'encounter.update', async (c, old, b) => {
    const ward = b.ward !== undefined ? b.ward : old.ward, bed = b.bed !== undefined ? b.bed : old.bed;
    if (bed && !ward) throw fail(400, 'validation', 'a bed needs a ward');
    if (b.attendingId) await attendingOk(c, b.attendingId);
    return { sets: 'ward=$2, bed=$3, attending=$4', vals: [ward || null, bed || null, b.attendingId !== undefined ? b.attendingId : old.attending], after: ESNAP };
  }));
  r.post('/encounters/:id/close', encAction(S.encClose, 'encounter.close', async (c, old, b) => {
    if (b.endAt && (Date.parse(b.endAt) < new Date(old.start_at).getTime() || Date.parse(b.endAt) > Date.now() + 5 * 60000)) throw fail(400, 'validation', 'endAt: not before the start and not in the future');
    return { sets: "status='closed', end_at=COALESCE($2::timestamptz, GREATEST(now(), start_at))", vals: [b.endAt || null], after: (n) => ({ ...ESNAP(n), endAt: iso(n.end_at) }) };
  }));
  r.post('/encounters/:id/cancel', encAction(S.encCancel, 'encounter.cancel', async (c, old, b) => {
    if ((await c.query('SELECT 1 FROM cases WHERE encounter_id=$1 LIMIT 1', [old.id])).rowCount) throw fail(409, 'encounter_in_use', 'A chart is linked to this encounter; close it instead of cancelling');
    return { sets: "status='cancelled', cancel_reason=$2", vals: [b.reason], reason: b.reason, after: ESNAP };
  }));

  // ================= attach a case to a patient and encounter =================
  r.post('/cases/:id/link', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.link, req.body);
    const out = await db.withTx(async (c) => {
      const cs = (await c.query('SELECT id, patient_id, encounter_id, version FROM cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!cs) throw fail(404, 'not_found', 'Case not found');
      if (cs.version !== b.expectedVersion) throw fail(409, 'conflict', 'The case was changed by someone else', { current: await loadCase(db, id) });
      usable(await lockPatient(c, b.patientId, 'SHARE'));
      if (cs.patient_id && cs.patient_id !== b.patientId) throw fail(409, 'patient_locked', 'This case already belongs to another patient. A duplicate is fixed by merging the patient records.');
      const encId = b.encounterId !== undefined ? b.encounterId : cs.encounter_id;
      if (encId) {
        const e = (await c.query('SELECT patient_id, status FROM encounters WHERE id=$1', [encId])).rows[0];
        if (!e || e.patient_id !== b.patientId) throw fail(422, 'encounter_mismatch', 'That encounter does not belong to this patient');
        if (e.status !== 'open' && encId !== cs.encounter_id) throw fail(409, 'encounter_not_open', `That encounter is ${e.status}`);
      }
      const n = (await c.query('UPDATE cases SET patient_id=$2, encounter_id=$3, version=version+1, updated_at=now() WHERE id=$1 RETURNING id, patient_id, encounter_id, version', [id, b.patientId, encId || null])).rows[0];
      await audit(c, { action: 'case.link', entity: 'case', entity_id: id, case_id: id, patient_id: b.patientId, before: { patientId: cs.patient_id, encounterId: cs.encounter_id }, after: { patientId: n.patient_id, encounterId: n.encounter_id } });
      return n;
    });
    res.json({ id: out.id, patientId: out.patient_id, encounterId: out.encounter_id, version: out.version });
  }));
}

module.exports = { mountPatients, mrnFor, mrnValid, luhnDigit };
