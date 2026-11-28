'use strict';
// Task D5: CCIS package bundle -> reviewable DRAFT set proposals. Pure: no database, clock, network or random. NOTHING is written anywhere.
// A proposal is a draft for a person to look at and accept later (D6 stores, D7 accepts); it is never a record.
// Rules kept here (docs/PACKAGE-DESIGN.md sections 7 and 8, ED-17, ED-78, ED-80, ED-81):
//  - Every artefact is checked against its CCIS checksum (sha256 of canonical JSON); a mismatch is a blocker and that artefact is not read.
//  - Nothing is guessed: two units, a count above 1, a code field without a resolvable value set, a non-local concept system, or text that is not plain
//    becomes a BLOCKER. Text is never cut. Blocker messages name paths and codes only, never the text itself.
//  - Source checksums leave here as bare hex (the EMR column holds no prefix). Concept keys are plain strings (implicitly the `local` system).
// Prototype. Synthetic data only. Not for clinical use.
const path = require('path');
const { pathToFileURL } = require('url');
const { validateDefinition } = require('./sets');

const LIMITS = { artefacts: 60, bytes: 1000000, fields: 200, citation: 500, title: 200, desc: 2000 };
const FORMAT = 'ccis-package-bundle/1';
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/, ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TYPE_MAP = { string: 'text', integer: 'integer', quantity: 'number', boolean: 'boolean', datetime: 'datetime', code: 'select' };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, SCHEME = /\b(?:[a-z][a-z0-9+.-]*:\/\/|javascript:|data:|vbscript:)/i;
const plain = s => typeof s === 'string' && s.trim() !== '' && !/[<>]/.test(s) && !CONTROL.test(s) && !SCHEME.test(s);

class PackageImportError extends Error { constructor(m) { super(m); this.name = 'PackageImportError'; } }

let ccis;
const load = async () => (ccis ||= await import(pathToFileURL(path.join(__dirname, 'vendor', 'ccis', 'ccis-compile.js')).href));

function fieldsOf(doc) {
  const own = arr(doc.fields).map((f, i) => [f, `/fields/${i}`]);
  const mod = arr(doc.modules).flatMap((m, a) => (isObj(m) ? arr(m.fields).map((f, b) => [f, `/modules/${a}/fields/${b}`]) : []));
  return [...own, ...mod];
}

function convertField(f, at, ctx, B) {
  const out = {};
  const block = (code, msg, p = at) => B.push({ path: p, code, message: msg });
  if (!isObj(f)) return block('field-shape', 'The field is not an object.'), null;
  const id = typeof f['x-emrFieldId'] === 'string' ? f['x-emrFieldId'] : f.key;
  if (typeof id !== 'string' || !ID_RE.test(id)) block('field-id', 'The field id is not valid for the EMR.');
  else out.id = id;
  if (!plain(f.label)) block('text-not-plain', 'The label is missing or is not plain text.', at + '/label'); else out.label = f.label;
  const t = TYPE_MAP[f.type];
  if (!t) block('type-unsupported', `The field type "${String(f.type).slice(0, 20).replace(/[^\w-]/g, '?')}" is not supported.`, at + '/type'); else out.type = t;
  const units = arr(f.units);
  if (units.length > 1) block('units-many', 'The field has more than one unit; the EMR holds one.', at + '/units');
  else if (units.length === 1 && plain(units[0]) && units[0] !== '1' && (f.type === 'quantity' || f.type === 'integer')) out.unit = units[0];
  else if (units.length === 1 && !plain(units[0])) block('text-not-plain', 'The unit is not plain text.', at + '/units/0');
  const c = isObj(f.cardinality) ? f.cardinality : { min: 0, max: 1 };
  if (c.max === 'unbounded') out.repeat = true;
  else if (c.max !== 1) block('cardinality', 'The maximum count is above 1; the EMR holds a boolean, not a count.', at + '/cardinality/max');
  if (c.min === 1) out.required = true;
  if (arr(f.sourceClasses).includes('derived')) out.derived = true;
  if (isObj(f.concept)) {
    const cs = isObj(f.concept.codeSystem) ? f.concept.codeSystem.id : undefined;
    if (cs !== 'local') block('concept-system', 'The concept is not in the local code system.', at + '/concept/codeSystem');
    else if (typeof f.concept.code !== 'string' || !KEY_RE.test(f.concept.code)) block('concept-key', 'The concept key is not valid.', at + '/concept/code');
    else { out.concept = f.concept.code; ctx.concepts.push({ concept: f.concept.code, field: id }); }
  }
  if (f.type === 'code') {
    const vs = isObj(f.binding) && isObj(f.binding.valueSet) ? f.binding.valueSet : null;
    const set = vs && ctx.valueSets.get(`${vs.id}@${vs.version}`);
    if (!set) block('value-set', 'The code field has no value set in the bundle.', at + '/binding/valueSet');
    else {
      const opts = [];
      for (const m of arr(set.members)) {
        const d = isObj(m) ? ctx.display.get(m.key) : undefined;
        if (!plain(d)) block('option-text', 'A value set member has no plain display text.', at + '/binding/valueSet');
        else opts.push(d);
      }
      out.options = opts;
    }
  }
  return out;
}

