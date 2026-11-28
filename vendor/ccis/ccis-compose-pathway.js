// CCIS COMPOSE PATHWAY, row ECO-B8a: build a composed pathway from the composed group and the source pathways (design: PACKAGE-DESIGN sections 2 to 4 and 6). Prototype. Synthetic data only.
// Pure. Layout and references only: no field is copied, no clinical text, number or threshold is generated. Text fields come from the author.
// The validator is imported first on purpose: it and ccis-concept-owners.js import each other, and this order loads them safely.
import { compareSemver } from './ccis-validator.js';
import { canonicalize } from './ccis-compile.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const txt = (x) => typeof x === 'string' && x.trim() !== '';
const block = (status, message) => ({ status, concept: null, message });
const keysOf = (el) => [...arr(el.fields), ...arr(el.modules).flatMap((m) => (isObj(m) ? arr(m.fields) : []))].filter((f) => isObj(f) && typeof f.key === 'string').map((f) => f.key);

export function composePathway(input) {
  const inp = isObj(input) ? input : {};
  const m = isObj(inp.manifest) ? inp.manifest : {};
  const group = isObj(inp.group) ? inp.group : {};
  const blockers = [];
  const notes = [];
  if (!['id', 'name', 'version', 'standardVersion'].every((k) => txt(m[k])) || !isObj(m.publisher) || !txt(m.publisher.name) || !txt(inp.scope) || !txt(inp.intendedUse)
    || !Array.isArray(inp.exclusions) || !inp.exclusions.every(txt) || !Array.isArray(inp.stages) || inp.stages.length === 0) {
    blockers.push(block('missing-text', 'The manifest, scope, intended use, exclusions or stages are missing or empty; they must come from the author.'));
  }
  const best = new Map();
  for (const d of arr(inp.elements)) {
    const id = isObj(d) && isObj(d.manifest) ? d.manifest.id : undefined;
    const cur = best.get(id);
    if (typeof id === 'string' && (!cur || (compareSemver(d.manifest.version, cur.manifest.version) ?? 0) > 0)) best.set(id, d);
  }
  const users = new Map(); // element id -> Set of field keys that are not the owner of a shared concept
  for (const c of arr(group.sharedConcepts)) {
    for (const f of arr(c.fields)) {
      if (isObj(c.owner) && f.element === c.owner.element && f.field === c.owner.field) continue;
      (users.get(f.element) ?? users.set(f.element, new Set()).get(f.element)).add(f.field);
    }
  }
  const sections = [];
  const sectionAt = new Map();
  const placed = new Map(); // element id -> JSON of the first placement
  const named = new Set();
  arr(inp.pathways).forEach((p) => arr(isObj(p) && isObj(p.entryForm) ? p.entryForm.sections : []).forEach((s) => {
    if (!isObj(s) || typeof s.id !== 'string') return;
    let at = sectionAt.get(s.id);
    if (at === undefined) { at = { id: s.id, label: s.label, items: [] }; sectionAt.set(s.id, at); sections.push(at); }
    else if (at.label !== s.label) { blockers.push(block('section-conflict', `The form section "${s.id}" has two different labels in the source pathways.`)); return; }
    arr(s.items).forEach((it) => {
      if (!isObj(it)) return;
      if (it.kind === 'section') { if (!named.has(it.section)) { named.add(it.section); at.items.push({ ...it }); } return; }
      if (it.kind !== 'element' || typeof it.element !== 'string') return;
      const sig = JSON.stringify([it.fields ?? null, it.rowGroups ?? null]);
      if (placed.has(it.element)) {
        if (placed.get(it.element) !== sig) notes.push(`A later placement of "${it.element}" differs from the first and is dropped.`);
        return;
      }
      placed.set(it.element, sig);
      const drop = users.get(it.element);
      const out = { ...it };
      if (drop !== undefined) {
        const all = it.fields ?? keysOf(best.get(it.element) ?? {});
        out.fields = all.filter((k) => !drop.has(k));
        if (out.fields.length === 0) { blockers.push(block('no-field-left', `The element "${it.element}" has no field left in the form once shared fields show at their owner.`)); return; }
        if (it.rowGroups !== undefined) {
          const g = it.rowGroups.map((r) => r.filter((k) => !drop.has(k))).filter((r) => r.length > 0);
          if (g.length > 0) out.rowGroups = g; else delete out.rowGroups;
        }
      }
      at.items.push(out);
    });
  }));
  const contexts = [];
  const ctxAt = new Map();
  arr(inp.pathways).forEach((p) => arr(isObj(p) ? p.contexts : []).forEach((c) => {
    if (!isObj(c) || typeof c.id !== 'string') return;
    const cur = ctxAt.get(c.id);
    if (cur === undefined) { const n = { id: c.id, label: c.label, elements: [...new Set(arr(c.elements))] }; ctxAt.set(c.id, n); contexts.push(n); return; }
    if (cur.label !== c.label) { blockers.push(block('section-conflict', `The context "${c.id}" has two different labels in the source pathways.`)); return; }
    arr(c.elements).forEach((e) => { if (!cur.elements.includes(e)) cur.elements.push(e); });
  }));
  if (blockers.length > 0) return { ok: false, blockers };
  const refs = [group.manifest, ...arr(inp.pathways).map((p) => (isObj(p) ? p.manifest : undefined))].filter(isObj).map((x) => ({ id: x.id, type: x.type, version: x.version }));
  const forms = sections.filter((s) => s.items.length > 0);
  const pathway = {
    manifest: { id: m.id, name: m.name, type: 'pathway', version: m.version, publisher: { name: m.publisher.name }, standard: { version: m.standardVersion }, status: 'draft', references: refs },
    scope: inp.scope, intendedUse: inp.intendedUse, exclusions: [...inp.exclusions],
    elements: arr(group.members).map((x) => ({ id: x.element.id, type: 'contextual-element', range: x.element.version })),
    stages: JSON.parse(JSON.stringify(inp.stages)),
  };
  if (forms.length > 0) pathway.entryForm = { sections: forms };
  if (contexts.length > 0) pathway.contexts = contexts;
  const c = canonicalize(pathway);
  if (!c.ok) return { ok: false, blockers: [block('not-canonical', 'The pathway could not be written in canonical form.')] };
  return { ok: true, pathway, bytes: c.text, notes };
}
