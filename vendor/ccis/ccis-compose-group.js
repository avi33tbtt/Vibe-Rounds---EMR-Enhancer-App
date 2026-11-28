// CCIS COMPOSE GROUP, row ECO-B8: build a composed element group from owner choices (design: PACKAGE-DESIGN section 6). Prototype. Synthetic data only.
// Pure. Writes no clinical text: `meaning` is copied from the owner field, `intent` and `provenance` come from the author. No number, no threshold.
// The validator is imported first on purpose: it and ccis-concept-owners.js import each other, and this order loads them safely.
import { compareSemver } from './ccis-validator.js';
import { conceptOwners } from './ccis-concept-owners.js';
import { conflictReport } from './ccis-compose.js';
import { canonicalize } from './ccis-compile.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const txt = (x) => typeof x === 'string' && x.trim() !== '';
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a, b) => cmp(a.element + '\u0000' + a.key, b.element + '\u0000' + b.key);
const idsOf = (p) => [...new Set(arr(isObj(p) ? p.elements : []).filter((r) => isObj(r) && typeof r.id === 'string').map((r) => r.id))];
const fieldsOf = (el) => [...arr(el.fields), ...arr(el.modules).flatMap((m) => (isObj(m) ? arr(m.fields) : []))].filter((f) => isObj(f) && typeof f.key === 'string');
const block = (status, concept, message) => ({ status, concept, message });

export function composeGroup(input) {
  const inp = isObj(input) ? input : {};
  const m = isObj(inp.manifest) ? inp.manifest : {};
  const pathways = arr(inp.pathways);
  const choices = isObj(inp.choices) ? inp.choices : {};
  const report = conflictReport(pathways, arr(inp.elements));
  const blockers = [];
  const notes = [];
  const intent = isObj(inp.intent) ? inp.intent : {};
  const prov = isObj(inp.provenance) ? inp.provenance : {};
  if (!['purpose', 'setting', 'population', 'rationale'].every((k) => txt(intent[k])) || !Array.isArray(intent.exclusions) || !intent.exclusions.every(txt) || !txt(prov.origin) || !txt(prov.basis) || !['id', 'name', 'version', 'standardVersion'].every((k) => txt(m[k])) || !isObj(m.publisher) || !txt(m.publisher.name)) {
    blockers.push(block('missing-text', null, 'The manifest, intent or provenance text is missing or empty; it must come from the author.'));
  }
  const used = []; // element ids in first-seen order, and how many pathways use each
  const count = new Map();
  pathways.forEach((p) => idsOf(p).forEach((id) => { if (!count.has(id)) used.push(id); count.set(id, (count.get(id) ?? 0) + 1); }));
  const best = new Map();
  for (const d of arr(inp.elements)) {
    const id = isObj(d) && isObj(d.manifest) ? d.manifest.id : undefined;
    if (!count.has(id)) continue;
    const cur = best.get(id);
    if (!cur || (compareSemver(d.manifest.version, cur.manifest.version) ?? 0) > 0) best.set(id, d);
  }
  const docs = used.filter((id) => best.has(id)).map((id) => best.get(id));
  const entries = new Map(conceptOwners(docs).map((e) => [e.concept, e]));
  const field = (r) => fieldsOf(best.get(r.element) ?? {}).find((f) => f.key === r.key);
  const revisions = [];
  const shared = [];
  const sharedCodes = new Set(report.concepts.map((c) => c.concept));
  Object.keys(choices).sort().forEach((code) => { if (!sharedCodes.has(code)) notes.push(`The choice for "${code}" is ignored: the concept is not shared.`); });
  const open = new Set();
  for (const c of report.concepts) {
    const e = entries.get(c.concept);
    const ch = choices[c.concept];
    let owner = c.owner;
    if (c.status === 'second-owner' && ch !== undefined) {
      if (isObj(ch) && e.owners.some((o) => o.element === ch.element && o.key === ch.key)) {
        owner = { element: ch.element, key: ch.key };
        e.owners.filter((o) => o.element !== ch.element || o.key !== ch.key).forEach((o) => revisions.push({ element: o.element, key: o.key, action: 'make-user-of', owner }));
      } else blockers.push(block('bad-choice', c.concept, `The choice for "${c.concept}" is not one of its owner fields.`));
    } else if (ch !== undefined) notes.push(`The choice for "${c.concept}" is ignored: its status is "${c.status}".`);
    if (c.status === 'possible-duplicate') continue; // a hint only: never in the group, never a blocker
    if (owner === null || (c.status !== 'ok' && c.status !== 'second-owner')) { open.add(c.concept); continue; }
    if (c.status === 'second-owner' && !revisions.some((r) => r.owner === owner)) { open.add(c.concept); continue; }
    const meaning = field(owner)?.concept?.display;
    if (!txt(meaning)) { blockers.push(block('missing-text', c.concept, `The owner field of "${c.concept}" has no concept display text.`)); continue; }
    shared.push({ concept: c.concept, meaning, fields: [...e.owners, ...e.users].map((x) => ({ element: x.element, field: x.key })).sort((a, b) => order({ element: a.element, key: a.field }, { element: b.element, key: b.field })), resolution: 'same-concept', owner: { element: owner.element, field: owner.key } });
  }
  report.blockers.filter((b) => b.concept === null || open.has(b.concept)).forEach((b) => blockers.push(b));
  if (blockers.length > 0) return { ok: false, blockers, report };
  const group = {
    manifest: { id: m.id, name: m.name, type: 'element-group', version: m.version, publisher: { name: m.publisher.name }, standard: { version: m.standardVersion }, status: 'draft' },
    intent: { purpose: intent.purpose, setting: intent.setting, population: intent.population, exclusions: [...intent.exclusions], rationale: intent.rationale },
    members: used.map((id) => ({ element: { id, type: 'contextual-element', version: best.get(id).manifest.version }, required: count.get(id) === pathways.length })),
    sharedConcepts: shared.sort((a, b) => cmp(a.concept, b.concept)),
    versionPolicy: { conflict: 'refuse' },
    provenance: { origin: prov.origin, basis: prov.basis },
  };
  const c = canonicalize(group);
  if (!c.ok) return { ok: false, blockers: [block('not-canonical', null, 'The group could not be written in canonical form.')], report };
  return { ok: true, ready: revisions.length === 0, group, bytes: c.text, revisions, notes };
}
