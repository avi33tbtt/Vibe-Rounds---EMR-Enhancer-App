'use strict';
/**
 * REST API (chunk 28). Mounted by server.js. Every body is validated with zod (strict: unknown
 * fields are rejected). Every versioned write needs expectedVersion and returns 409 + {current}
 * on conflict, never last-write-wins. Clinical data is never deleted: no DELETE route exists for
 * cases, rows, values or notes. Auth arrives in chunk 32: until then `getActor` returns a dev user
 * (refused when NODE_ENV=production) and ids like entered_by come from it, never from a request body.
 */
const express = require('express');
const { z } = require('zod');
const crypto = require('node:crypto');

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---------- shared validators ----------
const MAX_ROWS_PER_GROUP = 500;
const uuid = z.string().uuid();
const ident = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);                  // set, field, group, rule ids
const keyRe = /^[A-Za-z0-9_.-]{1,100}\/(@?[A-Za-z0-9_.-]{1,100})$/;        // setId/fieldId, setId/@group, setId/__ref
const valueKey = z.string().regex(keyRe);
const ver = z.number().int().min(1);
const isoTime = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date-time');
const jsonSize = (max) => (v) => JSON.stringify(v ?? null).length <= max;
const rowObj = z.record(z.string().max(100), z.any()).refine(jsonSize(20000), 'row too large');
const anyJson = (max) => z.any().refine((v) => v !== undefined, 'required').refine(jsonSize(max), `value larger than ${max} characters`);
const appliedArr = z.array(z.object({ setId: ident, version: z.number().int().min(1).optional(), addedAt: z.string().max(40) }).strict()).max(200);
const pathwaysArr = z.array(z.object({ pathwayId: ident, version: z.number().int().min(1).optional(), startedAt: z.string().max(40) }).strict()).max(50);
const patientObj = z.object({ name: z.string().max(200), ageSex: z.string().max(50), bed: z.string().max(50), mrn: z.string().max(50) }).strict();
const alertLogArr = z.array(z.object({ ruleId: ident, ackedAt: z.string().max(40) }).passthrough()).max(2000);
const pinnedArr = z.array(ident).max(50).nullable();

// Format checks only (does the string look like a SNOMED CT concept id or a LOINC code). They say nothing about whether the code is the RIGHT concept.
const sysEnum = z.enum(['snomed', 'loinc']);
const CODE_RE = { snomed: /^[1-9]\d{5,17}$/, loinc: /^\d{1,7}-\d$/ };
function codeShape(o, ctx) {
  if (!CODE_RE[o.system].test(o.code)) ctx.addIssue({ code: 'custom', path: ['code'], message: o.system === 'snomed' ? 'not a SNOMED CT concept id (6 to 18 digits)' : 'not a LOINC code (digits, a hyphen, one check digit)' });
}
const S = {
  caseCreate: z.object({ id: uuid.optional(), patient: patientObj.optional(), narrative: z.string().max(200000).optional(),
    applied: appliedArr.optional(), pathways: pathwaysArr.optional(), pinned: pinnedArr.optional() }).strict(),
  casePatch: z.object({ expectedVersion: ver, patient: patientObj.optional(), narrative: z.string().max(200000).optional(),
    applied: appliedArr.optional(), pathways: pathwaysArr.optional(), pinned: pinnedArr.optional(), alertLog: alertLogArr.optional() }).strict()
    .refine((o) => Object.keys(o).length > 1, 'nothing to change'),
  rowCreate: z.object({ setId: ident, groupId: ident, row: rowObj, rowTime: isoTime.nullable().optional() }).strict(),
  rowPatch: z.object({ expectedVersion: ver, row: rowObj.optional(), rowTime: isoTime.nullable().optional() }).strict()
    .refine((o) => o.row !== undefined || o.rowTime !== undefined, 'nothing to change'),
  rowError: z.object({ expectedVersion: ver, reason: z.string().trim().min(3).max(1000) }).strict(),
  valuePut: z.object({ key: valueKey, value: anyJson(100000), expectedVersion: z.number().int().min(0) }).strict(),
  noteCreate: z.object({ id: uuid.optional(), type: z.enum(['narrative', 'template', 'disease']), setId: ident.optional(), text: z.string().max(200000).optional() }).strict(),
  notePatch: z.object({ expectedVersion: ver, text: z.string().max(200000) }).strict(),
  noteSign: z.object({ expectedVersion: ver }).strict(),
  noteAmend: z.object({ reason: z.string().trim().min(3).max(1000), text: z.string().max(200000) }).strict(),
  setPost: z.object({ setId: ident, kind: z.enum(['care', 'template', 'disease', 'custom', 'pathway']), body: z.record(z.string(), z.any()).refine(jsonSize(500000), 'set too large'),
    expectedVersion: ver.optional() }).strict(),
  usagePost: z.object({ dx: z.string().max(100).optional(), dxs: z.array(z.string().min(1).max(100)).max(20).optional() }).strict(),
  codePost: z.object({ system: sysEnum, code: z.string().trim().min(1).max(20), display: z.string().trim().min(1).max(300) }).strict().superRefine(codeShape),
  codeLive: z.object({ ok: z.boolean(), display: z.string().trim().max(300).optional() }).strict(),
  bindPut: z.object({ setId: ident, fieldId: ident, system: sysEnum, code: z.string().trim().min(1).max(20), display: z.string().trim().min(1).max(300) }).strict().superRefine(codeShape),
  rulePut: z.object({ body: z.record(z.string(), z.any()).refine(jsonSize(20000), 'rule too large'), expectedVersion: z.number().int().min(0) }).strict(),
  ruleAct: z.object({ expectedVersion: ver }).strict(),
  protoPut: z.object({ body: z.record(z.string(), z.any()).refine(jsonSize(50000), 'protocol too large'), expectedVersion: z.number().int().min(0) }).strict(),
  prefPut: z.object({ value: anyJson(20000) }).strict(),
};
function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(400, 'validation', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 500));
  return r.data;
}
const idParam = (v) => { if (!uuid.safeParse(v).success) throw new ApiError(404, 'not_found', 'Not found'); return v; };
const identParam = (v) => { if (!ident.safeParse(v).success) throw new ApiError(400, 'validation', 'Invalid id'); return v; };
const iso = (d) => (d ? new Date(d).toISOString() : null);
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, kk) => (o[kk] = x[kk], o), {}) : x));
const hashOf = (v) => 'sha256:' + crypto.createHash('sha256').update(stable(v)).digest('hex');