function elementProposal(doc, sum, ctx) {
  const m = isObj(doc.manifest) ? doc.manifest : {};
  const B = [], slug = typeof m.id === 'string' ? m.id.replace(/\./g, '-') : '';
  const P = { key: 'set:' + slug, kind: 'set', draft: true, slug, setKind: 'custom', definition: null, source: { artefactId: m.id, version: m.version, checksum: sum }, concepts: [], blockers: B, warnings: [], ready: false };
  if (!SLUG_RE.test(slug)) B.push({ path: '/manifest/id', code: 'slug', message: 'The element id does not give a valid set slug.' });
  const title = m.name, desc = isObj(doc.intent) ? doc.intent.purpose : undefined, basis = isObj(doc.provenance) ? doc.provenance.basis : undefined;
  if (!plain(title) || title.length > LIMITS.title) B.push({ path: '/manifest/name', code: 'title', message: 'The title is missing, too long or not plain text.' });
  if (desc !== undefined && (!plain(desc) || desc.length > LIMITS.desc)) B.push({ path: '/intent/purpose', code: 'desc', message: 'The purpose is too long or not plain text.' });
  const all = fieldsOf(doc);
  if (!all.length) B.push({ path: '/fields', code: 'no-fields', message: 'The element has no fields.' });
  if (all.length > LIMITS.fields) B.push({ path: '/fields', code: 'too-many-fields', message: `The element has more than ${LIMITS.fields} fields.` });
  const local = { concepts: [], valueSets: ctx.valueSets, display: ctx.display };
  const fields = all.slice(0, LIMITS.fields).map(([f, at]) => convertField(f, at, local, B)).filter(Boolean);
  const def = { title, fields };
  if (desc !== undefined) def.desc = desc;
  if (plain(basis) && basis.length <= LIMITS.citation) def.citation = basis;   // longer or odd text is left out, never cut (design section 7)
  if (!B.length) for (const e of validateDefinition(def, slug, 'custom')) B.push({ path: e.path, code: 'definition', message: 'The set rules refuse the definition.' });
  P.definition = def; P.concepts = local.concepts; P.ready = B.length === 0;
  return P;
}

async function parsePackage(bundle) {
  if (!isObj(bundle) || bundle.format !== FORMAT) throw new PackageImportError('This is not a package bundle (format ' + FORMAT + ').');
  const items = bundle.artefacts;
  if (!Array.isArray(items) || !items.length) throw new PackageImportError('The bundle has no artefacts.');
  if (items.length > LIMITS.artefacts) throw new PackageImportError(`The bundle has ${items.length} artefacts; at most ${LIMITS.artefacts} are read in one go.`);
  const { canonicalize, checksumOf } = await load();
  const blockers = [], verified = [], seen = new Set();
  let bytes = 0;
  items.forEach((it, index) => {
    const at = `/artefacts/${index}`, add = (code, message) => blockers.push({ artefact: at, path: '', code, message });
    if (!isObj(it) || !isObj(it.document) || typeof it.checksum !== 'string') return add('artefact-shape', 'The entry needs a checksum and a document.');
    const c = canonicalize(it.document);
    if (!c.ok) return add('not-canonical', 'The document cannot be put in canonical form.');
    bytes += c.text.length;
    if (bytes > LIMITS.bytes) throw new PackageImportError('The bundle is larger than ' + LIMITS.bytes + ' bytes.');
    if (checksumOf(c.text) !== it.checksum) return add('checksum', 'The checksum does not match the document. It was not read.');
    const m = isObj(it.document.manifest) ? it.document.manifest : {}, id = `${m.id}@${m.version}`;
    if (seen.has(id)) return add('duplicate', 'The same artefact id and version appears twice.');
    seen.add(id);
    verified.push({ doc: it.document, sum: it.checksum.slice('sha256:'.length), index });
  });
  const ctx = { valueSets: new Map(), display: new Map() };
  for (const { doc } of verified) if (isObj(doc.manifest) && doc.manifest.type === 'terminology-package') {
    for (const c of arr(doc.concepts)) if (isObj(c) && typeof c.key === 'string') ctx.display.set(c.key, c.display);
    for (const v of arr(doc.valueSets)) if (isObj(v)) ctx.valueSets.set(`${v.id}@${v.version}`, v);
  }
  const proposals = [], slugs = new Set();
  for (const { doc, sum, index } of verified) {
    if (!isObj(doc.manifest) || doc.manifest.type !== 'contextual-element') continue;
    const p = elementProposal(doc, sum, ctx);
    if (p.slug && slugs.has(p.slug)) p.blockers.push({ path: '/manifest/id', code: 'slug-duplicate', message: 'Another element gives the same set slug.' });
    slugs.add(p.slug); p.ready = p.blockers.length === 0; p.artefact = `/artefacts/${index}`;
    proposals.push(p);
    for (const b of p.blockers) blockers.push({ artefact: p.artefact, ...b });
  }
  const counts = { artefacts: items.length, verified: verified.length, elements: proposals.length, ready: proposals.filter(p => p.ready).length, blockers: blockers.length };
  return { ok: blockers.length === 0 && proposals.length > 0, proposals, blockers, counts, bundleHash: checksumOf(canonicalize(bundle).text).slice(7) };
}

module.exports = { parsePackage, PackageImportError, LIMITS, FORMAT };
