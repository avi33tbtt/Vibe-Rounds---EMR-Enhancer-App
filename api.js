'use strict';
/**
 * REST API (chunk 28). Mounted by server.js. Every body is validated with zod (strict: unknown
 * fields are rejected). Every versioned write needs expectedVersion and returns 409 + {current}
 * on conflict, never last-write-wins. Clinical data is never deleted: no DELETE route exists for
 * cases, rows, values or notes. Who is acting comes from the login session (auth.js requireAuth, chunk 32a) and what they may do from
 * permissions.js (chunk 32b): every route has exactly one action there, and ids like entered_by, created_by and verified_by come from the
 * session user, never from a request body.
 */
const express = require('express');
const { z } = require('zod');
const crypto = require('node:crypto');
const { can, guardRouter, caseFieldActions, canAddRow, canAmendRow, denied } = require('./permissions.js');
const { audit, auditContext } = require('./audit.js');   // chunk 33a: every write route audits inside its own transaction

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
const reasonText = z.string().trim().min(3).max(1000);
const S = {
  caseCreate: z.object({ id: uuid.optional(), patient: patientObj.optional(), narrative: z.string().max(200000).optional(),
    applied: appliedArr.optional(), pathways: pathwaysArr.optional(), pinned: pinnedArr.optional() }).strict(),
  casePatch: z.object({ expectedVersion: ver, patient: patientObj.optional(), narrative: z.string().max(200000).optional(),
    applied: appliedArr.optional(), pathways: pathwaysArr.optional(), pinned: pinnedArr.optional(), alertLog: alertLogArr.optional() }).strict()
    .refine((o) => Object.keys(o).length > 1, 'nothing to change'),
  rowCreate: z.object({ setId: ident, groupId: ident, row: rowObj, rowTime: isoTime.nullable().optional() }).strict(),
  rowPatch: z.object({ expectedVersion: ver, row: rowObj.optional(), rowTime: isoTime.nullable().optional(), reason: reasonText.optional() }).strict()
    .refine((o) => o.row !== undefined || o.rowTime !== undefined, 'nothing to change'),
  rowError: z.object({ expectedVersion: ver, reason: reasonText }).strict(),       // a reason is always required to mark a row entered in error
  valuePut: z.object({ key: valueKey, value: anyJson(100000), expectedVersion: z.number().int().min(0), reason: reasonText.optional() }).strict(),
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
// chunk 33b: copy the version being replaced into row_versions / value_versions. Call on the SAME transaction client, after the change succeeded.
const saveRowVersion = (q, old, by, reason) => q.query(`INSERT INTO row_versions (row_id,case_id,version,row,row_time,status,error_reason,written_by,written_at,replaced_by,reason)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [old.id, old.case_id, old.version, JSON.stringify(old.row), old.row_time, old.status, old.error_reason,
  old.updated_by || old.entered_by, old.updated_at || old.entered_at, by, reason || null]);
const saveValueVersion = (q, caseId, key, old, by, reason) => q.query(`INSERT INTO value_versions (case_id,key,version,value,written_by,written_at,replaced_by,reason)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [caseId, key, old.version, JSON.stringify(old.value), old.updated_by, old.updated_at, by, reason || null]);
const rowOut = (r) => ({ id: r.id, caseId: r.case_id, setId: r.set_id, groupId: r.group_id, row: r.row, rowTime: iso(r.row_time), version: r.version,
  status: r.status, errorReason: r.error_reason, enteredBy: r.entered_by, enteredAt: iso(r.entered_at) });

// ---------- browser-data import (chunk 31a) ----------
// POST /api/import/dry-run checks and reports, writes nothing. POST /api/import does the same checks, then writes everything in ONE
// transaction or nothing. Re-running skips what is already there (never overwrites). Approvals are never imported: rules arrive
// disabled and unapproved, protocols arrive unverified. Nothing is invented: a problem makes the whole import refuse, with reasons.
const RULE_OPS = ['<', '<=', '>', '>=', '==', '!=', 'minutes_since_gt'], RULE_INDS = ['info', 'warning', 'critical'];
const SET_KINDS = ['care', 'template', 'disease', 'custom', 'pathway'];
const importBody = z.object({
  v: z.number().optional(),
  utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),     // the browser's UTC offset; reads zone-less typed times (see parseTime)
  cases: z.array(z.any()).max(500).optional(), sets: z.array(z.any()).max(500).optional(),
  setUsage: z.record(z.string(), z.any()).optional(), pinned: z.array(z.any()).max(200).nullable().optional(),
  codes: z.record(z.string(), z.any()).optional(), rules: z.record(z.string(), z.any()).optional(), protocols: z.record(z.string(), z.any()).optional(),
}).strict();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isoOf = (v) => { if (typeof v !== 'string' || v.length > 40) return null; const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };
// A time typed in the browser has no zone ('2026-11-18T09:30'). It is read at the browser's UTC offset, not the server's. Unreadable -> null (the row is still kept).
function parseTime(v, off) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const s = v.trim(), m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?)?$/.exec(s);
  if (m) {
    const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)], t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
    if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
    return new Date(t.getTime() - off * 60000).toISOString();
  }
  return /(Z|[+-]\d\d:?\d\d)$/.test(s) ? isoOf(s) : null;
}
function timeCol(body, gid) {                                            // the group's first date/datetime column, as the app finds it
  const fs = [].concat(...((body && body.sections) || []).map((x) => (x && x.fields) || []), (body && body.fields) || []);
  return fs.find((f) => f && f.repeat && (f.group || f.id) === gid && (f.type === 'datetime' || f.type === 'date')) || null;
}
function ruleProblem(r) {
  if (!isObj(r)) return 'not an object';
  if (!ident.safeParse(r.ruleId).success) return 'ruleId missing or not a valid id';
  if (typeof r.fieldRef !== 'string' || !keyRe.test(r.fieldRef) || r.fieldRef.includes('/@')) return 'fieldRef must look like setId/fieldId';
  if (!RULE_OPS.includes(r.op)) return 'operator not allowed';
  if (!(typeof r.threshold === 'number' ? Number.isFinite(r.threshold) : typeof r.threshold === 'string' && r.threshold.trim() !== '' && Number.isFinite(Number(r.threshold)))) return 'threshold must be a number';
  if (!RULE_INDS.includes(r.indicator)) return 'indicator must be info, warning or critical';
  if (typeof r.summary !== 'string' || !r.summary.trim() || r.summary.trim().length > 140) return 'summary must be 1 to 140 characters';
  if ((r.detail !== undefined && (typeof r.detail !== 'string' || r.detail.length > 300)) || (r.unit !== undefined && (typeof r.unit !== 'string' || r.unit.length > 20))) return 'detail (300) or unit (20) too long';
  return null;
}
async function importState(q, actorId) {                                 // what is already on the server (small tables). Sequential: q may be one transaction client.
  const one = async (sql, p) => (await q.query(sql, p)).rows;
  const cs = await one('SELECT id::text id, legacy_id FROM cases'), es = await one('SELECT set_id, body FROM element_sets_latest');
  const cd = await one("SELECT system||'|'||code k FROM verified_codes"), ru = await one("SELECT owner_set_id||'/'||rule_id k FROM cds_rules");
  const pr = await one('SELECT set_id FROM protocols'), us = await one('SELECT set_id FROM set_usage WHERE user_id=$1', [actorId]);
  const pn = await one("SELECT 1 FROM user_prefs WHERE user_id=$1 AND key='pinned'", [actorId]);
  return { caseIds: new Set(cs.map((x) => x.id)), legacy: new Set(cs.map((x) => x.legacy_id).filter(Boolean)), bodies: new Map(es.map((x) => [x.set_id, x.body])),
    codes: new Set(cd.map((x) => x.k)), rules: new Set(ru.map((x) => x.k)), protocols: new Set(pr.map((x) => x.set_id)), usage: new Set(us.map((x) => x.set_id)), pinned: pn.length > 0 };
}
function planImport(b, ex) {
  const off = b.utcOffsetMinutes || 0, rep = { invalid: [], skipped: [], warnings: [], signers: [] }, out = { sets: [], cases: [], codes: [], rules: [], protocols: [], usage: [], pinned: null };
  const bad = (kind, ref, reason) => rep.invalid.push({ kind, ref: String(ref).slice(0, 120), reason });
  const skip = (kind, ref, reason) => rep.skipped.push({ kind, ref: String(ref).slice(0, 120), reason });
  const bodies = new Map(ex.bodies), known = new Set(ex.bodies.keys()), refd = new Map();
  const use = (sid, who) => { if (typeof sid === 'string' && sid) { if (!refd.has(sid)) refd.set(sid, new Set()); refd.get(sid).add(who); } };
  let noTime = 0, strippedRules = 0;

  // ---- sets (user sets only; an id already on the server is never replaced) ----
  const seenSet = new Set();
  (b.sets || []).forEach((s, i) => {
    const ref = (isObj(s) && s.setId) || `sets[${i}]`;
    if (!isObj(s) || !ident.safeParse(s.setId).success) return bad('set', ref, 'setId missing or not a valid id');
    if (!SET_KINDS.includes(s.kind)) return bad('set', ref, 'kind must be one of ' + SET_KINDS.join(', '));
    if (!Array.isArray(s.sections) && !(s.kind === 'pathway' && Array.isArray(s.members))) return bad('set', ref, 'a set needs sections (a pathway needs members)');
    if (ex.bodies.has(s.setId)) return skip('set', ref, 'a set with this id is already on the server; it was not changed');
    if (seenSet.has(s.setId)) return bad('set', ref, 'listed twice in this file');
    const version = Number.isInteger(s.version) && s.version >= 1 && s.version <= 1e6 ? s.version : 1, body = { ...s, setId: s.setId, kind: s.kind, version };
    if ('rules' in body) { delete body.rules; strippedRules++; }
    if (!jsonSize(500000)(body)) return bad('set', ref, 'set too large');
    seenSet.add(s.setId); bodies.set(s.setId, body); known.add(s.setId);
    out.sets.push({ setId: s.setId, version, kind: s.kind, body, hash: hashOf(body) });
  });
  if (strippedRules) rep.warnings.push({ kind: 'set', message: `rules stored inside ${strippedRules} set(s) were not imported; use the rules list, which arrives unapproved` });

  // ---- cases ----
  const seenCase = new Set();
  (b.cases || []).forEach((c, i) => {
    const legacy = isObj(c) ? (typeof c.id === 'string' ? c.id.trim() : Number.isFinite(c.id) ? String(c.id) : '') : '', ref = legacy.slice(0, 120) || `cases[${i}]`, errs = [];
    if (!isObj(c)) return bad('case', ref, 'not an object');
    if (!legacy || legacy.length > 200) return bad('case', ref, 'case id missing or longer than 200 characters');
    if (seenCase.has(legacy)) return bad('case', ref, 'listed twice in this file');
    seenCase.add(legacy);
    if (ex.legacy.has(legacy) || ex.caseIds.has(legacy.toLowerCase())) return skip('case', ref, 'already imported (or already on the server); not imported again');
    const fit = (v, max, what) => { const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''; if (s.length > max) errs.push(`${what} is longer than ${max} characters`); return s.slice(0, max); };
    const p = isObj(c.patient) ? c.patient : {};
    const k = { legacyId: legacy, id: uuid.safeParse(legacy).success ? legacy.toLowerCase() : null, patient: { name: fit(p.name, 200, 'patient name'), ageSex: fit(p.ageSex, 50, 'age/sex'), bed: fit(p.bed, 50, 'bed'), mrn: fit(p.mrn, 50, 'MRN') },
      narrative: fit(c.narrative, 200000, 'narrative'), applied: [], pathways: [], pinned: null, alertLog: [], values: [], rows: [], notes: [], createdAt: isoOf(c.createdAt) || isoOf(c.updatedAt), updatedAt: isoOf(c.updatedAt) };
    for (const a of Array.isArray(c.applied) ? c.applied : []) {
      if (!isObj(a) || !ident.safeParse(a.setId).success) { errs.push('an applied set has no valid setId'); continue; }
      const e = { setId: a.setId, addedAt: typeof a.addedAt === 'string' && a.addedAt.length <= 40 ? a.addedAt : new Date().toISOString() };
      if (Number.isInteger(a.version) && a.version >= 1) e.version = a.version;
      k.applied.push(e); use(a.setId, legacy);
    }
    for (const a of Array.isArray(c.pathways) ? c.pathways : []) {
      if (!isObj(a) || !ident.safeParse(a.pathwayId).success) { errs.push('a pathway entry has no valid pathwayId'); continue; }
      const e = { pathwayId: a.pathwayId, startedAt: typeof a.startedAt === 'string' && a.startedAt.length <= 40 ? a.startedAt : new Date().toISOString() };
      if (Number.isInteger(a.version) && a.version >= 1) e.version = a.version;
      k.pathways.push(e); use(a.pathwayId, legacy);
    }
    if (k.applied.length > 200) errs.push('more than 200 applied sets'); if (k.pathways.length > 50) errs.push('more than 50 pathways');
    if (Array.isArray(c.pinned)) { if (c.pinned.length > 50 || !c.pinned.every((x) => ident.safeParse(x).success)) errs.push('pinned must be up to 50 valid set ids'); else k.pinned = c.pinned; }
    for (const a of Array.isArray(c.alertLog) ? c.alertLog : []) {
      if (isObj(a) && ident.safeParse(a.ruleId).success && typeof a.ackedAt === 'string' && a.ackedAt.length <= 40) k.alertLog.push({ ruleId: a.ruleId, setId: typeof a.setId === 'string' ? a.setId.slice(0, 100) : '', ackedAt: a.ackedAt, sig: typeof a.sig === 'string' ? a.sig.slice(0, 500) : '' });
    }
    if (k.alertLog.length > 2000) errs.push('more than 2000 alert acknowledgements');
    for (const [key, v] of Object.entries(isObj(c.values) ? c.values : {})) {
      const g = /^([A-Za-z0-9_.-]{1,100})\/@([A-Za-z0-9_.-]{1,100})$/.exec(key);
      if (g) {                                                               // a repeat group: each row becomes its own record
        if (!Array.isArray(v)) { errs.push(`${key} must be a list of rows`); continue; }
        if (v.length > MAX_ROWS_PER_GROUP) { errs.push(`${key} has ${v.length} rows (at most ${MAX_ROWS_PER_GROUP})`); continue; }
        const tc = timeCol(bodies.get(g[1]), g[2]); use(g[1], legacy);
        v.forEach((r, ri) => {
          if (!isObj(r)) return errs.push(`${key}[${ri}] is not an object`);
          const row = Object.fromEntries(Object.entries(r).filter(([x]) => !x.startsWith('__')));            // __id, __v ... belong to the server
          if (!jsonSize(20000)(row) || Object.keys(row).some((x) => x.length > 100)) return errs.push(`${key}[${ri}] is too large`);
          let rt = isoOf(r.__time) || (tc ? parseTime(row[tc.id], off) : null);
          if (!rt) noTime++;
          k.rows.push({ ord: k.rows.length, set_id: g[1], group_id: g[2], row, row_time: rt, status: r.__status === 'entered_in_error' ? 'entered_in_error' : 'active',
            error_reason: r.__status === 'entered_in_error' ? 'Marked entered in error before import (original reason not in the export)' : null });
        });
        continue;
      }
      if (!keyRe.test(key) || key.length > 200) { errs.push(`value key "${key.slice(0, 60)}" is not valid`); continue; }
      if (v === undefined) continue;
      const val = /\/__protocol$/.test(key) && isObj(v) ? { ...v, verifiedBy: '', ...('verifiedAt' in v ? { verifiedAt: '' } : {}) } : v;   // approvals are never imported
      if (!jsonSize(100000)(val)) { errs.push(`value ${key} is too large`); continue; }
      k.values.push({ key, value: val }); use(key.split('/')[0], legacy);
    }
    const notes = Array.isArray(c.notes) ? c.notes : [], ids = new Map();
    if (notes.length > 2000) errs.push('more than 2000 notes');
    notes.slice(0, 2000).forEach((n, ni) => {
      if (!isObj(n)) return errs.push(`note ${ni + 1} is not an object`);
      const key = n.id != null ? String(n.id) : '#' + ni;
      if (ids.has(key)) return errs.push(`note id "${key.slice(0, 40)}" is used twice`);
      ids.set(key, crypto.randomUUID());
      if (!['narrative', 'template', 'disease'].includes(n.type)) return errs.push(`note ${ni + 1}: type must be narrative, template or disease`);
      if (n.setId !== undefined && n.setId !== null && !ident.safeParse(n.setId).success) return errs.push(`note ${ni + 1}: invalid setId`);
      if (n.status !== 'draft' && n.status !== 'signed') return errs.push(`note ${ni + 1}: status must be draft or signed`);
      const signedAt = isoOf(n.signedAt);
      if (n.status === 'signed' && !signedAt) return errs.push(`note ${ni + 1}: a signed note needs a valid signing time`);
      const text = fit(n.text, 200000, `note ${ni + 1} text`), reason = typeof n.reason === 'string' ? n.reason.trim() : '';
      if (n.amends != null && !reason) return errs.push(`note ${ni + 1}: an amendment needs a reason`);
      if (n.setId) use(n.setId, legacy);
      k.notes.push({ id: ids.get(key), key, type: n.type, set_id: n.setId || null, text, status: n.status, signed_at: n.status === 'signed' ? signedAt : null, amendsKey: n.amends != null ? String(n.amends) : null,
        reason: reason || null, created_at: isoOf(n.createdAt) });
      if (n.status === 'signed') rep.signers.push({ case: legacy.slice(0, 120), note: key.slice(0, 60), signedBy: typeof n.signedBy === 'string' ? n.signedBy.slice(0, 200) : '' });
    });
    for (const n of k.notes) {
      if (n.amendsKey === null) continue;
      if (n.amendsKey === n.key || !ids.has(n.amendsKey)) errs.push(`note "${n.key.slice(0, 40)}" amends a note that is not in this case`); else n.amends_id = ids.get(n.amendsKey);
    }
    if (errs.length) return bad('case', ref, errs.slice(0, 5).join('; ') + (errs.length > 5 ? ` (+${errs.length - 5} more)` : ''));
    out.cases.push(k);
  });
  if (noTime) rep.warnings.push({ kind: 'row', message: `${noTime} reading(s) have no usable time (the set definition was not found or the typed time could not be read). They are kept and show without a time.` });
  if (rep.signers.length) rep.warnings.push({ kind: 'note', message: `${rep.signers.length} signed note(s) keep their original signing time, but the signer is recorded as the importing user. The original typed names are kept in the import record.` });

  // ---- reference data ----
  for (const [k, d] of Object.entries(b.codes || {})) {
    const [system, code, ...rest] = k.split('|');
    if (rest.length || !sysEnum.safeParse(system).success || !CODE_RE[system].test(code || '')) { bad('code', k, 'must look like snomed|123456 or loinc|1234-5'); continue; }
    if (typeof d !== 'string' || !d.trim() || d.trim().length > 300) { bad('code', k, 'display must be 1 to 300 characters'); continue; }
    if (ex.codes.has(k)) { skip('code', k, 'already in the verified table; not changed'); continue; }
    out.codes.push({ system, code, display: d.trim() });
  }
  if (out.codes.length) rep.warnings.push({ kind: 'code', message: `${out.codes.length} code(s) will join the verified table. Check each against a SNOMED or LOINC browser; the format check cannot tell whether a code is the right concept.` });
  for (const [ow, arr] of Object.entries(b.rules || {})) {
    if (!ident.safeParse(ow).success || !Array.isArray(arr)) { bad('rule', ow, 'owner must be a set id with a list of rules'); continue; }
    const seen = new Set(); use(ow, 'rules');
    for (const r of arr) {
      const ref = `${ow}/${isObj(r) ? r.ruleId : '?'}`, why = ruleProblem(r);
      if (why) { bad('rule', ref, why); continue; }
      if (seen.has(r.ruleId)) { bad('rule', ref, 'listed twice'); continue; }
      seen.add(r.ruleId);
      if (ex.rules.has(ref)) { skip('rule', ref, 'already on the server; not changed'); continue; }
      const source = r.provenance && r.provenance.source === 'ai-drafted' ? 'ai-drafted' : 'manual';
      out.rules.push({ owner: ow, ruleId: r.ruleId, source, body: { ruleId: r.ruleId, fieldRef: r.fieldRef, op: r.op, threshold: Number(r.threshold), unit: r.unit || '', indicator: r.indicator,
        summary: r.summary.trim(), detail: r.detail || '', enabled: false, provenance: { source, verifiedBy: '', verifiedAt: '' } } });
    }
  }
  if (out.rules.length) rep.warnings.push({ kind: 'rule', message: `${out.rules.length} rule(s) will arrive disabled and unapproved. A doctor or admin must approve each one before it can fire.` });
  const str = (v, m) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, m) : '');
  for (const [sid, pr] of Object.entries(b.protocols || {})) {
    if (!ident.safeParse(sid).success || !isObj(pr) || !Array.isArray(pr.bands)) { bad('protocol', sid, 'must be a set id with a bands list'); continue; }
    if (pr.bands.length > 50 || !pr.bands.every(isObj)) { bad('protocol', sid, 'bands must be up to 50 objects'); continue; }
    if (!pr.bands.length) { skip('protocol', sid, 'no bands typed; nothing to import'); continue; }
    if (ex.protocols.has(sid)) { skip('protocol', sid, 'already on the server; not changed'); continue; }
    use(sid, 'protocols');
    out.protocols.push({ setId: sid, body: { verifiedBy: '', bands: pr.bands.map((x) => ({ min: str(x.min, 20), max: str(x.max, 20), instruction: str(x.instruction, 300) })) } });
  }
  if (out.protocols.length) rep.warnings.push({ kind: 'protocol', message: `${out.protocols.length} protocol(s) arrive unverified; re-enter verified-by to use them.` });
  for (const [sid, u] of Object.entries(b.setUsage || {})) {
    if (!ident.safeParse(sid).success || !isObj(u) || !Number.isInteger(u.count) || u.count < 0 || u.count > 1e6) { bad('usage', sid, 'needs a valid set id and a whole-number count'); continue; }
    const dx = u.withDx === undefined ? {} : u.withDx;
    if (!isObj(dx) || Object.keys(dx).length > 200 || Object.entries(dx).some(([x, n]) => !x || x.length > 100 || !Number.isInteger(n) || n < 0 || n > 1e6)) { bad('usage', sid, 'withDx must map short keys to whole numbers'); continue; }
    if (ex.usage.has(sid)) { skip('usage', sid, 'you already have usage for this set; not added again'); continue; }
    out.usage.push({ setId: sid, count: u.count, lastUsed: isoOf(u.lastUsed), withDx: dx });
  }
  if (Array.isArray(b.pinned)) {
    if (b.pinned.length > 50 || !b.pinned.every((x) => ident.safeParse(x).success)) bad('pinned', 'pinned', 'must be up to 50 valid set ids');
    else if (ex.pinned) skip('pinned', 'pinned', 'you already have a default quick bar; not changed'); else out.pinned = b.pinned;
  }
  const orphanedSets = [...refd].filter(([sid]) => !known.has(sid)).map(([sid, who]) => ({ setId: sid, usedBy: who.size })).sort((a, z) => a.setId.localeCompare(z.setId));
  if (orphanedSets.length) rep.warnings.push({ kind: 'set', message: `${orphanedSets.length} set id(s) used by this data are not on the server and not in this file. The data is kept; those sets show as missing until they exist.` });
  const sum = (f) => out.cases.reduce((n, c) => n + c[f].length, 0), by = (a) => a.reduce((o, x) => ((o[x.kind] = (o[x.kind] || 0) + 1), o), {});
  rep.counts = { cases: out.cases.length, rows: sum('rows'), values: sum('values'), notes: sum('notes'), sets: out.sets.length, codes: out.codes.length, rules: out.rules.length,
    protocols: out.protocols.length, usage: out.usage.length, pinned: out.pinned ? 1 : 0 };
  rep.orphanedSets = orphanedSets; rep.skippedCounts = by(rep.skipped); rep.invalidCounts = by(rep.invalid);
  return { rep, out };
}
const reportOut = (rep) => ({ ok: !rep.invalid.length, counts: rep.counts, invalid: rep.invalid.slice(0, 200), invalidCounts: rep.invalidCounts, collisions: rep.skipped.slice(0, 200),
  collisionCounts: rep.skippedCounts, orphanedSets: rep.orphanedSets.slice(0, 200), warnings: rep.warnings });