// ---------- actor (replaced by sessions in chunk 32) ----------
function devActor(db) {
  let cached;
  return async () => {
    if (process.env.NODE_ENV === 'production') throw new ApiError(503, 'auth_not_configured', 'Authentication is not configured yet');
    if (!cached) {
      const r = await db.query(`INSERT INTO users (username,name,role) VALUES ('dev','Development user','admin')
        ON CONFLICT (lower(username)) DO UPDATE SET name=users.name RETURNING id,role`);
      cached = { id: r.rows[0].id, role: r.rows[0].role };
    }
    return cached;
  };
}

// ---------- case assembly: the exact shape the prototype uses ----------
async function loadCase(q, id, { includeErrors = false } = {}) {
  const c = (await q.query('SELECT * FROM cases WHERE id=$1', [id])).rows[0];
  if (!c) return null;
  const [vals, rows, notes] = await Promise.all([
    q.query('SELECT key,value,version FROM case_values WHERE case_id=$1', [id]),
    q.query(`SELECT * FROM case_rows WHERE case_id=$1 ${includeErrors ? '' : "AND status='active'"}
             ORDER BY row_time NULLS LAST, entered_at, id`, [id]),
    q.query('SELECT * FROM case_notes WHERE case_id=$1 ORDER BY created_at, id', [id]),
  ]);
  const values = {}, valueVersions = {};
  for (const v of vals.rows) { values[v.key] = v.value; valueVersions[v.key] = v.version; }
  for (const r of rows.rows) {
    const k = `${r.set_id}/@${r.group_id}`;
    (values[k] = values[k] || []).push({ ...r.row, __id: r.id, __v: r.version, __by: r.entered_by, __at: iso(r.entered_at), __status: r.status, __time: iso(r.row_time) });
  }
  return {
    id: c.id, patient: c.demo_patient || { name: '', ageSex: '', bed: '', mrn: '' }, patientId: c.patient_id, encounterId: c.encounter_id,
    narrative: c.narrative, applied: c.applied, pathways: c.pathways, pinned: c.pinned, alertLog: c.alert_log,
    values, valueVersions,
    notes: notes.rows.map((n) => ({ id: n.id, type: n.type, setId: n.set_id, text: n.text, status: n.status, signedBy: n.signed_by, signedAt: iso(n.signed_at),
      amends: n.amends_id, reason: n.reason, createdAt: iso(n.created_at), version: n.version })),
    version: c.version, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at),
  };
}
async function conflict(q, id, what) {
  const cur = await loadCase(q, id);
  if (!cur) throw new ApiError(404, 'not_found', 'Case not found');
  throw new ApiError(409, 'conflict', `${what} was changed by someone else`, { current: cur });
}
const touch = (q, id) => q.query('UPDATE cases SET updated_at=now() WHERE id=$1', [id]);
const rowOut = (r) => ({ id: r.id, caseId: r.case_id, setId: r.set_id, groupId: r.group_id, row: r.row, rowTime: iso(r.row_time), version: r.version,
  status: r.status, errorReason: r.error_reason, enteredBy: r.entered_by, enteredAt: iso(r.entered_at) });

