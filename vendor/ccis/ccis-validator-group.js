// CCIS VALIDATOR, row 4.5c.1: layer 5 checks for an element group (CCIS-REQ-023, 024). Prototype. Synthetic data only.
// Pure. A member that did not resolve is skipped, never assumed. Resolution is never inferred from a key or a label.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const GROUP_RULES = [
  { ruleId: 'CCIS-V5-009', layer: 5, severity: 'error', summary: 'A shared concept names an element that is not a member of the group.' },
  { ruleId: 'CCIS-V5-010', layer: 5, severity: 'error', summary: 'A shared concept names a field that its member element does not define.' },
  { ruleId: 'CCIS-V5-011', layer: 5, severity: 'error', summary: 'A same-concept entry lists fields whose type or units differ (REQ-024).' },
  { ruleId: 'CCIS-V5-012', layer: 5, severity: 'error', summary: 'Two members define the same field key and no shared concept declares what the overlap is (REQ-023).' },
  { ruleId: 'CCIS-V5-013', layer: 5, severity: 'error', summary: 'The same field of the same member appears in more than one shared concept.' },
  { ruleId: 'CCIS-V5-030', layer: 5, severity: 'error', summary: 'The owner of a shared concept is not one of the fields the concept lists.' },
  { ruleId: 'CCIS-V5-031', layer: 5, severity: 'error', summary: 'A same-concept entry has no owner (error from standard 0.2.0, warning at 0.1.0).' },
  { ruleId: 'CCIS-V5-032', layer: 5, severity: 'error', summary: 'A shared concept code follows neither the legacy camelCase key nor the local key format.' },
  { ruleId: 'CCIS-V5-033', layer: 5, severity: 'error', summary: 'The same member element is listed more than once.' },
  { ruleId: 'CCIS-V5-034', layer: 5, severity: 'error', summary: 'The same shared concept code is used by more than one entry.' },
  { ruleId: 'CCIS-V5-035', layer: 5, severity: 'error', summary: 'A shared concept names fields of fewer than two different member elements.' },
];
const LEGACY_KEY = /^[a-z][A-Za-z0-9]*$/;
const LOCAL_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const major = (v) => { const m = /^(\d+)\.(\d+)/.exec(typeof v === 'string' ? v : ''); return m ? [Number(m[1]), Number(m[2])] : [0, 1]; };

const fieldsOf = (el) => [...arr(el.fields), ...arr(el.modules).flatMap((m) => (isObj(m) ? arr(m.fields) : []))].filter((f) => isObj(f) && typeof f.key === 'string');
const shape = (f) => JSON.stringify([f.type, [...arr(f.units)].sort()]);