async function commitImport(c, out, actor) {
  for (const s of out.sets) await c.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier,content_hash,created_by) VALUES ($1,$2,$3,$4,'user',false,'local-draft',$5,$6)`,
    [s.setId, s.version, s.kind, JSON.stringify(s.body), s.hash, actor]);
  const idMap = [];
  for (const k of out.cases) {
    const id = (await c.query(`INSERT INTO cases (id,legacy_id,demo_patient,narrative,applied,pathways,pinned,alert_log,created_by,created_at,updated_at)
      VALUES (COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz,now()),COALESCE($11::timestamptz,now())) RETURNING id`,
      [k.id, k.legacyId, JSON.stringify(k.patient), k.narrative, JSON.stringify(k.applied), JSON.stringify(k.pathways), k.pinned === null ? null : JSON.stringify(k.pinned),
        JSON.stringify(k.alertLog), actor, k.createdAt, k.updatedAt])).rows[0].id;
    idMap.push({ legacyId: k.legacyId, id });
    if (k.values.length) await c.query('INSERT INTO case_values (case_id,key,value,updated_by) SELECT $1, x.key, x.value, $3 FROM jsonb_to_recordset($2::jsonb) AS x(key text, value jsonb)', [id, JSON.stringify(k.values), actor]);
    if (k.rows.length) await c.query(`INSERT INTO case_rows (case_id,set_id,group_id,row,row_time,status,error_reason,entered_by,entered_at)
      SELECT $1, x.set_id, x.group_id, x.row, x.row_time, x.status, x.error_reason, $3, now() + x.ord * interval '1 microsecond'
      FROM jsonb_to_recordset($2::jsonb) AS x(ord int, set_id text, group_id text, row jsonb, row_time timestamptz, status text, error_reason text)`, [id, JSON.stringify(k.rows), actor]);
    for (const n of k.notes) await c.query(`INSERT INTO case_notes (id,case_id,type,set_id,text,status,signed_by,signed_at,reason,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz,now()))`,
      [n.id, id, n.type, n.set_id, n.text, n.status, n.status === 'signed' ? actor : null, n.signed_at, n.reason, actor, n.created_at]);
    for (const n of k.notes) if (n.amends_id) await c.query('UPDATE case_notes SET amends_id=$2 WHERE id=$1', [n.id, n.amends_id]);
  }
  for (const x of out.codes) await c.query('INSERT INTO verified_codes (system,code,display,added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [x.system, x.code, x.display, actor]);
  for (const x of out.rules) await c.query(`INSERT INTO cds_rules (owner_set_id,rule_id,body,source,enabled,created_by) VALUES ($1,$2,$3,$4,false,$5) ON CONFLICT DO NOTHING`, [x.owner, x.ruleId, JSON.stringify(x.body), x.source, actor]);
  for (const x of out.protocols) await c.query('INSERT INTO protocols (set_id,body) VALUES ($1,$2) ON CONFLICT DO NOTHING', [x.setId, JSON.stringify(x.body)]);
  for (const x of out.usage) await c.query('INSERT INTO set_usage (user_id,set_id,count,last_used,with_dx) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [actor, x.setId, x.count, x.lastUsed, JSON.stringify(x.withDx)]);
  if (out.pinned) await c.query("INSERT INTO user_prefs (user_id,key,value) VALUES ($1,'pinned',$2) ON CONFLICT DO NOTHING", [actor, JSON.stringify(out.pinned)]);
  return idMap;
}

/**
 * requireAuth (from auth.js) identifies the user from the session cookie. `getActor` is a TEST-ONLY override (returns {id, role}); it is refused when
 * NODE_ENV=production, so a deployed server can only ever use real sessions.
 */
function mountApi(app, { db, getActor, requireAuth, requireCsrf }) {
  if (getActor && process.env.NODE_ENV === 'production') throw new Error('getActor is for tests only and is not allowed when NODE_ENV=production');
  if (!getActor && !(requireAuth && requireCsrf)) throw new Error('mountApi needs requireAuth and requireCsrf');
  const r = guardRouter(express.Router());            // every route below must have an action in permissions.js ROUTE_ACTIONS
  r.use(getActor
    ? (req, res, next) => { Promise.resolve(getActor(req)).then((a) => { req.actor = a; next(); }, next); }
    : (req, res, next) => requireAuth(req, res, (e) => { if (e) return next(e); req.actor = { id: req.user.id, name: req.user.name, role: req.user.role }; requireCsrf(req, res, next); }));
  r.use(auditContext);                                // who/role/ip for audit(); every write below runs inside it
  const setKindOf = async (setId) => ((await db.query('SELECT kind FROM element_sets_latest WHERE set_id=$1', [setId])).rows[0] || {}).kind || null;

  // ================= who am I (the session user) =================
  r.get('/me', wrap(async (req, res) => {
    const u = (await db.query('SELECT id,name,role FROM users WHERE id=$1', [req.actor.id])).rows[0];
    if (!u) throw new ApiError(401, 'unauthorized', 'No such user');
    res.json({ id: u.id, name: u.name, role: u.role, mode: 'session' });
  }));

  // ================= cases =================
  r.get('/cases', wrap(async (req, res) => {
    const q = await db.query('SELECT id,narrative,demo_patient,applied,pathways,version,updated_at FROM cases ORDER BY updated_at DESC LIMIT 1000');
    res.json(q.rows.map((c) => ({ id: c.id, patient: c.demo_patient, preview: (c.narrative || '').slice(0, 80), appliedCount: c.applied.length,
      pathways: c.pathways.map((p) => p.pathwayId), version: c.version, updatedAt: iso(c.updated_at) })));
  }));
  r.get('/cases/:id', wrap(async (req, res) => {
    const wantErrors = req.query.include_errors === 'true' || req.query.includeErrors === '1';            // rows marked entered in error: hidden unless asked for
    if (wantErrors && !can(req.actor, 'case.read_errors')) return denied(res, req.actor, 'see rows entered in error');   // doctors and admins only
    const c = await loadCase(db, idParam(req.params.id), { includeErrors: wantErrors });
    if (!c) throw new ApiError(404, 'not_found', 'Case not found');
    res.json(c);
  }));
  r.post('/cases', wrap(async (req, res) => {
    const b = parse(S.caseCreate, req.body);
    const id = await db.withTx(async (c) => {
      const ins = await c.query(`INSERT INTO cases (id,demo_patient,narrative,applied,pathways,pinned,created_by)
        VALUES (COALESCE($1,gen_random_uuid()),$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [b.id || null, b.patient || { name: '', ageSex: '', bed: '', mrn: '' }, b.narrative || '', JSON.stringify(b.applied || []),
          JSON.stringify(b.pathways || []), b.pinned === undefined ? null : JSON.stringify(b.pinned), req.actor.id]);
      if (!ins.rows.length) throw new ApiError(409, 'conflict', 'A case with this id already exists', { current: await loadCase(db, b.id) });   // loadCase runs parallel queries: pool, not the tx client
      await audit(c, { action: 'case.create', entity: 'case', entity_id: ins.rows[0].id, case_id: ins.rows[0].id, after: { patient: b.patient, narrative: b.narrative, applied: b.applied, pathways: b.pathways } });
      return ins.rows[0].id;
    });
    res.status(201).json(await loadCase(db, id));
  }));
  r.patch('/cases/:id', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.casePatch, req.body), sets = [], p = [id, b.expectedVersion];
    for (const a of caseFieldActions(b)) if (!can(req.actor, a)) return denied(res, req.actor, 'change this part of the case (' + a + ')');
    const add = (col, v, json) => { p.push(json ? JSON.stringify(v) : v); sets.push(`${col}=$${p.length}`); };
    if (b.patient !== undefined) add('demo_patient', b.patient, true);
    if (b.narrative !== undefined) add('narrative', b.narrative);
    if (b.applied !== undefined) add('applied', b.applied, true);
    if (b.pathways !== undefined) add('pathways', b.pathways, true);
    if (b.pinned !== undefined) add('pinned', b.pinned, true);
    if (b.alertLog !== undefined) add('alert_log', b.alertLog, true);
    await db.withTx(async (c) => {
      const old = (await c.query('SELECT demo_patient AS patient, narrative, applied, pathways, pinned, alert_log AS "alertLog" FROM cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
      const u = await c.query(`UPDATE cases SET ${sets.join(',')}, version=version+1, updated_at=now() WHERE id=$1 AND version=$2 RETURNING id`, p);
      if (!u.rows.length) await conflict(db, id, 'This case');
      const keys = Object.keys(b).filter((k) => k !== 'expectedVersion');              // before/after hold only the fields this request changed
      await audit(c, { action: 'case.update', entity: 'case', entity_id: id, case_id: id,
        before: Object.fromEntries(keys.map((k) => [k, old[k]])), after: Object.fromEntries(keys.map((k) => [k, b[k]])) });
    });
    res.json(await loadCase(db, id));
  }));

  // ================= rows (append-only; never DELETE) =================
  r.post('/cases/:id/rows', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.rowCreate, req.body);
    if (!canAddRow(req.actor, await setKindOf(b.setId))) throw new ApiError(403, 'forbidden', 'Your role may add readings to care flowsheets only');
    const out = await db.withTx(async (c) => {
      if (!(await c.query('SELECT 1 FROM cases WHERE id=$1', [id])).rows.length) throw new ApiError(404, 'not_found', 'Case not found');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${id}|${b.setId}|${b.groupId}`]);   // serialises the row COUNT only, appends never conflict
      const n = (await c.query('SELECT count(*)::int n FROM case_rows WHERE case_id=$1 AND set_id=$2 AND group_id=$3', [id, b.setId, b.groupId])).rows[0].n;
      if (n >= MAX_ROWS_PER_GROUP) throw new ApiError(422, 'too_many_rows', `A repeat group holds at most ${MAX_ROWS_PER_GROUP} rows`);
      const ins = await c.query(`INSERT INTO case_rows (case_id,set_id,group_id,row,row_time,entered_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, b.setId, b.groupId, JSON.stringify(b.row), b.rowTime || null, req.actor.id]);
      await touch(c, id);
      await audit(c, { action: 'row.add', entity: 'case_row', entity_id: ins.rows[0].id, case_id: id, after: { setId: b.setId, groupId: b.groupId, row: b.row, rowTime: b.rowTime || null } });
      return ins.rows[0];
    });
    res.status(201).json(rowOut(out));
  }));
  async function assertRowAmend(req, id, rid) {           // doctors and admins amend any row; a nurse only her own readings in care sets
    if (can(req.actor, 'row.amend_any')) return;
    const row = (await db.query('SELECT set_id,entered_by FROM case_rows WHERE id=$1 AND case_id=$2', [rid, id])).rows[0];
    if (row && !canAmendRow(req.actor, row, await setKindOf(row.set_id))) throw new ApiError(403, 'forbidden', 'Your role may amend only readings you entered yourself, in care flowsheets');
  }
  r.patch('/cases/:id/rows/:rowId', wrap(async (req, res) => {
    const id = idParam(req.params.id), rid = idParam(req.params.rowId), b = parse(S.rowPatch, req.body);
    await assertRowAmend(req, id, rid);
    const sets = [], p = [rid, id, b.expectedVersion];
    if (b.row !== undefined) { p.push(JSON.stringify(b.row)); sets.push(`row=$${p.length}`); }
    if (b.rowTime !== undefined) { p.push(b.rowTime); sets.push(`row_time=$${p.length}`); }
    p.push(req.actor.id); sets.push(`updated_by=$${p.length}`, 'updated_at=now()');            // who wrote this version (the old one is kept below)
    const out = await db.withTx(async (c) => {
      const old = (await c.query('SELECT * FROM case_rows WHERE id=$1 AND case_id=$2 FOR UPDATE', [rid, id])).rows[0];
      const u = await c.query(`UPDATE case_rows SET ${sets.join(',')}, version=version+1 WHERE id=$1 AND case_id=$2 AND version=$3 AND status='active' RETURNING *`, p);
      if (!u.rows.length) {
        const cur = (await c.query('SELECT * FROM case_rows WHERE id=$1 AND case_id=$2', [rid, id])).rows[0];
        if (!cur) throw new ApiError(404, 'not_found', 'Row not found');
        if (cur.status !== 'active') throw new ApiError(422, 'entered_in_error', 'This row was entered in error and cannot be edited', { current: rowOut(cur) });
        throw new ApiError(409, 'conflict', 'This row was changed by someone else', { current: rowOut(cur) });
      }
      await saveRowVersion(c, old, req.actor.id, b.reason);                                    // the version just replaced stays, in the same transaction
      await touch(c, id);
      await audit(c, { action: 'row.amend', entity: 'case_row', entity_id: rid, case_id: id, reason: b.reason,
        before: { row: old.row, rowTime: iso(old.row_time), version: old.version }, after: { row: u.rows[0].row, rowTime: iso(u.rows[0].row_time), version: u.rows[0].version } });
      return u.rows[0];
    });
    res.json(rowOut(out));
  }));
  r.post('/cases/:id/rows/:rowId/error', wrap(async (req, res) => {
    const id = idParam(req.params.id), rid = idParam(req.params.rowId), b = parse(S.rowError, req.body);
    await assertRowAmend(req, id, rid);
    const out = await db.withTx(async (c) => {
      const old = (await c.query('SELECT * FROM case_rows WHERE id=$1 AND case_id=$2 FOR UPDATE', [rid, id])).rows[0];
      const u = await c.query(`UPDATE case_rows SET status='entered_in_error', error_reason=$4, version=version+1, updated_by=$5, updated_at=now()
        WHERE id=$1 AND case_id=$2 AND version=$3 AND status='active' RETURNING *`, [rid, id, b.expectedVersion, b.reason, req.actor.id]);
      if (!u.rows.length) {
        const cur = (await c.query('SELECT * FROM case_rows WHERE id=$1 AND case_id=$2', [rid, id])).rows[0];
        if (!cur) throw new ApiError(404, 'not_found', 'Row not found');
        throw new ApiError(409, 'conflict', 'This row was changed by someone else', { current: rowOut(cur) });
      }
      await saveRowVersion(c, old, req.actor.id, b.reason);                                    // hidden, never removed: the last good version and the reason stay
      await touch(c, id);
      await audit(c, { action: 'row.entered_in_error', entity: 'case_row', entity_id: rid, case_id: id, reason: b.reason,
        before: { status: 'active', version: b.expectedVersion }, after: { status: 'entered_in_error', version: u.rows[0].version } });
      return u.rows[0];
    });
    res.json(rowOut(out));
  }));

  // ================= values =================
  r.put('/cases/:id/values', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.valuePut, req.body);
    if (!(await db.query('SELECT 1 FROM cases WHERE id=$1', [id])).rows.length) throw new ApiError(404, 'not_found', 'Case not found');
    const out = await db.withTx(async (c) => {
      const old = (await c.query('SELECT value, version, updated_by, updated_at FROM case_values WHERE case_id=$1 AND key=$2 FOR UPDATE', [id, b.key])).rows[0] || null;
      const q = b.expectedVersion === 0
        ? await c.query(`INSERT INTO case_values (case_id,key,value,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key,value,version`,
          [id, b.key, JSON.stringify(b.value), req.actor.id])
        : await c.query(`UPDATE case_values SET value=$3, version=version+1, updated_by=$4, updated_at=now() WHERE case_id=$1 AND key=$2 AND version=$5 RETURNING key,value,version`,
          [id, b.key, JSON.stringify(b.value), req.actor.id, b.expectedVersion]);
      if (!q.rows.length) throw new ApiError(409, 'conflict', 'This value was changed by someone else', { current: old && { key: b.key, value: old.value, version: old.version } });
      if (b.expectedVersion > 0) await saveValueVersion(c, id, b.key, old, req.actor.id, b.reason);   // the version just replaced stays, in the same transaction
      await touch(c, id);
      await audit(c, { action: 'value.set', entity: 'case_value', entity_id: b.key, case_id: id, reason: b.reason, before: old && { value: old.value, version: old.version }, after: { value: q.rows[0].value, version: q.rows[0].version } });
      return q.rows[0];
    });
    res.json(out);
  }));

  // ================= notes (draft -> signed; amend creates a new note) =================
  const noteOut = (n) => ({ id: n.id, caseId: n.case_id, type: n.type, setId: n.set_id, text: n.text, status: n.status, signedBy: n.signed_by,
    signedAt: iso(n.signed_at), amends: n.amends_id, reason: n.reason, createdAt: iso(n.created_at), version: n.version });
  r.post('/cases/:id/notes', wrap(async (req, res) => {
    const id = idParam(req.params.id), b = parse(S.noteCreate, req.body);
    if (!(await db.query('SELECT 1 FROM cases WHERE id=$1', [id])).rows.length) throw new ApiError(404, 'not_found', 'Case not found');
    const n = await db.withTx(async (c) => {
      const ins = await c.query(`INSERT INTO case_notes (id,case_id,type,set_id,text,created_by) VALUES (COALESCE($1,gen_random_uuid()),$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING *`,
        [b.id || null, id, b.type, b.setId || null, b.text || '', req.actor.id]);
      if (!ins.rows.length) throw new ApiError(409, 'conflict', 'A note with this id already exists');
      await touch(c, id);
      await audit(c, { action: 'note.create', entity: 'case_note', entity_id: ins.rows[0].id, case_id: id, after: { type: b.type, setId: b.setId || null, text: b.text || '' } });
      return ins.rows[0];
    });
    res.status(201).json(noteOut(n));
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
    return db.withTx(async (c) => {
      const old = (await c.query('SELECT text, version FROM case_notes WHERE id=$1 AND case_id=$2 FOR UPDATE', [nid, cid])).rows[0];
      const u = await c.query(`UPDATE case_notes SET text=$4, version=version+1 WHERE id=$1 AND case_id=$2 AND version=$3 AND status='draft' RETURNING *`, [nid, cid, b.expectedVersion, b.text]);
      if (!u.rows.length) await noteConflict(c, cid, nid);
      await touch(c, cid);
      await audit(c, { action: 'note.edit', entity: 'case_note', entity_id: nid, case_id: cid, before: { text: old.text, version: old.version }, after: { text: b.text, version: u.rows[0].version } });
      return u.rows[0];
    });
  })));
  r.post('/cases/:id/notes/:nid/sign', wrap((req, res) => noteAct(req, res, async (cid, nid) => {
    const b = parse(S.noteSign, req.body);                // signer comes from the session, never the body
    return db.withTx(async (c) => {
      const u = await c.query(`UPDATE case_notes SET status='signed', signed_by=$4, signed_at=now(), version=version+1
        WHERE id=$1 AND case_id=$2 AND version=$3 AND status='draft' RETURNING *`, [nid, cid, b.expectedVersion, req.actor.id]);
      if (!u.rows.length) await noteConflict(c, cid, nid);
      await touch(c, cid);
      await audit(c, { action: 'note.sign', entity: 'case_note', entity_id: nid, case_id: cid, before: { status: 'draft', version: b.expectedVersion }, after: { status: 'signed', version: u.rows[0].version } });
      return u.rows[0];
    });
  })));
  r.post('/cases/:id/notes/:nid/amend', wrap(async (req, res) => {
    const cid = idParam(req.params.id), nid = idParam(req.params.nid), b = parse(S.noteAmend, req.body);
    const n = await db.withTx(async (c) => {
      const orig = (await c.query('SELECT * FROM case_notes WHERE id=$1 AND case_id=$2', [nid, cid])).rows[0];
      if (!orig) throw new ApiError(404, 'not_found', 'Note not found');
      if (orig.status !== 'signed') throw new ApiError(422, 'not_signed', 'Only a signed note can be amended');
      const ins = await c.query(`INSERT INTO case_notes (case_id,type,set_id,text,amends_id,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [cid, orig.type, orig.set_id, b.text, nid, b.reason, req.actor.id]);
      await touch(c, cid);
      await audit(c, { action: 'note.amend', entity: 'case_note', entity_id: ins.rows[0].id, case_id: cid, reason: b.reason, before: { amends: nid, text: orig.text }, after: { text: b.text } });
      return ins.rows[0];
    });
    res.status(201).json(noteOut(n));
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
      const saved = (await c.query(`INSERT INTO element_sets (set_id,version,kind,body,source,read_only,tier,content_hash,created_by) VALUES ($1,$2,$3,$4,'user',false,'local-draft',$5,$6) RETURNING *`,
        [b.setId, v, b.kind, JSON.stringify(body), hashOf(body), req.actor.id])).rows[0];
      await audit(c, { action: 'set.save', entity: 'element_set', entity_id: b.setId, before: cur ? { version: cur.version, contentHash: cur.content_hash } : null, after: { version: v, kind: b.kind, contentHash: saved.content_hash } });
      return saved;
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
      await audit(c, { action: 'usage.count', entity: 'set_usage', entity_id: sid, after: { count: u.count, dx: dl } });
      return u;
    });
    res.json({ count: out.count, lastUsed: iso(out.last_used), withDx: out.with_dx });
  }));
  r.delete('/usage', wrap(async (req, res) => {
    await db.withTx(async (c) => {
      const d = await c.query('DELETE FROM set_usage WHERE user_id=$1', [req.actor.id]);
      await audit(c, { action: 'usage.clear', entity: 'set_usage', entity_id: req.actor.id, before: { rows: d.rowCount } });
    });
    res.status(204).end();
  }));

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
    const row = await db.withTx(async (c) => {
      const u = await c.query('INSERT INTO verified_codes (system,code,display,added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (system,code) DO NOTHING RETURNING *', [b.system, b.code, b.display, req.actor.id]);
      if (!u.rows.length) {
        const cur = (await c.query('SELECT * FROM verified_codes WHERE system=$1 AND code=$2', [b.system, b.code])).rows[0];
        throw new ApiError(409, 'conflict', 'This code is already in the verified table', { current: cur && codeOut(cur) });
      }
      await audit(c, { action: 'code.add', entity: 'verified_code', entity_id: `${b.system}/${b.code}`, after: { display: b.display } });
      return u.rows[0];
    });
    res.status(201).json(codeOut(row));
  }));
  // Result of the live lookup. The client sends only ok (and the display it saw); the server stamps who and when.
  r.post('/codes/:system/:code/live', wrap(async (req, res) => {
    const [system, code] = codeKey(req), b = parse(S.codeLive, req.body);
    const live = { ok: b.ok, checkedAt: new Date().toISOString(), checkedBy: req.actor.id }; if (b.display) live.display = b.display;
    const row = await db.withTx(async (c) => {
      const old = (await c.query('SELECT verified_live FROM verified_codes WHERE system=$1 AND code=$2 FOR UPDATE', [system, code])).rows[0];
      if (!old) throw new ApiError(404, 'not_found', 'This code is not in the verified table');
      const u = await c.query('UPDATE verified_codes SET verified_live=$3::jsonb WHERE system=$1 AND code=$2 RETURNING *', [system, code, JSON.stringify(live)]);
      await audit(c, { action: 'code.verify_live', entity: 'verified_code', entity_id: `${system}/${code}`, before: old.verified_live, after: live });
      return u.rows[0];
    });
    res.json(codeOut(row));
  }));
  r.get('/bindings', wrap(async (req, res) => {
    res.json((await db.query('SELECT set_id,field_id,system,code,display FROM code_bindings ORDER BY set_id,field_id')).rows
      .map((b) => ({ setId: b.set_id, fieldId: b.field_id, system: b.system, code: b.code, display: b.display })));
  }));
  r.put('/bindings', wrap(async (req, res) => {
    const b = parse(S.bindPut, req.body);
    await db.withTx(async (c) => {
      const old = (await c.query('SELECT system,code,display FROM code_bindings WHERE set_id=$1 AND field_id=$2 FOR UPDATE', [b.setId, b.fieldId])).rows[0] || null;
      await c.query(`INSERT INTO code_bindings (set_id,field_id,system,code,display) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (set_id,field_id) DO UPDATE SET system=EXCLUDED.system, code=EXCLUDED.code, display=EXCLUDED.display`, [b.setId, b.fieldId, b.system, b.code, b.display]);
      await audit(c, { action: 'binding.set', entity: 'code_binding', entity_id: `${b.setId}/${b.fieldId}`, before: old, after: { system: b.system, code: b.code, display: b.display } });
    });
    res.json(b);
  }));
  r.delete('/bindings/:setId/:fieldId', wrap(async (req, res) => {
    const sid = identParam(req.params.setId), fid = identParam(req.params.fieldId);
    await db.withTx(async (c) => {
      const d = await c.query('DELETE FROM code_bindings WHERE set_id=$1 AND field_id=$2 RETURNING system,code,display', [sid, fid]);
      await audit(c, { action: 'binding.delete', entity: 'code_binding', entity_id: `${sid}/${fid}`, before: d.rows[0] || null });
    });
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
    const row = await db.withTx(async (c) => {
      const old = (await c.query('SELECT body,enabled,version FROM cds_rules WHERE owner_set_id=$1 AND rule_id=$2 FOR UPDATE', [owner, rid])).rows[0] || null;
      const q = b.expectedVersion === 0
        ? await c.query(`INSERT INTO cds_rules (owner_set_id,rule_id,body,source,created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`, [owner, rid, JSON.stringify(b.body), src, req.actor.id])
        : await c.query(`UPDATE cds_rules SET body=$3, source=$4, enabled=false, verified_by_user=NULL, verified_at=NULL, version=version+1, updated_at=now()
            WHERE owner_set_id=$1 AND rule_id=$2 AND version=$5 RETURNING *`, [owner, rid, JSON.stringify(b.body), src, b.expectedVersion]);
      if (!q.rows.length) await ruleConflict(owner, rid);
      await audit(c, { action: 'rule.save', entity: 'cds_rule', entity_id: `${owner}/${rid}`, before: old, after: { body: b.body, enabled: false, version: q.rows[0].version } });
      return q.rows[0];
    });
    res.json(ruleOut(row));
  }));
  const ruleToggle = (enable) => wrap(async (req, res) => {
    const owner = identParam(req.params.owner), rid = identParam(req.params.ruleId), b = parse(S.ruleAct, req.body);
    const row = await db.withTx(async (c) => {
      const q = enable
        ? await c.query(`UPDATE cds_rules SET enabled=true, verified_by_user=$4, verified_at=now(), version=version+1, updated_at=now() WHERE owner_set_id=$1 AND rule_id=$2 AND version=$3 RETURNING *`, [owner, rid, b.expectedVersion, req.actor.id])
        : await c.query(`UPDATE cds_rules SET enabled=false, version=version+1, updated_at=now() WHERE owner_set_id=$1 AND rule_id=$2 AND version=$3 RETURNING *`, [owner, rid, b.expectedVersion]);
      if (!q.rows.length) await ruleConflict(owner, rid);
      await audit(c, { action: enable ? 'rule.approve' : 'rule.disable', entity: 'cds_rule', entity_id: `${owner}/${rid}`,
        before: { enabled: !enable, version: b.expectedVersion }, after: { enabled: enable, version: q.rows[0].version } });
      return q.rows[0];
    });
    res.json(ruleOut(row));
  });
  r.post('/rules/:owner/:ruleId/approve', ruleToggle(true));
  r.post('/rules/:owner/:ruleId/disable', ruleToggle(false));
  r.delete('/rules/:owner/:ruleId', wrap(async (req, res) => {
    const v = Number(req.query.expectedVersion);
    if (!Number.isInteger(v) || v < 1) throw new ApiError(400, 'validation', 'expectedVersion query parameter required');
    const owner = identParam(req.params.owner), rid = identParam(req.params.ruleId);
    await db.withTx(async (c) => {
      const d = await c.query('DELETE FROM cds_rules WHERE owner_set_id=$1 AND rule_id=$2 AND version=$3 RETURNING body,enabled,version', [owner, rid, v]);
      if (!d.rows.length) await ruleConflict(owner, rid);
      await audit(c, { action: 'rule.delete', entity: 'cds_rule', entity_id: `${owner}/${rid}`, before: d.rows[0] });
    });
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
    const row = await db.withTx(async (c) => {
      const old = (await c.query('SELECT body,version FROM protocols WHERE set_id=$1 FOR UPDATE', [sid])).rows[0] || null;
      const q = b.expectedVersion === 0
        ? await c.query('INSERT INTO protocols (set_id,body) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *', [sid, JSON.stringify(b.body)])
        : await c.query(`UPDATE protocols SET body=$2, verified_by_user=NULL, verified_at=NULL, version=version+1, updated_at=now() WHERE set_id=$1 AND version=$3 RETURNING *`, [sid, JSON.stringify(b.body), b.expectedVersion]);
      if (!q.rows.length) await protoConflict(sid);
      await audit(c, { action: 'protocol.save', entity: 'protocol', entity_id: sid, before: old, after: { body: b.body, version: q.rows[0].version } });
      return q.rows[0];
    });
    res.json(protoOut(row));
  }));
  r.post('/protocols/:setId/approve', wrap(async (req, res) => {
    const sid = identParam(req.params.setId), b = parse(S.ruleAct, req.body);
    const row = await db.withTx(async (c) => {
      const q = await c.query(`UPDATE protocols SET verified_by_user=$3, verified_at=now(), version=version+1, updated_at=now() WHERE set_id=$1 AND version=$2 RETURNING *`, [sid, b.expectedVersion, req.actor.id]);
      if (!q.rows.length) await protoConflict(sid);
      await audit(c, { action: 'protocol.approve', entity: 'protocol', entity_id: sid, before: { version: b.expectedVersion }, after: { version: q.rows[0].version } });
      return q.rows[0];
    });
    res.json(protoOut(row));
  }));

  // ================= prefs (per user) =================
  r.get('/prefs', wrap(async (req, res) => { const o = {}; for (const x of (await db.query('SELECT key,value FROM user_prefs WHERE user_id=$1', [req.actor.id])).rows) o[x.key] = x.value; res.json(o); }));
  r.put('/prefs/:key', wrap(async (req, res) => {
    const k = identParam(req.params.key), b = parse(S.prefPut, req.body);
    await db.withTx(async (c) => {
      const old = (await c.query('SELECT value FROM user_prefs WHERE user_id=$1 AND key=$2 FOR UPDATE', [req.actor.id, k])).rows[0];
      await c.query('INSERT INTO user_prefs (user_id,key,value) VALUES ($1,$2,$3) ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value', [req.actor.id, k, JSON.stringify(b.value)]);
      await audit(c, { action: 'pref.set', entity: 'user_pref', entity_id: k, before: old ? { value: old.value } : null, after: { value: b.value } });
    });
    res.json({ key: k, value: b.value });
  }));

  // ================= import of browser data (chunk 31a) =================
  r.post('/import/dry-run', wrap(async (req, res) => {
    const b = parse(importBody, req.body), { rep } = planImport(b, await importState(db, req.actor.id));
    res.json({ dryRun: true, ...reportOut(rep) });                          // writes nothing, not even an imports row
  }));
  r.post('/import', wrap(async (req, res) => {
    const b = parse(importBody, req.body);
    const done = await db.withTx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['import']);       // two imports at once cannot both pass the "already there" check
      const plan = planImport(b, await importState(c, req.actor.id));
      if (plan.rep.invalid.length) return { rep: plan.rep };
      const idMap = await commitImport(c, plan.out, req.actor.id), full = reportOut(plan.rep);
      const rec = (await c.query(`INSERT INTO imports (user_id,source,status,counts,report) VALUES ($1,'browser','committed',$2,$3) RETURNING id`,
        [req.actor.id, JSON.stringify(plan.rep.counts), JSON.stringify({ ...full, signers: plan.rep.signers })])).rows[0].id;
      await audit(c, { action: 'import.commit', entity: 'import', entity_id: rec, after: { counts: plan.rep.counts } });
      return { rep: plan.rep, idMap, importId: rec };
    });
    if (!done.idMap) {                                                       // refused: nothing was written except this record of the attempt (and its audit row)
      const full = reportOut(done.rep);
      await db.withTx(async (c) => {
        const rec = (await c.query(`INSERT INTO imports (user_id,source,status,counts,report) VALUES ($1,'browser','failed',$2,$3) RETURNING id`, [req.actor.id, JSON.stringify(done.rep.counts), JSON.stringify(full)])).rows[0].id;
        await audit(c, { action: 'import.failed', entity: 'import', entity_id: rec, after: { counts: done.rep.counts, invalid: done.rep.invalid.length } });
      });
      throw new ApiError(422, 'import_invalid', `Nothing was imported: ${done.rep.invalid.length} problem(s) found. Fix them or remove those items and try again.`, { report: full });
    }
    res.status(201).json({ status: 'committed', importId: done.importId, cases: done.idMap, ...reportOut(done.rep) });
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
