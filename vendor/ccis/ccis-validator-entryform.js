// CCIS VALIDATOR, row B6: layer 5 checks for a pathway entryForm (design: PACKAGE-DESIGN sections 3 and 9). Prototype. Synthetic data only.
// Pure. An element that did not resolve is skipped for field checks, never guessed. Layout only: no clinical logic, no number.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const SECTION_NAMES = ['core.problems', 'core.allergies', 'core.medications', 'core.investigations', 'core.care-episode'];

export const ENTRYFORM_RULES = [
  { ruleId: 'CCIS-V5-036', layer: 5, severity: 'error', summary: 'An entryForm element item names an element that is not in the pathway elements.' },
  { ruleId: 'CCIS-V5-037', layer: 5, severity: 'error', summary: 'An element of the pathway is placed nowhere in the entryForm.' },
  { ruleId: 'CCIS-V5-038', layer: 5, severity: 'error', summary: 'An entryForm names a field that its element does not define.' },
  { ruleId: 'CCIS-V5-039', layer: 5, severity: 'error', summary: 'A field is placed more than once in the entryForm.' },
  { ruleId: 'CCIS-V5-040', layer: 5, severity: 'error', summary: 'A rowGroups field is not among the fields of the same item.' },
  { ruleId: 'CCIS-V5-041', layer: 5, severity: 'error', summary: 'An entryForm section item names a section outside the known list.' },
  { ruleId: 'CCIS-V5-042', layer: 5, severity: 'error', summary: 'Two entryForm sections share an id.' },
  { ruleId: 'CCIS-V5-043', layer: 5, severity: 'warning', summary: 'The core.care-episode section item marks a place only; the EMR shows no area for it.' },
];

const keysOf = (el) => new Set([...arr(el.fields), ...arr(el.modules).flatMap((m) => (isObj(m) ? arr(m.fields) : []))].filter((f) => isObj(f) && typeof f.key === 'string').map((f) => f.key));

export function entryFormChecks(doc, ctx) {
  const out = [];
  if (!isObj(doc.entryForm)) return out;
  const known = new Map(); // element id -> Set of field keys, or null when not resolved
  arr(doc.elements).forEach((ref) => {
    if (!isObj(ref) || typeof ref.id !== 'string') return;
    const r = ctx.resolve(ref);
    known.set(ref.id, r.state === 'ok' && isObj(r.doc) ? keysOf(r.doc) : null);
  });
  const placed = new Set();
  const used = new Map(); // element id -> Set of field keys already placed
  const sectionIds = new Set();
  arr(doc.entryForm.sections).forEach((s, i) => {
    if (!isObj(s)) return;
    if (typeof s.id === 'string') {
      if (sectionIds.has(s.id)) out.push(diag('error', 'CCIS-V5-042', `/entryForm/sections/${i}/id`, `The section id "${s.id}" is used more than once.`, 'Give each section its own id.'));
      sectionIds.add(s.id);
    }
    arr(s.items).forEach((it, j) => {
      if (!isObj(it)) return;
      const at = `/entryForm/sections/${i}/items/${j}`;
      if (it.kind === 'section' && typeof it.section === 'string') {
        if (!SECTION_NAMES.includes(it.section)) out.push(diag('error', 'CCIS-V5-041', `${at}/section`, `The section name "${it.section}" is not a known section.`, 'Use one of the known section names.'));
        else if (it.section === 'core.care-episode') out.push(diag('warning', 'CCIS-V5-043', `${at}/section`, 'The section "core.care-episode" marks a place only; the EMR shows no area for it.', 'Keep it as a placeholder or remove it.'));
        return;
      }
      if (it.kind !== 'element' || typeof it.element !== 'string') return;
      if (!known.has(it.element)) {
        out.push(diag('error', 'CCIS-V5-036', `${at}/element`, `The form item names the element "${it.element}", which is not in the pathway elements.`, 'List the element under elements, or correct the id.'));
        return;
      }
      placed.add(it.element);
      const keys = known.get(it.element);
      const prev = used.get(it.element) ?? new Set();
      const given = Array.isArray(it.fields);
      const mine = new Set();
      const unknown = (k, path) => { if (keys !== null && !keys.has(k)) out.push(diag('error', 'CCIS-V5-038', path, `The element "${it.element}" does not define the field "${k}".`, 'Correct the field key or the element version.')); };
      arr(it.fields).forEach((k, x) => {
        if (typeof k !== 'string') return;
        if (mine.has(k) || prev.has(k)) out.push(diag('error', 'CCIS-V5-039', `${at}/fields/${x}`, `The field "${k}" of "${it.element}" is placed more than once.`, 'Place each field once.'));
        mine.add(k);
        unknown(k, `${at}/fields/${x}`);
      });
      if (!given && keys !== null) {
        for (const k of keys) if (prev.has(k)) out.push(diag('error', 'CCIS-V5-039', at, `The field "${k}" of "${it.element}" is placed more than once.`, 'Name disjoint fields for each placement of an element.'));
        keys.forEach((k) => mine.add(k));
      }
      const rowSeen = new Set();
      arr(it.rowGroups).forEach((g, x) => arr(g).forEach((k, y) => {
        if (typeof k !== 'string') return;
        const p = `${at}/rowGroups/${x}/${y}`;
        if (rowSeen.has(k)) out.push(diag('error', 'CCIS-V5-039', p, `The field "${k}" of "${it.element}" is in more than one row group.`, 'Place each field once.'));
        rowSeen.add(k);
        unknown(k, p);
        if (given && !it.fields.includes(k)) out.push(diag('error', 'CCIS-V5-040', p, `The row group field "${k}" is not among the fields of this item.`, 'Add it to fields, or remove it from the row group.'));
      }));
      used.set(it.element, new Set([...prev, ...mine]));
    });
  });
  arr(doc.elements).forEach((ref, k) => {
    if (isObj(ref) && typeof ref.id === 'string' && !placed.has(ref.id)) out.push(diag('error', 'CCIS-V5-037', `/elements/${k}`, `The element "${ref.id}" is placed nowhere in the entry form.`, 'Place the element in a section.'));
  });
  return out;
}
