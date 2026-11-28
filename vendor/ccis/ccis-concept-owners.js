// CCIS CONCEPT OWNERS, row ECO-B2a: who owns each concept, who uses it, and layer 5 rows for one element (ED-12, ED-29). Prototype. Synthetic data only.
// Pure. Owner means owner element. Ownership is never inferred from a label or a key. Messages name ids, keys and concept codes only.
// Imports compareSemver from the validator, which imports this file back; it is only called at run time, so the cycle is safe.
import { compareSemver } from './ccis-validator.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const OWNERSHIP_RULES = [
  { ruleId: 'CCIS-V5-028', layer: 5, severity: 'warning', summary: 'A concept has an owner field in two or more different elements (error when strictOwnership is set).' },
  { ruleId: 'CCIS-V5-029', layer: 5, severity: 'warning', summary: 'A concept is carried only by fields that name an owner, so no element owns it (error when strictOwnership is set).' },
];

const fieldsOf = (el) => [
  ...arr(el.fields).map((f, i) => [f, `/fields/${i}`]),
  ...arr(el.modules).flatMap((m, a) => (isObj(m) ? arr(m.fields).map((f, b) => [f, `/modules/${a}/fields/${b}`]) : [])),
].filter(([f]) => isObj(f) && typeof f.key === 'string' && isObj(f.concept) && typeof f.concept.code === 'string');
const idOf = (d) => (isObj(d.manifest) ? d.manifest.id : undefined);

// Highest version of each element id wins (the same rule as the market).
const latest = (artefacts) => {
  const best = new Map();
  for (const d of arr(artefacts)) {
    if (!isObj(d) || !isObj(d.manifest) || d.manifest.type !== 'contextual-element' || typeof idOf(d) !== 'string') continue;
    const cur = best.get(idOf(d));
    if (!cur || (compareSemver(d.manifest.version, cur.manifest.version) ?? 0) > 0) best.set(idOf(d), d);
  }
  return [...best.values()];
};

export function conceptOwners(artefacts) {
  const byConcept = new Map();
  for (const d of latest(artefacts)) {
    for (const [f] of fieldsOf(d)) {
      const e = byConcept.get(f.concept.code) ?? { concept: f.concept.code, owners: [], users: [], keys: new Set() };
      (isObj(f.ownedBy) ? e.users : e.owners).push({ element: idOf(d), key: f.key });
      e.keys.add(f.key);
      byConcept.set(f.concept.code, e);
    }
  }
  const order = (a, b) => (a.element + '\u0000' + a.key < b.element + '\u0000' + b.key ? -1 : 1);
  return [...byConcept.values()].sort((a, b) => (a.concept < b.concept ? -1 : 1)).map((e) => ({
    concept: e.concept,
    owners: e.owners.sort(order),
    users: e.users.sort(order),
    keys: [...e.keys].sort(),
    status: new Set(e.owners.map((o) => o.element)).size > 1 ? 'second-owner' : e.owners.length === 0 ? 'needs-owner' : 'ok',
  }));
}

export function ownershipDiagnostics(doc, entries, strict) {
  const out = [];
  const sev = strict === true ? 'error' : 'warning';
  const by = new Map(arr(entries).map((e) => [e.concept, e]));
  for (const [f, at] of fieldsOf(doc)) {
    const e = by.get(f.concept.code);
    if (!e) continue;
    const path = `${at}/concept/code`;
    if (e.status === 'second-owner' && !isObj(f.ownedBy)) {
      out.push(diag(sev, 'CCIS-V5-028', path, `The concept "${e.concept}" has owner fields in more than one element: ${[...new Set(e.owners.map((o) => o.element))].join(', ')}.`, 'Keep one owner element; make the others name it with ownedBy.'));
    } else if (e.status === 'needs-owner' && isObj(f.ownedBy)) {
      out.push(diag(sev, 'CCIS-V5-029', path, `The concept "${e.concept}" of the field "${f.key}" has no owner element among the known elements.`, 'Add the owner element, or make one field own the concept.'));
    }
  }
  return out;
}
