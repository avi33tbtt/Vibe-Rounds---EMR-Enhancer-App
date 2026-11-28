// CCIS VALIDATOR, row ECO-B6a: layer 5 checks for a pathway `contexts` list (design: PACKAGE-DESIGN section 4). Prototype. Synthetic data only.
// Pure. An element that did not resolve is skipped for the tag check, never guessed. Grouping labels only: no clinical logic, no number.
import { KNOWN_CONTEXTS } from './ccis-validator-concept.js';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const CONTEXTS_RULES = [
  { ruleId: 'CCIS-V5-044', layer: 5, severity: 'error', summary: 'A pathway context lists an element that is not in the pathway elements.' },
  { ruleId: 'CCIS-V5-045', layer: 5, severity: 'error', summary: 'Two pathway contexts share an id.' },
  { ruleId: 'CCIS-V5-046', layer: 5, severity: 'error', summary: 'A pathway context id is not one of the known context tags.' },
  { ruleId: 'CCIS-V5-047', layer: 5, severity: 'error', summary: 'The pathway contexts that list an element disagree with the context tags on the element fields.' },
];

const tagsOf = (el) => new Set([...arr(el.fields), ...arr(el.modules).flatMap((m) => (isObj(m) ? arr(m.fields) : []))].flatMap((f) => (isObj(f) ? arr(f.contexts) : [])).filter((t) => typeof t === 'string'));
const list = (s) => [...s].sort().join(', ');

export function contextsChecks(doc, ctx) {
  const out = [];
  if (!Array.isArray(doc.contexts)) return out;
  const listed = new Set(arr(doc.elements).filter((r) => isObj(r) && typeof r.id === 'string').map((r) => r.id));
  const refs = new Map(arr(doc.elements).filter((r) => isObj(r) && typeof r.id === 'string').map((r) => [r.id, r]));
  const ids = new Set();
  const placed = new Map(); // element id -> { tags: Set of context ids, path of the first listing }
  doc.contexts.forEach((c, i) => {
    if (!isObj(c)) return;
    if (typeof c.id === 'string') {
      if (ids.has(c.id)) out.push(diag('error', 'CCIS-V5-045', `/contexts/${i}/id`, `The context id "${c.id}" is used more than once.`, 'Give each context its own id.'));
      ids.add(c.id);
      if (!KNOWN_CONTEXTS.includes(c.id)) out.push(diag('error', 'CCIS-V5-046', `/contexts/${i}/id`, `The context id "${c.id}" is not a known context tag.`, `Known tags: ${KNOWN_CONTEXTS.join(', ')}.`));
    }
    arr(c.elements).forEach((e, j) => {
      if (typeof e !== 'string') return;
      const at = `/contexts/${i}/elements/${j}`;
      if (!listed.has(e)) { out.push(diag('error', 'CCIS-V5-044', at, `The context "${c.id}" lists the element "${e}", which is not in the pathway elements.`, 'List the element under elements, or correct the id.')); return; }
      const p = placed.get(e) ?? { tags: new Set(), at };
      if (typeof c.id === 'string') p.tags.add(c.id);
      placed.set(e, p);
    });
  });
  for (const [id, p] of placed) {
    const r = ctx.resolve(refs.get(id));
    if (r.state !== 'ok' || !isObj(r.doc)) continue;
    const t = tagsOf(r.doc);
    if (t.size === 0 || p.tags.size === 0 || list(t) === list(p.tags)) continue;
    out.push(diag('error', 'CCIS-V5-047', p.at, `The element "${id}" carries the context tags [${list(t)}] but the pathway lists it under [${list(p.tags)}].`, 'Make the pathway contexts and the element tags agree.'));
  }
  return out;
}
