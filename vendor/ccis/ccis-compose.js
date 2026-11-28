// CCIS COMPOSE, row ECO-B7: shared-concept matching and conflict report (design: PACKAGE-DESIGN section 6). Prototype. Synthetic data only.
// Pure: no clock, no network, no randomness. Matching is by concept code, never by label; the label hint only reports. No number, no threshold.
// The validator is imported first on purpose: it and ccis-concept-owners.js import each other, and this order loads them safely.
import { compareSemver } from './ccis-validator.js';
import { conceptOwners } from './ccis-concept-owners.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const idOf = (d) => (isObj(d) && isObj(d.manifest) && typeof d.manifest.id === 'string' ? d.manifest.id : undefined);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fieldsOf = (el) => [...arr(el.fields), ...arr(el.modules).flatMap((m) => (isObj(m) ? arr(m.fields) : []))].filter((f) => isObj(f) && typeof f.key === 'string' && isObj(f.concept) && typeof f.concept.code === 'string');
const unitOf = (f) => [...arr(f.units)].sort().join('|');
const ref = (e, k) => ({ element: e, key: k });
const order = (a, b) => cmp(a.element + '\u0000' + a.key, b.element + '\u0000' + b.key);

export function conflictReport(pathways, elements) {
  const used = [];
  const counts = new Map(); // element id -> number of pathways using it
  arr(pathways).forEach((p) => new Set(arr(isObj(p) ? p.elements : []).filter((r) => isObj(r) && typeof r.id === 'string').map((r) => r.id)).forEach((id) => {
    if (!counts.has(id)) used.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }));
  const best = new Map();
  for (const d of arr(elements)) {
    const id = idOf(d);
    if (id === undefined || !counts.has(id)) continue;
    const cur = best.get(id);
    if (!cur || (compareSemver(d.manifest.version, cur.manifest.version) ?? 0) > 0) best.set(id, d);
  }
  const blockers = used.filter((id) => !best.has(id)).map((id) => ({ status: 'missing-element', concept: null, message: `The element "${id}" is not among the supplied elements.` }));
  const docs = used.filter((id) => best.has(id)).map((id) => best.get(id));
  const field = new Map(); // element \u0000 key -> field
  docs.forEach((d) => fieldsOf(d).forEach((f) => field.set(idOf(d) + '\u0000' + f.key, f)));
  const concepts = [];
  for (const e of conceptOwners(docs)) {
    const members = [...e.owners, ...e.users];
    if (new Set(members.map((m) => m.element)).size < 2) continue;
    const one = e.status === 'ok' ? e.owners[0] : null;
    const of = one ? field.get(one.element + '\u0000' + one.key) : null;
    let status = e.status;
    if (status === 'ok') {
      for (const u of e.users) {
        const uf = field.get(u.element + '\u0000' + u.key);
        if (uf.type !== of.type) { status = 'type-conflict'; break; }
        if (unitOf(uf) !== unitOf(of)) status = 'unit-conflict';
      }
    }
    concepts.push({ concept: e.concept, owner: one ? ref(one.element, one.key) : null, users: (one ? e.users : members).map((m) => ref(m.element, m.key)).sort(order), unit: of ? unitOf(of) : null, status });
    if (status !== 'ok') blockers.push({ status, concept: e.concept, message: `The concept "${e.concept}" has status "${status}" across ${[...new Set(members.map((m) => m.element))].sort().join(', ')}.` });
  }
  // Label hint (ED-36b): same normalised label, different concept codes, different elements. Reported only; never a blocker, never merged.
  const seen = new Map();
  const listed = new Set(concepts.map((c) => c.concept));
  for (const d of docs) {
    for (const f of fieldsOf(d)) {
      const label = typeof f.label === 'string' ? f.label.trim().toLowerCase() : '';
      if (label === '') continue;
      (seen.get(label) ?? seen.set(label, []).get(label)).push({ element: idOf(d), key: f.key, code: f.concept.code });
    }
  }
  for (const [, ms] of [...seen].sort((a, b) => cmp(a[0], b[0]))) {
    const codes = [...new Set(ms.map((m) => m.code))].sort();
    if (codes.length < 2 || new Set(ms.map((m) => m.element)).size < 2 || listed.has(codes[0])) continue;
    const a = ms.filter((m) => m.code === codes[0]).sort(order)[0];
    const b = ms.filter((m) => m.code !== codes[0] && m.element !== a.element).sort(order)[0];
    if (!b) continue;
    listed.add(codes[0]);
    concepts.push({ concept: codes[0], owner: ref(a.element, a.key), users: [ref(b.element, b.key)], unit: unitOf(field.get(a.element + '\u0000' + a.key)), status: 'possible-duplicate' });
  }
  concepts.sort((a, b) => cmp(a.concept, b.concept));
  return { sharedElements: used.filter((id) => counts.get(id) > 1), concepts, blockers };
}
