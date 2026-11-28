// CCIS VALIDATOR, row ECO-B2c: layer 5 check that a field's concept exists in the terminology package its element names (ED-28). Prototype. Synthetic data only.
// Pure. The package is named in manifest.references (type terminology-package). No reference, or a package that did not resolve, is skipped:
// a missing package is layer 3's (CCIS-V3-004). Messages name keys and ids only, never display text.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const PACKAGE_RULES = [
  { ruleId: 'CCIS-V5-026', layer: 5, severity: 'error', summary: 'A field concept is in none of the terminology packages the element references.' },
  { ruleId: 'CCIS-V5-027', layer: 5, severity: 'warning', summary: 'A field concept is deprecated in the terminology package.' },
];

const fieldsOf = (el) => [
  ...arr(el.fields).map((f, i) => [f, `/fields/${i}`]),
  ...arr(el.modules).flatMap((m, a) => (isObj(m) ? arr(m.fields).map((f, b) => [f, `/modules/${a}/fields/${b}`]) : [])),
].filter(([f]) => isObj(f) && typeof f.key === 'string');

export function conceptPackageChecks(doc, ctx) {
  const refs = isObj(doc.manifest) ? arr(doc.manifest.references).filter((r) => isObj(r) && r.type === 'terminology-package') : [];
  const concepts = new Map(); // key -> concept (first package wins; deprecated only if no package holds it live)
  let resolved = 0;
  for (const ref of refs) {
    const r = ctx.resolve(ref);
    if (r.state !== 'ok' || !isObj(r.doc)) continue;
    resolved += 1;
    for (const c of arr(r.doc.concepts)) {
      if (isObj(c) && typeof c.key === 'string' && (!concepts.has(c.key) || (concepts.get(c.key).deprecated && !c.deprecated))) concepts.set(c.key, c);
    }
  }
  if (resolved === 0) return [];
  const out = [];
  for (const [f, at] of fieldsOf(doc)) {
    const code = isObj(f.concept) ? f.concept.code : undefined;
    if (typeof code !== 'string') continue;
    const c = concepts.get(code);
    if (!c) out.push(diag('error', 'CCIS-V5-026', `${at}/concept/code`, `The concept "${code}" of the field "${f.key}" is not defined in the referenced terminology package.`, 'Add the concept to the package, or correct the code.'));
    else if (c.deprecated === true) out.push(diag('warning', 'CCIS-V5-027', `${at}/concept/code`, `The concept "${code}" of the field "${f.key}" is deprecated.`, typeof c.replacedBy === 'string' ? `Use the concept "${c.replacedBy}" instead.` : 'Choose a current concept.'));
  }
  return out;
}
