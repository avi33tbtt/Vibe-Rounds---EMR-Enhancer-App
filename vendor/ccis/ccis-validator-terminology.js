// CCIS VALIDATOR, row ECO-B1f: layer 5 checks for a local terminology package, against itself. Prototype. Synthetic data only.
// Pure. Malformed shapes are skipped here: layer 2 reports them. Messages name keys and ids only, never display text.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const TERMINOLOGY_RULES = [
  { ruleId: 'CCIS-V5-017', layer: 5, severity: 'error', summary: 'Two concepts in a terminology package share a key.' },
  { ruleId: 'CCIS-V5-018', layer: 5, severity: 'error', summary: 'A concept is replaced by itself, or by a key the package does not define.' },
  { ruleId: 'CCIS-V5-019', layer: 5, severity: 'error', summary: 'A value-set member names a key the package does not define.' },
  { ruleId: 'CCIS-V5-020', layer: 5, severity: 'error', summary: 'A value-set id, or a member key within one value set, is repeated.' },
  { ruleId: 'CCIS-V5-021', layer: 5, severity: 'warning', summary: 'A value-set member names a deprecated concept.' },
];

export function terminologyChecks(doc) {
  const out = [];
  const concepts = new Map(); // key -> concept (first one wins)
  arr(doc.concepts).forEach((c, i) => {
    if (!isObj(c) || typeof c.key !== 'string') return;
    if (concepts.has(c.key)) out.push(diag('error', 'CCIS-V5-017', `/concepts/${i}/key`, `The key "${c.key}" is already used by an earlier concept.`, 'A key is an identity: use a new key for a different meaning.'));
    else concepts.set(c.key, c);
  });
  arr(doc.concepts).forEach((c, i) => {
    if (!isObj(c) || typeof c.replacedBy !== 'string') return;
    if (c.replacedBy === c.key || !concepts.has(c.replacedBy)) {
      out.push(diag('error', 'CCIS-V5-018', `/concepts/${i}/replacedBy`, `The concept "${c.key}" is replaced by "${c.replacedBy}", which is itself or not defined in this package.`, 'Name another concept of this package.'));
    }
  });
  const sets = new Set();
  arr(doc.valueSets).forEach((v, i) => {
    if (!isObj(v)) return;
    if (typeof v.id === 'string') {
      if (sets.has(v.id)) out.push(diag('error', 'CCIS-V5-020', `/valueSets/${i}/id`, `The value set "${v.id}" is listed more than once.`, 'Give each value set one entry; a change is a new version of the package.'));
      sets.add(v.id);
    }
    const seen = new Set();
    arr(v.members).forEach((m, j) => {
      if (!isObj(m) || typeof m.key !== 'string') return;
      const at = `/valueSets/${i}/members/${j}/key`;
      if (seen.has(m.key)) out.push(diag('error', 'CCIS-V5-020', at, `The member "${m.key}" is repeated in the value set "${v.id}".`, 'List each member once.'));
      seen.add(m.key);
      const c = concepts.get(m.key);
      if (!c) out.push(diag('error', 'CCIS-V5-019', at, `The member "${m.key}" is not defined in this package.`, 'Define the concept, or correct the key.'));
      else if (c.deprecated === true) out.push(diag('warning', 'CCIS-V5-021', at, `The member "${m.key}" is a deprecated concept.`, 'Prefer its replacement in new value sets.'));
    });
  });
  return out;
}
