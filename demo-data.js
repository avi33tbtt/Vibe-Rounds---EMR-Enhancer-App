'use strict';
// Demo data generator (task D2a). Pure: no I/O, no clock, no Math.random. Reads persona data only; names no set id, field id or option text.
// Contract: DEMO-DATA.md. Same seed + same anchor => identical output.
const BANNED = ['min', 'max', 'threshold', 'band', 'target', 'limit', 'dose', 'default', 'phone', 'nationalId'];
const UNIT = { m: 60000, h: 3600000, d: 86400000 };
const BAD_TIME = 'not a time';

function offsetMs(s) {
  const m = /^([+-]?)(\d+)(m|h|d)$/.exec(String(s));
  if (!m) throw new Error('bad offset: ' + s);
  return (m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT[m[3]];
}
function rngOf(seed) {                       // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
const iso = (ms) => new Date(ms).toISOString();

function genValue(g, rnd, i, atMs) {          // always uses exactly one random number, so edits elsewhere do not shift it
  const r = rnd(), o = g.options || [], [lo, hi] = g.plausible || [0, 0];
  switch (g.gen) {
    case 'int': return String(Math.round(lo + r * (hi - lo)));
    case 'decimal': return (lo + r * (hi - lo)).toFixed(g.places == null ? 1 : g.places);
    case 'cycle': return o[i % o.length];
    case 'pick': case 'text': return o[Math.floor(r * o.length)];
    case 'rowDate': return iso(atMs).slice(0, 10);
    case 'date': return iso(atMs + offsetMs(g.offset)).slice(0, 10);
    case 'datetime': return iso(atMs + offsetMs(g.offset));
    case 'blank': return '';
    default: throw new Error('unknown gen: ' + g.gen);
  }
}

function validatePersonas(personas) {
  const errors = [], ids = new Set(), keys = new Set(), bad = (m) => errors.push(m);
  const off = (v, what) => { try { if (offsetMs(v) > 0) bad(what + ' is after the anchor: ' + v); } catch (e) { bad(what + ': ' + e.message); } };
  const walk = (v, where) => { if (Array.isArray(v)) v.forEach((x) => walk(x, where)); else if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (BANNED.includes(k)) bad(where + ' has banned key "' + k + '"'); walk(v[k], where); } };
  for (const p of personas || []) {
    const w = p.id || '(no id)';
    if (!p.id || ids.has(p.id)) bad('duplicate or missing persona id: ' + w); ids.add(p.id);
    const pk = new Set();
    for (const q of [p.patient || {}, ...(p.extraPatients || [])]) {
      if (!/^demo-\d\d[a-z]?$/.test(q.syntheticKey || '') || keys.has(q.syntheticKey)) bad(w + ': syntheticKey missing, malformed or repeated'); keys.add(q.syntheticKey);
      if (pk.has(q.key)) bad(w + ': patient key repeated: ' + q.key); pk.add(q.key);
    }
    walk(p, w);
    const ek = new Set(), ck = new Set(), open = new Set();
    for (const e of p.encounters || []) {
      ek.add(e.key); if (!pk.has(e.patient)) bad(w + ': encounter patient does not resolve'); off(e.start, w + ' encounter start'); if (e.end) off(e.end, w + ' encounter end');
      else { const b = e.ward + '/' + e.bed; if (open.has(b)) bad(w + ': two open encounters on ' + b); open.add(b); }
    }
    for (const c of p.cases || []) { ck.add(c.key); if (!pk.has(c.patient)) bad(w + ': case patient does not resolve'); if (c.encounter && !ek.has(c.encounter)) bad(w + ': case encounter does not resolve'); }
    for (const s of p.series || []) {
      if (s.timeAs != null && s.timeAs !== 'date') bad(w + ': timeAs can only be "date"');
      if (!ck.has(s.case)) bad(w + ': series case does not resolve'); off(s.schedule.start, w + ' schedule start');
      const n = s.schedule.count, inRange = (x) => Number.isInteger(x) && x >= 0 && x < n;
      const ix = [...(s.skip || []), ...(s.noTime || []), ...(s.badTime || []), ...(s.inError || []).map((x) => x.index), ...(s.amend || []).map((x) => x.index)];
      if (!ix.every(inRange)) bad(w + ': an index is outside 0..count-1');
      if ((s.skip || []).some((x) => (s.inError || []).some((e) => e.index === x))) bad(w + ': an index is both skipped and entered in error');
    }
    for (const v of p.values || []) { if (!ck.has(v.case)) bad(w + ': value case does not resolve'); off(v.at, w + ' value time'); }
    for (const n of p.notes || []) { if (!ck.has(n.case)) bad(w + ': note case does not resolve'); off(n.at, w + ' note time'); }
    if (p.merge && !(pk.has(p.merge.from) && pk.has(p.merge.into) && p.merge.from !== p.merge.into && p.merge.by)) bad(w + ': merge needs two different patients of this persona, and by');
  }
  return errors;
}

function generateDemo({ seed, anchor, personas }) {
  const errors = validatePersonas(personas);
  if (errors.length) throw new Error('Bad personas: ' + errors.join('; '));
  const A = Date.parse(anchor);
  if (!Number.isFinite(A)) throw new Error('bad anchor');
  const out = { anchor: iso(A), patients: [], encounters: [], cases: [], rows: [], values: [], notes: [], merges: [] };
  for (const p of personas) {
    const pid = 'demo-' + p.id.toLowerCase(), base = (seed ^ hash(p.id)) >>> 0, rnd = rngOf(base);
    const idOf = (k) => pid + '-' + k;
    out.patients.push({ id: idOf(p.patient.key), personaId: p.id, name: p.patient.name, sex: p.patient.sex, ageYears: p.patient.ageYears, syntheticKey: p.patient.syntheticKey });
    for (const q of p.extraPatients || []) out.patients.push({ id: idOf(q.key), personaId: p.id, name: q.name, sex: q.sex, ageYears: q.ageYears, syntheticKey: q.syntheticKey });
    for (const e of p.encounters || []) out.encounters.push({ id: idOf(e.key), personaId: p.id, patient: idOf(e.patient), type: e.type, startAt: iso(A + offsetMs(e.start)), endAt: e.end ? iso(A + offsetMs(e.end)) : null, ward: e.ward, bed: e.bed });
    for (const c of p.cases || []) out.cases.push({ id: idOf(c.key), personaId: p.id, patient: idOf(c.patient), encounter: c.encounter ? idOf(c.encounter) : null, applied: c.applied || [], pathways: c.pathways || [], narrative: c.narrative || '' });
    (p.series || []).forEach((s, si) => {
      const st = A + offsetMs(s.schedule.start), ev = offsetMs(s.schedule.every), jit = s.schedule.jitter ? offsetMs(s.schedule.jitter) : 0;
      const has = (list, i) => (list || []).includes(i), find = (list, i) => (list || []).find((x) => x.index === i);
      for (let i = 0; i < s.schedule.count; i++) {
        const at = Math.min(A, st + i * ev + Math.round((rnd() * 2 - 1) * jit));
        const row = {};
        for (const [f, g] of Object.entries(s.fields || {})) row[f] = genValue(g, rnd, i, at);
        if (has(s.skip, i)) continue;                                  // a missed visit: nothing recorded
        const kind = has(s.noTime, i) ? 'none' : has(s.badTime, i) ? 'bad' : 'ok';
        if (kind === 'ok') row[s.timeField] = s.timeAs === 'date' ? iso(at).slice(0, 10) : iso(at); else if (kind === 'bad') row[s.timeField] = BAD_TIME;
        const er = find(s.inError, i), am = find(s.amend, i);
        out.rows.push({
          id: idOf(s.case + '-' + si + '-r' + i), personaId: p.id, case: idOf(s.case), setId: s.setId, groupId: s.groupId, index: i, by: s.by, row,
          rowTime: kind === 'ok' ? iso(at) : kind === 'bad' ? BAD_TIME : null, timeKind: kind,
          status: er ? 'entered_in_error' : 'active', error: er ? { by: er.by, reason: er.reason } : null,
          amend: am ? { by: am.by, reason: am.reason, field: am.field, value: genValue(am, rngOf(base ^ hash(s.case + si + i)), i, at) } : null,
        });
      }
    });
    for (const v of p.values || []) { const at = A + offsetMs(v.at); out.values.push({ case: idOf(v.case), setId: v.setId, fieldId: v.fieldId, at: iso(at), value: genValue(v, rnd, 0, at) }); }
    for (const n of p.notes || []) out.notes.push({ case: idOf(n.case), at: iso(A + offsetMs(n.at)), by: n.by, text: n.text, sign: !!n.sign, amend: n.amend || null });
    if (p.merge) out.merges.push({ from: idOf(p.merge.from), into: idOf(p.merge.into), by: p.merge.by, reason: p.merge.reason || '' });
  }
  return out;
}

// What the generated data must contain, derived from it (committed as demo-expected.json, so a persona change shows as a reviewed diff).
function expectedOf(demo) {
  const sum = { patients: 0, encounters: 0, cases: 0, rows: 0, activeRows: 0, enteredInErrorRows: 0, rowsWithoutTime: 0, amendedRows: 0, signedNotes: 0 };
  const per = {}, events = {}, caseOwner = {}, patientPersona = {};
  const of = (id) => per[id] || (per[id] = { patients: 0, encounters: 0, openEncounters: 0, cases: 0, rowsBySet: {}, enteredInErrorRows: 0, rowsWithoutTime: 0, amendedRows: 0, signedNotes: 0 });
  for (const x of demo.patients) { of(x.personaId).patients++; sum.patients++; patientPersona[x.id] = x; }
  for (const x of demo.encounters) { const o = of(x.personaId); o.encounters++; sum.encounters++; if (!x.endAt) o.openEncounters++; }
  for (const x of demo.cases) { of(x.personaId).cases++; sum.cases++; caseOwner[x.id] = x.patient; }
  for (const r of demo.rows) {
    const o = of(r.personaId), k = r.setId + '/' + r.groupId;
    o.rowsBySet[k] = (o.rowsBySet[k] || 0) + 1; sum.rows++;
    if (r.status === 'entered_in_error') { o.enteredInErrorRows++; sum.enteredInErrorRows++; } else sum.activeRows++;
    if (r.timeKind !== 'ok') { o.rowsWithoutTime++; sum.rowsWithoutTime++; }
    if (r.amend) { o.amendedRows++; sum.amendedRows++; }
  }
  for (const n of demo.notes) if (n.sign) { const o = of(demo.cases.find((c) => c.id === n.case).personaId); o.signedNotes++; sum.signedNotes++; }
  const byPatient = {};
  for (const e of demo.encounters) (byPatient[e.patient] = byPatient[e.patient] || []).push(e);
  for (const list of Object.values(byPatient)) {
    list.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    if (list.length > 1 && list[0].endAt) (events[list[0].personaId] = events[list[0].personaId] || {}).readmissionGapDays = Math.round((Date.parse(list[1].startAt) - Date.parse(list[0].endAt)) / 86400000);
  }
  for (const m of demo.merges) {
    const from = patientPersona[m.from], into = patientPersona[m.into], e = events[from.personaId] = events[from.personaId] || {};
    e.mergedInto = into.syntheticKey; e.mergedFrom = from.syntheticKey;
    e.rowsOnDuplicate = demo.rows.filter((r) => caseOwner[r.case] === m.from).length; e.rowsOnKept = demo.rows.filter((r) => caseOwner[r.case] === m.into).length;
  }
  return { schemaVersion: 1, totals: sum, personas: per, events };
}

module.exports = { generateDemo, validatePersonas, expectedOf, offsetMs, rngOf };
