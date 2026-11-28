'use strict';
/* Task D10: pure pathway form model. ONE copy, for the page (<script src>) and the server (require), like sdc.js.
   buildForm({ entryForm, contexts, sets }) -> { sections, contexts, unplaced, problems }. No DOM, database, clock, network or random; inputs are never changed.
   Layout only: no clinical logic, no number. Nothing is guessed: a missing set, an unknown field or section is skipped and named in `problems` (codes only, never package text).
   Text is copied as plain strings; escaping is the renderer's job. Prototype. Synthetic data only. Not for clinical use. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PathwayForm = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SETS = 30, MAX_FIELDS = 200;
  const TABS = { 'core.problems': 'problems', 'core.allergies': 'allergies', 'core.medications': 'medications', 'core.investigations': 'orders', 'core.care-episode': null };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const plain = v => (typeof v === 'string' ? v : '');
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function fieldOut(f) {
    const o = { id: plain(f.id), label: plain(f.label), type: plain(f.type) };
    if (typeof f.unit === 'string') o.unit = f.unit;
    if (Array.isArray(f.options)) o.options = f.options.filter(x => typeof x === 'string');
    if (f.derived === true) o.derived = true;
    return o;
  }

  function buildForm(input) {
    const inp = isObj(input) ? input : {}, sets = isObj(inp.sets) ? inp.sets : {}, problems = [], placed = new Set();
    const problem = (code, message) => problems.push({ code, message });
    let fieldCount = 0, setCount = 0;
    const sections = [];
    const ef = isObj(inp.entryForm) ? inp.entryForm : {};
    arr(ef.sections).forEach(sec => {
      if (!isObj(sec)) return;
      const out = { id: plain(sec.id), label: plain(sec.label), items: [] };
      arr(sec.items).forEach(it => {
        if (!isObj(it)) return;
        const visible = it.visibleByDefault !== false;
        if (it.kind === 'section') {
          if (typeof it.section !== 'string' || !has(TABS, it.section)) return problem('section-unknown', 'A section item is not one the EMR knows.');
          if (TABS[it.section] === null) problem('section-marker', 'A care-episode item only marks a place; the EMR shows no area for it.');
          return out.items.push({ kind: 'section', section: it.section, tab: TABS[it.section], visible });
        }
        if (it.kind !== 'element') return;
        const set = typeof it.set === 'string' && has(sets, it.set) && isObj(sets[it.set]) ? sets[it.set] : null;
        if (!set) return problem('set-missing', 'An element of the layout has no set definition.');
        if (!placed.has(it.set)) { if (setCount >= MAX_SETS) return problem('too-large', 'The form has more than ' + MAX_SETS + ' sets.'); setCount++; }
        placed.add(it.set);
        const byId = new Map(arr(set.fields).filter(isObj).map(f => [f.id, f]));
        const ids = Array.isArray(it.fields) ? it.fields : arr(set.fields).filter(isObj).map(f => f.id);
        const seen = new Set(), fields = [];
        ids.forEach(id => {
          if (!byId.has(id)) return problem('field-unknown', 'A field in the layout is not in its set.');
          if (seen.has(id)) return problem('field-twice', 'A field is placed twice in one element.');
          if (fieldCount >= MAX_FIELDS) return problem('too-large', 'The form has more than ' + MAX_FIELDS + ' fields.');
          seen.add(id); fieldCount++; fields.push(fieldOut(byId.get(id)));
        });
        const rows = arr(it.rowGroups).map(g => arr(g).filter(id => seen.has(id)).map(String)).filter(g => g.length);
        out.items.push({ kind: 'element', set: it.set, title: plain(set.title), visible, fields, rows });
      });
      sections.push(out);
    });
    const unplaced = Object.keys(sets).filter(k => !placed.has(k));
    const contexts = arr(inp.contexts).filter(isObj).map(c => ({ id: plain(c.id), label: plain(c.label), sets: arr(c.elements).filter(s => typeof s === 'string' && has(sets, s)) }));
    return { sections, contexts, unplaced, problems };
  }
  return { buildForm, TABS, MAX_SETS, MAX_FIELDS };
});
