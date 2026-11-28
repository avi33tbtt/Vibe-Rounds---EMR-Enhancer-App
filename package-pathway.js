'use strict';
// Task D5a: pathway artefact -> DRAFT pathway proposal, and the concept map with owner blockers. Pure: no database, clock, network or random.
// Nothing is written anywhere. The proposal is for a person to review (D6 stores it, D8 accepts it); it is never a record.
// Rules (docs/PACKAGE-DESIGN.md sections 3, 4, 7 to 9; ED-12, ED-83, ED-84): step order is the first appearance of each element in entryForm;
// the layout is rewritten with set slugs and EMR field ids; nothing is guessed (a blocker stays a blocker); messages never echo package text
// (ids are shown only when they have a safe shape). The layout holds text and booleans only. A pathway says what is recorded, never what to do.
// Prototype. Synthetic data only. Not for clinical use.
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_STEPS = 30, SECTION_RE = /^[a-z0-9][a-z0-9-]{0,63}$/, EXACT = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const SECTIONS = ['core.problems', 'core.allergies', 'core.medications', 'core.investigations', 'core.care-episode'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);

function pathwayProposal(doc, sum, setProposals, H) {
  const { plain, SLUG_RE, ID_RE } = H;
  const m = isObj(doc.manifest) ? doc.manifest : {}, B = [];
  const block = (p, code, message) => B.push({ path: p, code, message });
  const slug = typeof m.id === 'string' ? m.id.replace(/\./g, '-') : '';
  const P = { key: 'pathway:' + slug, kind: 'pathway', draft: true, slug, title: m.name, description: doc.scope, steps: [], entryForm: null, contexts: null,
    source: { artefactId: m.id, version: m.version, checksum: sum }, blockers: B, warnings: [], ready: false };
  if (!SLUG_RE.test(slug)) block('/manifest/id', 'slug', 'The pathway id does not give a valid slug.');
  if (!plain(m.name) || m.name.length > 200) block('/manifest/name', 'title', 'The title is missing, too long or not plain text.');
  if (!plain(doc.scope) || doc.scope.length > 2000) block('/scope', 'description', 'The scope is missing, too long or not plain text.');

  const refs = arr(doc.elements);
  if (!refs.length) block('/elements', 'no-elements', 'The pathway names no elements.');
  if (refs.length > MAX_STEPS) block('/elements', 'too-many-elements', `The pathway names more than ${MAX_STEPS} elements.`);
  const byId = new Map();
  refs.forEach((e, i) => {
    const at = `/elements/${i}`;
    if (!isObj(e) || typeof e.id !== 'string') return block(at, 'element-shape', 'The element reference has no id.');
    if (typeof e.range !== 'string' || !EXACT.test(e.range)) return block(at + '/range', 'range', 'The version must be one exact version (no range).');
    const set = setProposals.find(s => s.source.artefactId === e.id && s.source.version === e.range);
    if (!set) return block(at, 'member-missing', 'The element is not in the bundle.');
    if (!set.ready) return block(at, 'member-not-ready', 'The element has blockers of its own.');
    byId.set(e.id, set);
  });

  const order = [], placed = new Set();
  const ids = (keys, set, at) => arr(keys).map((k, j) => {
    if (typeof k !== 'string' || !(k in set.fieldIds)) { block(`${at}/${j}`, 'field-unknown', 'The field is not in its element.'); return null; }
    return set.fieldIds[k];
  });
  if (doc.entryForm !== undefined) {
    const ef = doc.entryForm, secIds = new Set(), out = { sections: [] };
    if (!isObj(ef) || !Array.isArray(ef.sections) || !ef.sections.length) block('/entryForm', 'entryform-shape', 'The entry form needs a list of sections.');
    else ef.sections.forEach((s, si) => {
      const sa = `/entryForm/sections/${si}`;
      if (!isObj(s) || typeof s.id !== 'string' || !SECTION_RE.test(s.id)) return block(sa + '/id', 'section-id', 'The section id is not valid.');
      if (secIds.has(s.id)) block(sa + '/id', 'section-duplicate', 'Two sections share an id.');
      secIds.add(s.id);
      if (!plain(s.label)) block(sa + '/label', 'text-not-plain', 'The section label is missing or not plain text.');
      const sec = { id: s.id, label: s.label, items: [] };
      arr(s.items).forEach((it, ii) => {
        const ia = `${sa}/items/${ii}`;
        if (!isObj(it)) return block(ia, 'item-shape', 'The item is not an object.');
        if (it.visibleByDefault !== undefined && typeof it.visibleByDefault !== 'boolean') block(ia + '/visibleByDefault', 'item-shape', 'visibleByDefault must be true or false.');
        const vis = typeof it.visibleByDefault === 'boolean' ? { visibleByDefault: it.visibleByDefault } : {};
        if (it.kind === 'section') {
          if (!SECTIONS.includes(it.section)) block(ia + '/section', 'section-unknown', 'The section is not one the EMR knows.');
          else sec.items.push({ kind: 'section', section: it.section, ...vis });
        } else if (it.kind === 'element') {
          const set = byId.get(it.element);
          if (!set) return block(ia + '/element', 'entryform-element', 'The element is not one of the pathway elements.');
          if (!placed.has(it.element)) { placed.add(it.element); order.push(set); }
          const item = { kind: 'element', set: set.slug, ...vis };
          if (it.fields !== undefined) item.fields = ids(it.fields, set, ia + '/fields');
          if (it.rowGroups !== undefined) item.rowGroups = arr(it.rowGroups).map((g, gi) => ids(g, set, `${ia}/rowGroups/${gi}`));
          sec.items.push(item);
        } else block(ia + '/kind', 'item-shape', 'The item kind must be element or section.');
      });
      out.sections.push(sec);
    });
    for (const id of byId.keys()) if (!placed.has(id)) block('/entryForm', 'element-not-placed', 'An element of the pathway is not placed in the entry form.');
    P.entryForm = out;
  } else for (const [id, set] of byId) order.push(set);
  P.steps = order.slice(0, MAX_STEPS).map(s => ({ set: s.slug, source: { artefactId: s.source.artefactId, version: s.source.version } }));

  if (doc.contexts !== undefined) {
    P.contexts = arr(doc.contexts).map((c, ci) => {
      const ca = `/contexts/${ci}`;
      if (!isObj(c) || typeof c.id !== 'string' || !SECTION_RE.test(c.id)) { block(ca + '/id', 'context-id', 'The context id is not valid.'); return null; }
      if (!plain(c.label)) block(ca + '/label', 'text-not-plain', 'The context label is missing or not plain text.');
      const els = arr(c.elements).map((e, ei) => { const s = byId.get(e); if (!s) block(`${ca}/elements/${ei}`, 'context-element', 'The element is not one of the pathway elements.'); return s && s.slug; });
      return { id: c.id, label: c.label, elements: els };
    }).filter(Boolean);
  }
  P.ready = B.length === 0;
  return P;
}

let owners;
async function conceptMap(elementDocs, setProposals, H) {
  owners ||= await import(pathToFileURL(path.join(__dirname, 'vendor', 'ccis', 'ccis-concept-owners.js')).href);
  const safe = s => (typeof s === 'string' && H.ID_RE.test(s) ? s : '?');
  const setOf = id => setProposals.find(s => s.source.artefactId === id);
  const ref = r => { const s = setOf(r.element); return { set: s ? s.slug : null, field: s && s.fieldIds[r.key] ? s.fieldIds[r.key] : null }; };
  const blockers = [];
  const map = owners.conceptOwners(elementDocs).map(e => {
    if (e.status !== 'ok') blockers.push({ path: '', code: 'concept-owner', message: `The concept "${safe(e.concept)}" has status ${e.status} (elements: ${[...new Set([...e.owners, ...e.users].map(o => safe(o.element)))].join(', ')}).` });
    return { concept: e.concept, owner: e.owners.length === 1 || e.status === 'second-owner' ? (e.owners[0] ? ref(e.owners[0]) : null) : null, users: e.users.map(ref), status: e.status };
  });
  return { map, blockers };
}

module.exports = { pathwayProposal, conceptMap, MAX_STEPS };