export function groupChecks(doc, ctx) {
  const out = [];
  const [maj, min] = major(isObj(doc.manifest) && isObj(doc.manifest.standard) ? doc.manifest.standard.version : null);
  const strict = maj > 0 || min >= 2;
  const members = new Map(); // member element id -> { fields: Map(key -> field) } or null when not resolved
  arr(doc.members).forEach((m, i) => {
    const ref = isObj(m) ? m.element : null;
    if (!isObj(ref) || typeof ref.id !== 'string') return;
    if (members.has(ref.id)) {
      out.push(diag('error', 'CCIS-V5-033', `/members/${i}/element`, `The member element \"${ref.id}\" is listed more than once.`, 'List each member element once.'));
      return;
    }
    const r = ctx.resolve(ref);
    members.set(ref.id, r.state === 'ok' && isObj(r.doc) ? new Map(fieldsOf(r.doc).map((f) => [f.key, f])) : null);
  });
  const listed = new Set(); // "element\u0000key" seen in a concept
  const use = new Map();
  const codes = new Set();
  arr(doc.sharedConcepts).forEach((c, i) => {
    if (!isObj(c)) return;
    if (typeof c.concept === 'string' && !LEGACY_KEY.test(c.concept) && !LOCAL_KEY.test(c.concept)) {
      out.push(diag('error', 'CCIS-V5-032', `/sharedConcepts/${i}/concept`, `The shared concept code at position ${i} follows neither the legacy key format nor the local key format.`, 'Use lowercase letters, digits, dot, underscore or hyphen; start with a letter or digit; at most 64 characters.'));
    }
    if (isObj(c.owner)) {
      if (!arr(c.fields).some((f) => isObj(f) && f.element === c.owner.element && f.field === c.owner.field)) {
        out.push(diag('error', 'CCIS-V5-030', `/sharedConcepts/${i}/owner`, `The owner of the shared concept \"${c.concept}\" (${c.owner.element}, ${c.owner.field}) is not one of its listed fields.`, 'Name an element and field that the concept lists.'));
      }
    } else if (c.resolution === 'same-concept') {
      out.push(diag(strict ? 'error' : 'warning', 'CCIS-V5-031', `/sharedConcepts/${i}`, `The same-concept entry \"${c.concept}\" has no owner.`, 'Name the one element and field that owns the concept.'));
    }
    if (typeof c.concept === 'string') {
      if (codes.has(c.concept)) out.push(diag('error', 'CCIS-V5-034', `/sharedConcepts/${i}/concept`, `The shared concept code \"${c.concept}\" is used by more than one entry.`, 'Use one entry per concept, or give each concept its own code.'));
      codes.add(c.concept);
    }
    const found = [];
    arr(c.fields).forEach((f, j) => {
      if (!isObj(f)) return;
      const at = `/sharedConcepts/${i}/fields/${j}`;
      if (!members.has(f.element)) {
        out.push(diag('error', 'CCIS-V5-009', `${at}/element`, `The shared concept "${c.concept}" names the element "${f.element}", which is not a member of the group.`, 'List the element under members, or correct the id.'));
        return;
      }
      const id = `${f.element}\u0000${f.field}`;
      listed.add(id);
      if (use.has(id)) out.push(diag('error', 'CCIS-V5-013', at, `The field "${f.field}" of "${f.element}" is already in the shared concept "${use.get(id)}".`, 'A field belongs to one shared concept.'));
      else use.set(id, c.concept);
      const fields = members.get(f.element);
      if (fields === null) return;
      if (!fields.has(f.field)) out.push(diag('error', 'CCIS-V5-010', `${at}/field`, `The element "${f.element}" does not define the field "${f.field}".`, 'Correct the field key or the element version.'));
      else found.push(fields.get(f.field));
    });
    const elems = arr(c.fields).filter(isObj).map((f) => f.element);
    if (elems.length > 0 && elems.every((e) => members.has(e)) && new Set(elems).size < 2) {
      out.push(diag('error', 'CCIS-V5-035', `/sharedConcepts/${i}/fields`, `The shared concept \"${c.concept}\" names fields of only one member element, so nothing is shared.`, 'Name fields of at least two different members.'));
    }
    if (c.resolution === 'same-concept' && found.length > 1 && new Set(found.map(shape)).size > 1) {
      out.push(diag('error', 'CCIS-V5-011', `/sharedConcepts/${i}`, `The shared concept "${c.concept}" is declared the same concept, but its fields differ in type or units.`, 'Use related-not-merged, or make the fields the same shape first. Nothing is converted here.'));
    }
  });
  const ids = [...members.keys()];
  for (let a = 0; a < ids.length; a += 1) {
    for (let b = a + 1; b < ids.length; b += 1) {
      const fa = members.get(ids[a]);
      const fb = members.get(ids[b]);
      if (fa === null || fb === null) continue;
      for (const key of fa.keys()) {
        if (fb.has(key) && !(listed.has(`${ids[a]}\u0000${key}`) && listed.has(`${ids[b]}\u0000${key}`))) {
          out.push(diag('error', 'CCIS-V5-012', '/sharedConcepts', `The members "${ids[a]}" and "${ids[b]}" both define the field "${key}", and no shared concept declares what the overlap is.`, 'Add a shared concept with a meaning and a resolution. A shared key or a similar label is not evidence of the same meaning.'));
        }
      }
    }
  }
  return out;
}