function mountApi(app, { db, getActor }) {
  const actorOf = getActor || devActor(db);
  const r = express.Router();
  r.use((req, res, next) => { Promise.resolve(actorOf(req)).then((a) => { req.actor = a; next(); }, next); });

  // ================= who am I (chunk 29a; chunk 32 returns the session user and mode 'session') =================
  r.get('/me', wrap(async (req, res) => {
    const u = (await db.query('SELECT id,name,role FROM users WHERE id=$1', [req.actor.id])).rows[0];
    if (!u) throw new ApiError(401, 'unauthorized', 'No such user');
    res.json({ id: u.id, name: u.name, role: u.role, mode: 'dev' });
  }));

  // ================= cases =================
  r.get('/cases', wrap(async (req, res) => {
    const q = await db.query('SELECT id,narrative,demo_patient,applied,pathways,version,updated_at FROM cases ORDER BY updated_at DESC LIMIT 1000');
    res.json(q.rows.map((c) => ({ id: c.id, patient: c.demo_patient, preview: (c.narrative || '').slice(0, 80), appliedCount: c.applied.length,
      pathways: c.pathways.map((p) => p.pathwayId), version: c.version, updatedAt: iso(c.updated_at) })));
  }));
  r.get('/cases/:id', wrap(async (req, res) => {
    const c = await loadCase(db, idParam(req.params.id), { includeErrors: req.query.includeErrors === '1' });
    if (!c) throw new ApiError(404, 'not_found', 'Case not found');
    res.json(c);
  }));
  r.post('/cases', wrap(async (req, res) => {
    const b = parse(S.caseCreate, req.body);
    const ins = await db.query(`INSERT INTO cases (id,demo_patient,narrative,applied,pathways,pinned,created_by)
      VALUES (COALESCE($1,gen_random_uuid()),$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [b.id || null, b.patient || { name: '', ageSex: '', bed: '', mrn: '' }, b.narrative || '', JSON.stringify(b.applied || []),
        JSON.stringify(b.pathways || []), b.pinned === undefined ? null : JSON.stringify(b.pinned), req.actor.id]);
    if (!ins.rows.length) throw new ApiError(409, 'conflict', 'A case with this id already exists', { current: await loadCase(db, b.id) });
    res.status(201).json(await loadCase(db, ins.rows[0].id));
  }));
  r.patch('/cases/:id', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.casePatch, req.body), sets = [], p = [id, b.expectedVersion];
    const add = (col, v, json) => { p.push(json ? JSON.stringify(v) : v); sets.push(`${col}=$${p.length}`); };
    if (b.patient !== undefined) add('demo_patient', b.patient, true);
    if (b.narrative !== undefined) add('narrative', b.narrative);
    if (b.applied !== undefined) add('applied', b.applied, true);
    if (b.pathways !== undefined) add('pathways', b.pathways, true);
    if (b.pinned !== undefined) add('pinned', b.pinned, true);
    if (b.alertLog !== undefined) add('alert_log', b.alertLog, true);
    const u = await db.query(`UPDATE cases SET ${sets.join(',')}, version=version+1, updated_at=now() WHERE id=$1 AND version=$2 RETURNING id`, p);
    if (!u.rows.length) await conflict(db, id, 'This case');
    res.json(await loadCase(db, id));
  }));

  // ================= rows (append-only; never DELETE) =================
  r.post('/cases/:id/rows', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.rowCreate, req.body);
    const out = await db.withTx(async (c) => {
      if (!(await c.query('SELECT 1 FROM cases WHERE id=$1', [id])).rows.length) throw new ApiError(404, 'not_found', 'Case not found');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${id}|${b.setId}|${b.groupId}`]);   // serialises the row COUNT only, appends never conflict
      const n = (await c.query('SELECT count(*)::int n FROM case_rows WHERE case_id=$1 AND set_id=$2 AND group_id=$3', [id, b.setId, b.groupId])).rows[0].n;
      if (n >= MAX_ROWS_PER_GROUP) throw new ApiError(422, 'too_many_rows', `A repeat group holds at most ${MAX_ROWS_PER_GROUP} rows`);
      const ins = await c.query(`INSERT INTO case_rows (case_id,set_id,group_id,row,row_time,entered_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, b.setId, b.groupId, JSON.stringify(b.row), b.rowTime || null, req.actor.id]);
      await touch(c, id);
      return ins.rows[0];
    });
    res.status(201).json(rowOut(out));
  }));
  r.patch('/cases/:id/rows/:rowId', wrap(async (req, res) => {
    const id = idParam(req.params.id), rid = idParam(req.params.rowId), b = parse(S.rowPatch, req.body);
    const sets = [], p = [rid, id, b.expectedVersion];
    if (b.row !== undefined) { p.push(JSON.stringify(b.row)); sets.push(`row=$${p.length}`); }
    if (b.rowTime !== undefined) { p.push(b.rowTime); sets.push(`row_time=$${p.length}`); }
    const u = await db.query(`UPDATE case_rows SET ${sets.join(',')}, version=version+1 WHERE id=$1 AND case_id=$2 AND version=$3 AND status='active' RETURNING *`, p);
    if (!u.rows.length) {
      const cur = (await db.query('SELECT * FROM case_rows WHERE id=$1 AND case_id=$2', [rid, id])).rows[0];
      if (!cur) throw new ApiError(404, 'not_found', 'Row not found');
      if (cur.status !== 'active') throw new ApiError(422, 'entered_in_error', 'This row was entered in error and cannot be edited', { current: rowOut(cur) });
      throw new ApiError(409, 'conflict', 'This row was changed by someone else', { current: rowOut(cur) });
    }
    await touch(db, id);
    res.json(rowOut(u.rows[0]));
  }));
  r.post('/cases/:id/rows/:rowId/error', wrap(async (req, res) => {
    const id = idParam(req.params.id), rid = idParam(req.params.rowId), b = parse(S.rowError, req.body);
    const u = await db.query(`UPDATE case_rows SET status='entered_in_error', error_reason=$4, version=version+1
      WHERE id=$1 AND case_id=$2 AND version=$3 AND status='active' RETURNING *`, [rid, id, b.expectedVersion, b.reason]);
    if (!u.rows.length) {
      const cur = (await db.query('SELECT * FROM case_rows WHERE id=$1 AND case_id=$2', [rid, id])).rows[0];
      if (!cur) throw new ApiError(404, 'not_found', 'Row not found');
      throw new ApiError(409, 'conflict', 'This row was changed by someone else', { current: rowOut(cur) });
    }
    await touch(db, id);
    res.json(rowOut(u.rows[0]));
  }));

  // ================= values =================
  r.put('/cases/:id/values', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.valuePut, req.body);
    let out;
    if (!(await db.query('SELECT 1 FROM cases WHERE id=$1', [id])).rows.length) throw new ApiError(404, 'not_found', 'Case not found');
    if (b.expectedVersion === 0) {
      out = await db.query(`INSERT INTO case_values (case_id,key,value,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key,value,version`,
        [id, b.key, JSON.stringify(b.value), req.actor.id]);
    } else {
      out = await db.query(`UPDATE case_values SET value=$3, version=version+1, updated_by=$4, updated_at=now() WHERE case_id=$1 AND key=$2 AND version=$5 RETURNING key,value,version`,
        [id, b.key, JSON.stringify(b.value), req.actor.id, b.expectedVersion]);
    }
    if (!out.rows.length) {
      const cur = (await db.query('SELECT key,value,version FROM case_values WHERE case_id=$1 AND key=$2', [id, b.key])).rows[0] || null;
      throw new ApiError(409, 'conflict', 'This value was changed by someone else', { current: cur });
    }
    await touch(db, id);
    res.json(out.rows[0]);
  }));

  // ================= notes (draft -> signed; amend creates a new note) =================
  const noteOut = (n) => ({ id: n.id, caseId: n.case_id, type: n.type, setId: n.set_id, text: n.text, status: n.status, signedBy: n.signed_by,
    signedAt: iso(n.signed_at), amends: n.amends_id, reason: n.reason, createdAt: iso(n.created_at), version: n.version });
  r.post('/cases/:id/notes', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.noteCreate, req.body);
    if (!(await db.query('SELECT 1 FROM cases WHERE id=$1', [id])).rows.length) throw new ApiError(404, 'not_found', 'Case not found');
    const n = await db.query(`INSERT INTO case_notes (id,case_id,type,set_id,text,created_by) VALUES (COALESCE($1,gen_random_uuid()),$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [b.id || null, id, b.type, b.setId || null, b.text || '', req.actor.id]);
    if (!n.rows.length) throw new ApiError(409, 'conflict', 'A note with this id already exists');
    await touch(db, id);
    res.status(201).json(noteOut(n.rows[0]));
  }));
  const noteAct = async (req, res, fn) => { res.json(noteOut(await fn(idParam(req.params.id), idParam(req.params.nid)))); };
  async function noteConflict(q, cid, nid) {
    const cur = (await q.query('SELECT * FROM case_notes WHERE id=$1 AND case_id=$2', [nid, cid])).rows[0];
    if (!cur) throw new ApiError(404, 'not_found', 'Note not found');
    if (cur.status === 'signed') throw new ApiError(409, 'signed', 'A signed note is read-only; amend it instead', { current: noteOut(cur) });
    throw new ApiError(409, 'conflict', 'This note was changed by someone else', { current: noteOut(cur) });
  }
  r.patch('/cases/:id/notes/:nid', wrap((req, res) => noteAct(req, res, async (cid, nid) => {
    const b = parse(S.notePatch, req.body);
    const u = await db.query(`UPDATE case_notes SET text=$4, version=version+1 WHERE id=$1 AND case_id=$2 AND version=$3 AND status='draft' RETURNING *`, [nid, cid, b.expectedVersion, b.text]);
    if (!u.rows.length) await noteConflict(db, cid, nid);
    await touch(db, cid); return u.rows[0];
  })));
  r.post('/cases/:id/notes/:nid/sign', wrap((req, res) => noteAct(req, res, async (cid, nid) => {
    const b = parse(S.noteSign, req.body);                // signer comes from the session, never the body
    const u = await db.query(`UPDATE case_notes SET status='signed', signed_by=$4, signed_at=now(), version=version+1
      WHERE id=$1 AND case_id=$2 AND version=$3 AND status='draft' RETURNING *`, [nid, cid, b.expectedVersion, req.actor.id]);
    if (!u.rows.length) await noteConflict(db, cid, nid);
    await touch(db, cid); return u.rows[0];
  })));
  r.post('/cases/:id/notes/:nid/amend', wrap(async (req, res) => {
    const cid = idParam(req.params.id), nid = idParam(req.params.nid), b = parse(S.noteAmend, req.body);
    const orig = (await db.query('SELECT * FROM case_notes WHERE id=$1 AND case_id=$2', [nid, cid])).rows[0];
    if (!orig) throw new ApiError(404, 'not_found', 'Note not found');
    if (orig.status !== 'signed') throw new ApiError(422, 'not_signed', 'Only a signed note can be amended');
    const n = await db.query(`INSERT INTO case_notes (case_id,type,set_id,text,amends_id,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid, orig.type, orig.set_id, b.text, nid, b.reason, req.actor.id]);
    await touch(db, cid);
    res.status(201).json(noteOut(n.rows[0]));
  }));

  // ================= element sets (seed / read-only sets cannot be changed) =================
  const setOut = (s) => ({ setId: s.set_id, version: s.version, kind: s.kind, body: s.body, source: s.source, readOnly: s.read_only, tier: s.tier,
    contentHash: s.content_hash, forkedFrom: s.forked_from, package: s.package, createdAt: iso(s.created_at) });
  r.get('/element-sets', wrap(async (req, res) => { res.json((await db.query('SELECT * FROM element_sets_latest ORDER BY set_id')).rows.map(setOut)); }));
  r.get('/element-sets/:setId', wrap(async (req, res) => {
    const s = (await db.query('SELECT * FROM element_sets_latest WHERE set_id=$1', [identParam(req.params.setId)])).rows[0];
    if (!s) throw new ApiError(404, 'not_found', 'Set not found');
    res.json(setOut(s));
  }));
  // older versions stay readable for ever: a case resolves a set by the version recorded when it was applied
  r.get('/element-sets/:setId/versions', wrap(async (req, res) => {
    const q = await db.query('SELECT set_id,version,created_at,content_hash FROM element_sets WHERE set_id=$1 ORDER BY version', [identParam(req.params.setId)]);
    if (!q.rows.length) throw new ApiError(404, 'not_found', 'Set not found');
    res.json(q.rows.map((v) => ({ setId: v.set_id, version: v.version, contentHash: v.content_hash, createdAt: iso(v.created_at) })));
  }));
  r.get('/element-sets/:setId/versions/:n', wrap(async (req, res) => {
    if (!/^[1-9][0-9]{0,8}$/.test(req.params.n)) throw new ApiError(400, 'validation', 'Version must be a positive whole number');
    const s = (await db.query('SELECT * FROM element_sets WHERE set_id=$1 AND version=$2', [identParam(req.params.setId), +req.params.n])).rows[0];
    if (!s) throw new ApiError(404, 'not_found', 'Set version not found');
    res.json(setOut(s));
  }));
  r.post('/element-sets', wrap(async (req, res) => {
    const b = parse(S.setPost, req.body);
    const out = await db.withTx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['set|' + b.setId]);
      const cur = (await c.query('SELECT * FROM element_sets WHERE set_id=$1 ORDER BY version DESC LIMIT 1', [b.setId])).rows[0];
      if (cur && (cur.read_only || cur.source !== 'user')) throw new ApiError(403, 'read_only', 'This set is read-only; fork it under a new id instead');
      if (cur && b.expectedVersion !== cur.version) throw new ApiError(409, 'conflict', 'This set has a newer version', { current: setOut(cur) });
      if (!cur && b.expectedVersion) throw new ApiError(409, 'conflict', 'This set does not exist yet');
      const v = cur ? cur.version + 1 : 1;
      const body = { ...b.body, setId: b.setId, kind: b.kind, version: v };
      return (await c.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier,content_hash,created_by) VALUES ($1,$2,$3,$4,'user',false,'local-draft',$5,$6) RETURNING *`,
        [b.setId, v, b.kind, JSON.stringify(body), hashOf(body), req.actor.id])).rows[0];
    });
    res.status(201).json(setOut(out));
  }));
  const refuseSetChange = wrap(async (req) => {
    const s = (await db.query('SELECT read_only, source FROM element_sets WHERE set_id=$1 LIMIT 1', [identParam(req.params.setId)])).rows[0];
    if (!s) throw new ApiError(404, 'not_found', 'Set not found');
    if (s.read_only || s.source !== 'user') throw new ApiError(403, 'read_only', 'This set is read-only');
    throw new ApiError(405, 'method_not_allowed', 'Sets are versioned: POST /api/element-sets saves a new version');
  });
  r.patch('/element-sets/:setId', refuseSetChange);
  r.delete('/element-sets/:setId', refuseSetChange);

  // ================= usage (per user) =================
  r.get('/usage', wrap(async (req, res) => {
    const o = {};
    for (const u of (await db.query('SELECT * FROM set_usage WHERE user_id=$1', [req.actor.id])).rows) o[u.set_id] = { count: u.count, lastUsed: iso(u.last_used), withDx: u.with_dx };
    res.json(o);
  }));
  r.post('/usage/:setId', wrap(async (req, res) => {
    const sid = identParam(req.params.setId), b = parse(S.usagePost, req.body || {});
    const dl = [...new Set([...(b.dx ? [b.dx] : []), ...(b.dxs || [])])];        // each diagnosis key counts once per use
    const out = await db.withTx(async (c) => {
      let u = (await c.query(`INSERT INTO set_usage (user_id,set_id,count,last_used,with_dx) VALUES ($1,$2,1,now(),'{}')
        ON CONFLICT (user_id,set_id) DO UPDATE SET count=set_usage.count+1, last_used=now() RETURNING count,last_used,with_dx`, [req.actor.id, sid])).rows[0];
      for (const k of dl) {
        u = (await c.query(`UPDATE set_usage SET with_dx = jsonb_set(with_dx, ARRAY[$3::text], to_jsonb(COALESCE((with_dx->>$3::text)::int,0)+1))
          WHERE user_id=$1 AND set_id=$2 RETURNING count,last_used,with_dx`, [req.actor.id, sid, k])).rows[0];
      }
      return u;
    });
    res.json({ count: out.count, lastUsed: iso(out.last_used), withDx: out.with_dx });
  }));
  r.delete('/usage', wrap(async (req, res) => { await db.query('DELETE FROM set_usage WHERE user_id=$1', [req.actor.id]); res.status(204).end(); }));

  // ================= codes and bindings (reference data) =================
  const codeOut = (c) => ({ system: c.system, code: c.code, display: c.display, verifiedLive: c.verified_live, addedBy: c.added_by, addedAt: iso(c.added_at) });
  const codeKey = (req) => {
    const system = sysEnum.safeParse(req.params.system);
    if (!system.success || !CODE_RE[system.data].test(req.params.code)) throw new ApiError(400, 'validation', 'Invalid code reference');
    return [system.data, req.params.code];
  };
  r.get('/codes', wrap(async (req, res) => {
    res.json((await db.query('SELECT * FROM verified_codes ORDER BY system,code')).rows.map(codeOut));
  }));
  // Adding never overwrites: a code already in the table returns 409 with the existing row (display and who added it stay as they were).
  r.post('/codes', wrap(async (req, res) => {
    const b = parse(S.codePost, req.body);
    const u = await db.query('INSERT INTO verified_codes (system,code,display,added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (system,code) DO NOTHING RETURNING *', [b.system, b.code, b.display, req.actor.id]);
    if (!u.rows.length) {
      const cur = (await db.query('SELECT * FROM verified_codes WHERE system=$1 AND code=$2', [b.system, b.code])).rows[0];
      throw new ApiError(409, 'conflict', 'This code is already in the verified table', { current: cur && codeOut(cur) });
    }
    res.status(201).json(codeOut(u.rows[0]));
  }));
  // Result of the live lookup. The client sends only ok (and the display it saw); the server stamps who and when.
  r.post('/codes/:system/:code/live', wrap(async (req, res) => {
    const [system, code] = codeKey(req), b = parse(S.codeLive, req.body);
    const live = { ok: b.ok, checkedAt: new Date().toISOString(), checkedBy: req.actor.id }; if (b.display) live.display = b.display;
    const u = await db.query('UPDATE verified_codes SET verified_live=$3::jsonb WHERE system=$1 AND code=$2 RETURNING *', [system, code, JSON.stringify(live)]);
    if (!u.rows.length) throw new ApiError(404, 'not_found', 'This code is not in the verified table');
    res.json(codeOut(u.rows[0]));
  }));
  r.get('/bindings', wrap(async (req, res) => {
    res.json((await db.query('SELECT set_id,field_id,system,code,display FROM code_bindings ORDER BY set_id,field_id')).rows
      .map((b) => ({ setId: b.set_id, fieldId: b.field_id, system: b.system, code: b.code, display: b.display })));
  }));
  r.put('/bindings', wrap(async (req, res) => {
    const b = parse(S.bindPut, req.body);
    await db.query(`INSERT INTO code_bindings (set_id,field_id,system,code,display) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (set_id,field_id) DO UPDATE SET system=EXCLUDED.system, code=EXCLUDED.code, display=EXCLUDED.display`, [b.setId, b.fieldId, b.system, b.code, b.display]);
    res.json(b);
  }));
  r.delete('/bindings/:setId/:fieldId', wrap(async (req, res) => {
    await db.query('DELETE FROM code_bindings WHERE set_id=$1 AND field_id=$2', [identParam(req.params.setId), identParam(req.params.fieldId)]);
    res.status(204).end();
  }));

  // ================= rules (editing resets approval; approval stamped by the server) =================
  const ruleOut = (x) => ({ ruleId: x.rule_id, ownerSetId: x.owner_set_id, body: x.body, enabled: x.enabled, verifiedBy: x.verified_by_user, verifiedAt: iso(x.verified_at), source: x.source, version: x.version });
  r.get('/rules', wrap(async (req, res) => {
    const o = {};
    for (const x of (await db.query('SELECT * FROM cds_rules ORDER BY owner_set_id, rule_id')).rows) (o[x.owner_set_id] = o[x.owner_set_id] || []).push(ruleOut(x));
    res.json(o);
  }));
  async function ruleConflict(owner, rid) {
    const cur = (await db.query('SELECT * FROM cds_rules WHERE owner_set_id=$1 AND rule_id=$2', [owner, rid])).rows[0];
    if (!cur) throw new ApiError(404, 'not_found', 'Rule not found');
    throw new ApiError(409, 'conflict', 'This rule was changed by someone else', { current: ruleOut(cur) });
  }
  r.put('/rules/:owner/:ruleId', wrap(async (req, res) => {
    const owner = identParam(req.params.owner), rid = identParam(req.params.ruleId), b = parse(S.rulePut, req.body);
    const src = b.body.provenance && b.body.provenance.source === 'ai-drafted' ? 'ai-drafted' : 'manual';
    const q = b.expectedVersion === 0
      ? await db.query(`INSERT INTO cds_rules (owner_set_id,rule_id,body,source,created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`, [owner, rid, JSON.stringify(b.body), src, req.actor.id])
      : await db.query(`UPDATE cds_rules SET body=$3, source=$4, enabled=false, verified_by_user=NULL, verified_at=NULL, version=version+1, updated_at=now()
          WHERE owner_set_id=$1 AND rule_id=$2 AND version=$5 RETURNING *`, [owner, rid, JSON.stringify(b.body), src, b.expectedVersion]);
    if (!q.rows.length) await ruleConflict(owner, rid);
    res.json(ruleOut(q.rows[0]));
  }));
  const ruleToggle = (enable) => wrap(async (req, res) => {
    const owner = identParam(req.params.owner), rid = identParam(req.params.ruleId), b = parse(S.ruleAct, req.body);
    const q = enable
      ? await db.query(`UPDATE cds_rules SET enabled=true, verified_by_user=$4, verified_at=now(), version=version+1, updated_at=now() WHERE owner_set_id=$1 AND rule_id=$2 AND version=$3 RETURNING *`, [owner, rid, b.expectedVersion, req.actor.id])
      : await db.query(`UPDATE cds_rules SET enabled=false, version=version+1, updated_at=now() WHERE owner_set_id=$1 AND rule_id=$2 AND version=$3 RETURNING *`, [owner, rid, b.expectedVersion]);
    if (!q.rows.length) await ruleConflict(owner, rid);
    res.json(ruleOut(q.rows[0]));
  });
  r.post('/rules/:owner/:ruleId/approve', ruleToggle(true));
  r.post('/rules/:owner/:ruleId/disable', ruleToggle(false));
  r.delete('/rules/:owner/:ruleId', wrap(async (req, res) => {
    const v = Number(req.query.expectedVersion);
    if (!Number.isInteger(v) || v < 1) throw new ApiError(400, 'validation', 'expectedVersion query parameter required');
    const d = await db.query('DELETE FROM cds_rules WHERE owner_set_id=$1 AND rule_id=$2 AND version=$3 RETURNING 1', [identParam(req.params.owner), identParam(req.params.ruleId), v]);
    if (!d.rows.length) await ruleConflict(req.params.owner, req.params.ruleId);
    res.status(204).end();
  }));

  // ================= protocols (bands ship empty; typed by clinicians; approval stamped by the server) =================
  const protoOut = (x) => ({ setId: x.set_id, body: x.body, verifiedBy: x.verified_by_user, verifiedAt: iso(x.verified_at), version: x.version });
  async function protoConflict(sid) {
    const cur = (await db.query('SELECT * FROM protocols WHERE set_id=$1', [sid])).rows[0];
    if (!cur) throw new ApiError(404, 'not_found', 'Protocol not found');
    throw new ApiError(409, 'conflict', 'This protocol was changed by someone else', { current: protoOut(cur) });
  }
  r.get('/protocols', wrap(async (req, res) => { const o = {}; for (const x of (await db.query('SELECT * FROM protocols')).rows) o[x.set_id] = protoOut(x); res.json(o); }));
  r.put('/protocols/:setId', wrap(async (req, res) => {
    const sid = identParam(req.params.setId), b = parse(S.protoPut, req.body);
    const q = b.expectedVersion === 0
      ? await db.query('INSERT INTO protocols (set_id,body) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *', [sid, JSON.stringify(b.body)])
      : await db.query(`UPDATE protocols SET body=$2, verified_by_user=NULL, verified_at=NULL, version=version+1, updated_at=now() WHERE set_id=$1 AND version=$3 RETURNING *`, [sid, JSON.stringify(b.body), b.expectedVersion]);
    if (!q.rows.length) await protoConflict(sid);
    res.json(protoOut(q.rows[0]));
  }));
  r.post('/protocols/:setId/approve', wrap(async (req, res) => {
    const sid = identParam(req.params.setId), b = parse(S.ruleAct, req.body);
    const q = await db.query(`UPDATE protocols SET verified_by_user=$3, verified_at=now(), version=version+1, updated_at=now() WHERE set_id=$1 AND version=$2 RETURNING *`, [sid, b.expectedVersion, req.actor.id]);
    if (!q.rows.length) await protoConflict(sid);
    res.json(protoOut(q.rows[0]));
  }));

  // ================= prefs (per user) =================
  r.get('/prefs', wrap(async (req, res) => { const o = {}; for (const x of (await db.query('SELECT key,value FROM user_prefs WHERE user_id=$1', [req.actor.id])).rows) o[x.key] = x.value; res.json(o); }));
  r.put('/prefs/:key', wrap(async (req, res) => {
    const k = identParam(req.params.key), b = parse(S.prefPut, req.body);
    await db.query('INSERT INTO user_prefs (user_id,key,value) VALUES ($1,$2,$3) ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value', [req.actor.id, k, JSON.stringify(b.value)]);
    res.json({ key: k, value: b.value });
  }));

  // consistent errors (server.js also has a final handler for non-API paths)
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message }, ...(err.extra || {}) });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Invalid JSON body' } });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body too large' } });
    if (err && err.code === '23514') return res.status(422).json({ error: { code: 'constraint', message: 'Value rejected by a database rule' } });
    if (err && err.code === '23503') return res.status(422).json({ error: { code: 'reference', message: 'Refers to something that does not exist' } });
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: 'Internal error' } });
  });
  app.use('/api', r);
}

module.exports = { mountApi, ApiError, hashOf, MAX_ROWS_PER_GROUP };
