'use strict';
// Task R6e: FHIR Questionnaire -> element set DRAFT definition. Pure: no database, clock, network or random.
// Builds the body for the existing POST /api/element-sets ({ slug, kind, definition }): that route stores it as version 1 DRAFT, and it can only
// become usable through submit, review and publish (8b to 8c-2). Nothing here publishes, approves or applies anything.
// Rules kept here:
//  - Reuses sdc.js (sdcToSet) for the item walk, then keeps ONLY what the stored-definition whitelist allows. Nothing else is passed on.
//  - NO codes are imported: every item.code entry and every answer-option coding is dropped and counted (imported codes are unverified;
//    no licensed system is loaded; the set reaches review uncoded).
//  - Nothing is silently changed: text that is too long, too many fields or items nested too deeply are REFUSED with a message, never cut.
//    What cannot be carried over (conditional display, calculations, multi-answer, unknown item types, value-set options) is listed in `warnings`.
//  - The original Questionnaire is not kept, and no number or null is written (stored definitions hold text, true/false, lists and objects only).
const Sdc = require('./sdc');

class ImportError extends Error { constructor(m) { super(m); this.name = 'ImportError'; } }

const LIM = { title: 200, desc: 2000, fieldLabel: 200, fieldText: 500, option: 200, options: 100, fields: 200, path: 10, unit: 40, id: 64, linkId: 200, sdcType: 40, groupText: 500 };
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BAD = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;   // NUL and lone surrogates cannot be stored
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function depthOf(items, d) {
  let m = d;
  for (const it of (Array.isArray(items) ? items : [])) if (isObj(it)) m = Math.max(m, it.type === 'group' ? depthOf(it.item, d + 1) : d);
  return m;
}

function slugFrom(q) {
  const base = String(q.name || q.title || q.id || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64).replace(/_+$/, '');
  return SLUG_RE.test(base) ? base : 'imported_questionnaire';
}

// q: a parsed Questionnaire (object). opts.slug: optional, must already be a valid slug. Returns { slug, kind, definition, warnings, dropped, counts }.
function questionnaireToDefinition(q, opts = {}) {
  if (!isObj(q) || q.resourceType !== 'Questionnaire') throw new ImportError('This is not a FHIR Questionnaire.');
  if (depthOf(q.item, 0) > LIM.path) throw new ImportError('Groups are nested more than ' + LIM.path + ' deep.');
  let removed = 0;
  const clean = s => { const t = String(s); const c = t.replace(BAD, ''); removed += t.length - c.length; return c; };
  const dropped = [], counts = { fields: 0, codesDropped: 0, optionCodesDropped: 0, charactersRemoved: 0 };

  let r;
  try { r = Sdc.sdcToSet(q, { known: () => null, now: () => '' }); }                     // known() = null: no code is accepted as a binding
  catch (e) { throw new ImportError(e.message === 'No usable items in this Questionnaire' ? 'This Questionnaire has no items that can be turned into fields.' : e.message); }
  if (r.fields.length > LIM.fields) throw new ImportError('This Questionnaire has ' + r.fields.length + ' fields; at most ' + LIM.fields + ' are allowed.');

  const need = (v, max, what) => { if (String(v).length > max) throw new ImportError(what + ' is longer than ' + max + ' characters. It was not cut: shorten it in the source and import again.'); return clean(v); };
  const fields = r.fields.map((f, i) => {
    const w = 'Item ' + (f.linkId || (i + 1));
    const out = { id: need(f.id, LIM.id, w + ' id'), label: need(f.label, LIM.fieldLabel, w + ' label'), type: f.type };
    if (f.linkId) out.linkId = need(f.linkId, LIM.linkId, w + ' linkId');
    if (f.sdcType) out.sdcType = need(f.sdcType, LIM.sdcType, w + ' type');
    if (f.text) out.text = need(f.text, LIM.fieldText, w + ' text');
    if (f.required === true) out.required = true;
    if (typeof f.unit === 'string' && f.unit) out.unit = need(f.unit, LIM.unit, w + ' unit');
    if (Array.isArray(f.path) && f.path.length) out.path = f.path.map(g => { const p = { linkId: need(g.linkId || '', LIM.linkId, w + ' group id') }; if (g.text) p.text = need(g.text, LIM.groupText, w + ' group text'); return p; });
    if (Array.isArray(f.options)) {
      if (f.options.length > LIM.options) throw new ImportError(w + ' has ' + f.options.length + ' options; at most ' + LIM.options + ' are allowed.');
      out.options = f.options.map(o => need(o, LIM.option, w + ' option'));
    }
    counts.codesDropped += (Array.isArray(f.otherCodes) ? f.otherCodes.length : 0);
    counts.optionCodesDropped += f.optCodings ? Object.keys(f.optCodings).length : 0;
    return out;
  });
  // item.code entries (they never became bindings because known() is null) are counted from the source so the number is true
  let srcCodes = 0;
  (function walk(items) { for (const it of (Array.isArray(items) ? items : [])) if (isObj(it)) { if (it.type === 'group') walk(it.item); else if (it.type !== 'display' && Array.isArray(it.code)) srcCodes += it.code.length; } })(q.item);
  counts.codesDropped = srcCodes;
  counts.fields = fields.length;

  const definition = { title: need(r.title, LIM.title, 'The title'), fields };
  if (typeof q.title !== 'string' && typeof q.name !== 'string') dropped.push('No title or name in the source: a placeholder title was used.');
  if (typeof q.description === 'string' && q.description.trim()) {
    if (q.description.length <= LIM.desc) definition.desc = clean(q.description); else dropped.push('The description is longer than ' + LIM.desc + ' characters and was not kept.');
  }
  const sdc = {};
  for (const [k, max] of [['url', 500], ['version', 100], ['publisher', 200]]) if (typeof q[k] === 'string' && q[k].trim()) { if (q[k].length <= max) sdc[k] = clean(q[k]); else dropped.push('The ' + k + ' is longer than ' + max + ' characters and was not kept.'); }
  if (Object.keys(sdc).length) definition.sdc = { ...sdc, modified: false };
  if (counts.codesDropped) dropped.push(counts.codesDropped + ' item code(s) not imported (imported codes are unverified).');
  if (counts.optionCodesDropped) dropped.push(counts.optionCodesDropped + ' answer-option code(s) not imported; the option text was kept.');
  if (Array.isArray(r.sdc && r.sdc.declaredProfiles) && r.sdc.declaredProfiles.length) dropped.push('Declared profiles are not kept.');
  counts.charactersRemoved = removed;
  if (removed) dropped.push(removed + ' character(s) that cannot be stored were removed.');

  let slug = opts.slug === undefined ? slugFrom(q) : opts.slug;
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new ImportError('The set id must be 1 to 64 lowercase letters, digits, _ or -, starting with a letter or digit.');
  return { slug, kind: 'custom', definition, warnings: [...r.warn], dropped, counts };
}

module.exports = { questionnaireToDefinition, ImportError, LIMITS: LIM };
