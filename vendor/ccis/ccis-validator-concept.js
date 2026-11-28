// CCIS VALIDATOR, row ECO-B2: layer 5 checks for `concept` and `contexts` on one contextual element (ED-9, ED-27). Prototype. Synthetic data only.
// Pure. Checks an element against itself only; cross-element agreement is ECO-B1e (owner) and B2a. Messages name keys and tags only.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const KNOWN_CONTEXTS = ['diabetes', 'ckd', 'hypertension'];
const KEY_FORMAT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const CONCEPT_RULES = [
  { ruleId: 'CCIS-V5-022', layer: 5, severity: 'error', summary: 'A concept code does not follow the key format (lowercase letters, digits, dot, underscore, hyphen; 1 to 64 characters).' },
  { ruleId: 'CCIS-V5-023', layer: 5, severity: 'error', summary: 'A context tag is not one of the known tags.' },
  { ruleId: 'CCIS-V5-024', layer: 5, severity: 'error', summary: 'A repeating quantity or integer field has no concept (error from standard 0.2.0, warning at 0.1.0).' },
  { ruleId: 'CCIS-V5-025', layer: 5, severity: 'error', summary: 'Two fields of one element share a concept code but differ in type or units.' },
];

const fieldsOf = (el) => [
  ...arr(el.fields).map((f, i) => [f, `/fields/${i}`]),
  ...arr(el.modules).flatMap((m, a) => (isObj(m) ? arr(m.fields).map((f, b) => [f, `/modules/${a}/fields/${b}`]) : [])),
].filter(([f]) => isObj(f) && typeof f.key === 'string');
const repeats = (c) => isObj(c) && (c.max === 'unbounded' || (Number.isInteger(c.max) && c.max > 1));
const units = (f) => JSON.stringify([...arr(f.units)].sort());
const major = (v) => { const m = /^(\d+)\.(\d+)/.exec(typeof v === 'string' ? v : ''); return m ? [Number(m[1]), Number(m[2])] : [0, 1]; };

export function conceptChecks(doc) {
  const out = [];
  const [maj, min] = major(isObj(doc.manifest) && isObj(doc.manifest.standard) ? doc.manifest.standard.version : null);
  const strict = maj > 0 || min >= 2;
  const seen = new Map();
  for (const [f, at] of fieldsOf(doc)) {
    const code = isObj(f.concept) ? f.concept.code : undefined;
    if (typeof code === 'string' && !KEY_FORMAT.test(code)) {
      out.push(diag('error', 'CCIS-V5-022', `${at}/concept/code`, `The concept code of the field "${f.key}" does not follow the key format.`, 'Use lowercase letters, digits, dot, underscore or hyphen; start with a letter or digit; at most 64 characters.'));
    }
    arr(f.contexts).forEach((t, j) => {
      if (typeof t === 'string' && !KNOWN_CONTEXTS.includes(t)) {
        out.push(diag('error', 'CCIS-V5-023', `${at}/contexts/${j}`, `The context tag "${t}" on the field "${f.key}" is not a known tag.`, `Known tags: ${KNOWN_CONTEXTS.join(', ')}.`));
      }
    });
    if ((f.type === 'quantity' || f.type === 'integer') && repeats(f.cardinality) && !isObj(f.concept)) {
      out.push(diag(strict ? 'error' : 'warning', 'CCIS-V5-024', at, `The repeating ${f.type} field "${f.key}" has no concept, so its values cannot be followed across pathways.`, 'Add a concept in the local code system.'));
    }
    if (typeof code === 'string') {
      const prev = seen.get(code);
      if (!prev) seen.set(code, { f, at });
      else if (prev.f.type !== f.type || units(prev.f) !== units(f)) {
        out.push(diag('error', 'CCIS-V5-025', `${at}/concept`, `The fields "${prev.f.key}" and "${f.key}" share the concept "${code}" but differ in type or units.`, 'One concept has one type and one set of units within an element.'));
      }
    }
  }
  return out;
}
