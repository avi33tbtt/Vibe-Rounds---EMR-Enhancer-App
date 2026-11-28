// CCIS VALIDATOR, row ECO-B1e: layer 5 checks for a field that points at the owner of its concept (ED-12, ED-16). Prototype. Synthetic data only.
// Pure. An owner that did not resolve is skipped, never assumed. An owner is never inferred from a key or a label.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const OWNER_RULES = [
  { ruleId: 'CCIS-V5-014', layer: 5, severity: 'error', summary: 'A field names an owner field that does not exist, has no concept, has a different concept, or is in the same element.' },
  { ruleId: 'CCIS-V5-015', layer: 5, severity: 'error', summary: 'A field and its owner field differ in type or units (ED-16).' },
  { ruleId: 'CCIS-V5-016', layer: 5, severity: 'warning', summary: 'A field allows a wider cardinality than its owner field.' },
];

const fieldsOf = (el) => [
  ...arr(el.fields).map((f, i) => [f, `/fields/${i}`]),
  ...arr(el.modules).flatMap((m, a) => (isObj(m) ? arr(m.fields).map((f, b) => [f, `/modules/${a}/fields/${b}`]) : [])),
].filter(([f]) => isObj(f) && typeof f.key === 'string');
const maxOf = (c) => (isObj(c) ? (c.max === 'unbounded' ? Infinity : Number.isInteger(c.max) ? c.max : null) : null);
const minOf = (c) => (isObj(c) && Number.isInteger(c.min) ? c.min : null);
const units = (f) => JSON.stringify([...arr(f.units)].sort());

export function ownerChecks(doc, ctx) {
  const out = [];
  const selfId = isObj(doc.manifest) ? doc.manifest.id : null;
  for (const [f, at] of fieldsOf(doc)) {
    const o = f.ownedBy;
    if (!isObj(o) || typeof o.element !== 'string' || typeof o.key !== 'string') continue; // malformed: layer 2's
    const path = `${at}/ownedBy`;
    if (o.element === selfId) {
      out.push(diag('error', 'CCIS-V5-014', path, `The field "${f.key}" names its own element as the owner of its concept.`, 'Name the element that owns the concept, or remove ownedBy.'));
      continue;
    }
    const r = ctx.resolve({ id: o.element, type: 'contextual-element', range: '>=0.0.0' });
    if (r.state !== 'ok' || !isObj(r.doc)) continue; // not resolved: skipped
    const owner = fieldsOf(r.doc).map(([x]) => x).find((x) => x.key === o.key);
    const code = (x) => (isObj(x) && isObj(x.concept) ? x.concept.code : undefined);
    if (!owner) {
      out.push(diag('error', 'CCIS-V5-014', path, `The element "${o.element}" does not define the field "${o.key}".`, 'Correct the owner element id or field key.'));
    } else if (code(owner) === undefined || code(owner) !== code(f)) {
      out.push(diag('error', 'CCIS-V5-014', path, `The field "${o.key}" of "${o.element}" has no concept, or a different concept from "${f.key}".`, 'The owner field must carry the same concept.'));
    } else {
      if (owner.type !== f.type || units(owner) !== units(f)) {
        out.push(diag('error', 'CCIS-V5-015', path, `The field "${f.key}" and its owner "${o.key}" of "${o.element}" differ in type or units.`, 'Repeat the owner\'s type and units.'));
      }
      const [fmax, omax, fmin, omin] = [maxOf(f.cardinality), maxOf(owner.cardinality), minOf(f.cardinality), minOf(owner.cardinality)];
      if ((fmax !== null && omax !== null && fmax > omax) || (fmin !== null && omin !== null && fmin < omin)) {
        out.push(diag('warning', 'CCIS-V5-016', path, `The field "${f.key}" allows a wider cardinality than its owner "${o.key}" of "${o.element}".`, 'Check that the wider range is intended.'));
      }
    }
  }
  return out;
}
