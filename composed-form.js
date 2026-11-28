'use strict';
/* Task D12a: pure composed form model. ONE copy, for the server (require) and the page (<script src>), like pathway-form.js.
   composeForm({ pathways, sets }) -> { sections, contexts, shared, unplaced, notes, problems }.
   pathways: [{ slug, version, entryForm, contexts }] in applied order. sets: slug -> { title, fields } (a field may carry a local `concept` key).
   Layout only. A set is placed once (first placement wins). A field whose concept is already placed by another field is not drawn again: it is listed
   under `shared` (owner = first placement, ED-12). Fields with no concept are never merged, and nothing is matched by label. Notes and problems are codes and ids only.
   No DOM, database, clock, network or random; inputs are never changed. Prototype. Synthetic data only. Not for clinical use. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./pathway-form')); else root.ComposedForm = factory(root.PathwayForm); })(typeof self !== 'undefined' ? self : this, function (PathwayForm) {
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function composeForm(input) {
    const inp = isObj(input) ? input : {}, sets = isObj(inp.sets) ? inp.sets : {};
    const notes = [], problems = [], secs = new Map(), ctx = new Map(), owners = new Map(), sharedList = [];
    const placedSets = new Set(), placedSections = new Set();
    const note = (code, id) => { if (!notes.some(n => n.code === code && n.id === id)) notes.push({ code, id }); };
    const conceptOf = (set, id) => { const f = arr(sets[set] && sets[set].fields).find(x => isObj(x) && x.id === id); return f && typeof f.concept === 'string' && f.concept ? f.concept : null; };
    arr(inp.pathways).filter(isObj).forEach(p => {
      const form = PathwayForm.buildForm({ entryForm: p.entryForm, contexts: p.contexts, sets });
      form.problems.forEach(pr => { if (!problems.some(x => x.code === pr.code && x.message === pr.message)) problems.push(pr); });
      form.sections.forEach(sec => {
        let out = secs.get(sec.id);
        if (!out) { out = { id: sec.id, label: sec.label, items: [] }; secs.set(sec.id, out); }
        else if (out.label !== sec.label) note('section-label', sec.id);
        sec.items.forEach(it => {
          if (it.kind === 'section') {
            if (placedSections.has(it.section)) return;
            placedSections.add(it.section); return out.items.push({ ...it });
          }
          if (placedSets.has(it.set)) return;   // first placement wins
          placedSets.add(it.set);
          const keep = [];
          it.fields.forEach(f => {
            const c = conceptOf(it.set, f.id), at = { set: it.set, field: f.id };
            if (c === null) return keep.push(f);
            const o = owners.get(c);
            if (!o) { owners.set(c, { concept: c, owner: at, users: [] }); sharedList.push(owners.get(c)); return keep.push({ ...f, concept: c }); }
            o.users.push(at);
          });
          if (!keep.length && it.fields.length) return note('no-field-left', it.set);
          const ids = new Set(keep.map(f => f.id));
          out.items.push({ ...it, fields: keep, rows: it.rows.map(g => g.filter(id => ids.has(id))).filter(g => g.length) });
        });
      });
      form.contexts.forEach(c => {
        const have = ctx.get(c.id);
        if (!have) return ctx.set(c.id, { id: c.id, label: c.label, sets: [...c.sets] });
        if (have.label !== c.label) note('context-label', c.id);
        c.sets.forEach(s => { if (!have.sets.includes(s)) have.sets.push(s); });
      });
    });
    return { sections: [...secs.values()], contexts: [...ctx.values()], shared: sharedList.filter(o => o.users.length), unplaced: Object.keys(sets).filter(k => !placedSets.has(k)), notes, problems };
  }
  return { composeForm };
});
