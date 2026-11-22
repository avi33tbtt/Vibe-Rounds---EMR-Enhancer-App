'use strict';
/* Shared FHIR SDC code (chunk 03). ONE copy, used by the browser page (<script src="sdc.js">) and by the server (require('./sdc')).
   Pure functions: nothing here reads localStorage, the DOM or the code-system registry. Anything that depends on the app is passed in:
     env.known(coding)      -> registry key for a Questionnaire item.code entry, or null if the system is unknown/off
     env.codings(field)     -> FHIR Coding[] to write for a field (the app passes verified bindings only)
     env.now()              -> ISO timestamp
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmrSdc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SDCT = { string: 'text', text: 'text', url: 'text', integer: 'integer', decimal: 'number', quantity: 'number', boolean: 'boolean', date: 'datetime', dateTime: 'datetime', time: 'text', choice: 'select', 'open-choice': 'select' };
  const TQ = { text: 'string', number: 'decimal', integer: 'integer', boolean: 'boolean', datetime: 'dateTime', select: 'choice' };
  const UC = { 'mg/dL': 'mg/dL', 'mmol/L': 'mmol/L', 'mEq/L': 'meq/L', 'g/dL': 'g/dL', 'mmHg': 'mm[Hg]', 'bpm': '/min', 'beats/min': '/min', '/min': '/min', '°C': 'Cel', '°F': '[degF]', 'kg': 'kg', 'g': 'g', 'mg': 'mg', 'mL': 'mL', 'L': 'L', '%': '%', 'µmol/L': 'umol/L', 'umol/L': 'umol/L', 'mg/L': 'mg/L', 'U/L': 'U/L', 'mL/h': 'mL/h', 'mL/min': 'mL/min', 'h': 'h', 'min': 'min' };
  const slug = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const qty = (v, u) => { const q = { value: +v }; if (u) { q.unit = u; if (UC[u]) { q.system = 'http://unitsofmeasure.org'; q.code = UC[u]; } } return q; };

  /* What a Questionnaire authored from an internal element set cannot express. Shown before generation in SDC mode. */
  const LIMITS = [
    { key: 'enableWhen', text: 'Conditional display (enableWhen): element sets have no show/hide rules, so none are written. Every item is always shown.' },
    { key: 'calculated', text: 'Calculated expressions (calculatedExpression, initialExpression): not written. Every value is typed in or left empty.' },
    { key: 'valueSet', text: 'Value-set options: choices are written as a fixed inline answerOption list, never as a ValueSet link, and option codes are not generated.' }
  ];

  function sdcToSet(q, env) {
    if (!q || q.resourceType !== 'Questionnaire') throw Error('Not a FHIR Questionnaire');
    const fields = [], warn = [], seen = new Set();
    const walk = (items, path) => (items || []).forEach(it => {
      if (it.enableWhen || it.enableWhenExpression) warn.push(`${it.linkId}: conditional display not enforced`);
      if ((it.extension || []).some(e => /calculatedExpression|initialExpression/.test(e.url || ''))) warn.push(`${it.linkId}: calculated expression ignored`);
      if (it.type === 'display') return;
      if (it.type === 'group') { walk(it.item, [...path, { linkId: it.linkId, text: it.text || '' }]); return; }
      const t = SDCT[it.type]; if (!t) { warn.push(`${it.linkId}: type ${it.type} skipped`); return; }
      let fid = slug(it.linkId) || 'q', b = fid, k = 2; while (seen.has(fid)) fid = b + '_' + k++; seen.add(fid);
      const f = { id: fid, linkId: it.linkId, sdcType: it.type, text: it.text || it.linkId, label: [...path.map(g => g.text).filter(Boolean), it.text || it.linkId].join(' › '), type: t };
      if (path.length) f.path = path;
      if (it.required) f.required = true;
      if (it.repeats) warn.push(`${it.linkId}: multi-answer not supported (single value kept)`);
      const u = (it.extension || []).find(e => (e.url || '').endsWith('questionnaire-unit')); if (u && u.valueCoding && u.valueCoding.code) f.unit = u.valueCoding.code;
      if (t === 'select') {
        const ao = it.answerOption || [];
        f.options = ao.map(o => String(o.valueString ?? o.valueCoding?.display ?? o.valueCoding?.code ?? o.valueInteger ?? '')).filter(Boolean);
        ao.forEach(o => { if (o.valueCoding) (f.optCodings = f.optCodings || {})[o.valueCoding.display || o.valueCoding.code] = o.valueCoding; });
        if (!f.options.length) { f.type = 'text'; delete f.options; warn.push(`${it.linkId}: value-set options not expanded here — captured as text`); }
      }
      const bl = (it.code || []).filter(c => c.code && env.known(c)).map(c => ({ system: env.known(c), code: String(c.code), display: c.display || '', source: 'sdc' }));
      if (bl.length) f.bindings = bl;
      const oc = (it.code || []).filter(c => !(c.code && env.known(c))); if (oc.length) f.otherCodes = oc;
      fields.push(f);
    });
    walk(q.item, []);
    if (!fields.length) throw Error('No usable items in this Questionnaire');
    return { fields, warn, title: q.title || q.name || 'Imported questionnaire', desc: q.description || 'Imported FHIR Questionnaire',
      sdc: { url: q.url || '', version: q.version || '', publisher: q.publisher || '', declaredProfiles: (q.meta && q.meta.profile) || [], warnings: warn, original: q, importedAt: env.now() } };
  }

  function nest(fields, mk, isQR) {
    const root = [], gm = {};
    fields.forEach(f => {
      const it = mk(f); if (!it) return; let cur = root;
      (f.path || []).forEach((g, i) => {
        const key = f.path.slice(0, i + 1).map(x => x.linkId).join('/'); let n = gm[key];
        if (!n) { n = isQR ? { linkId: g.linkId, text: g.text, item: [] } : { linkId: g.linkId, text: g.text, type: 'group', item: [] }; gm[key] = n; cur.push(n); }
        cur = n.item;
      });
      cur.push(it);
    });
    return root;
  }

  /* Deterministic: same set + same verified codes in = same Questionnaire out. An unmodified imported Questionnaire is returned as it came in. */
  function buildQuestionnaire(s, env) {
    if (s.sdc && !s.sdc.modified && s.sdc.original) return s.sdc.original;
    const item = nest(s.fields, f => {
      const it = { linkId: f.linkId || f.id, text: f.text || f.label, type: f.sdcType && SDCT[f.sdcType] === f.type ? f.sdcType : (TQ[f.type] || 'string') };
      if (f.required) it.required = true;
      if (f.repeat) it.repeats = true;   // serial values are several answers; SDC needs repeats:true for that
      if (f.unit && f.type === 'number') it.extension = [{ url: 'http://hl7.org/fhir/StructureDefinition/questionnaire-unit', valueCoding: UC[f.unit] ? { system: 'http://unitsofmeasure.org', code: UC[f.unit], display: f.unit } : { display: f.unit } }];
      if (f.type === 'select') it.answerOption = (f.options || []).map(o => f.optCodings && f.optCodings[o] ? { valueCoding: f.optCodings[o] } : { valueString: o });
      const ec = env.codings(f); if (ec.length) it.code = ec;
      return it;
    });
    return { resourceType: 'Questionnaire', url: 'urn:emr-enhancer:questionnaire:' + s.id, version: String(s.version || 1), name: s.id, title: s.title, status: 'draft', description: s.desc || '', item };
  }

  /* Attach SDC authoring to an element set: marks it and stores the Questionnaire built from its own fields, together with it. */
  function authorInto(set, env) {
    const q = buildQuestionnaire({ ...set, sdc: undefined }, env);
    set.questionnaire = q;
    set.sdc = { authored: true, builtAt: env.now(), limitations: LIMITS.map(l => l.key) };
    return set;
  }

  function ansObj(f, v) {
    if (v === '' || v == null) return null;
    if (f.sdcType === 'date') return { valueDate: String(v).slice(0, 10) };
    if (f.sdcType === 'url') return { valueUri: String(v) };
    if (f.sdcType === 'quantity') return { valueQuantity: qty(v, f.unit) };
    if (f.type === 'integer') return { valueInteger: +v };
    if (f.type === 'number') return { valueDecimal: +v };
    if (f.type === 'boolean') return { valueBoolean: v === 'Yes' || v === true };
    if (f.type === 'datetime') return { valueDateTime: new Date(v).toISOString() };
    if (f.optCodings && f.optCodings[v]) return { valueCoding: f.optCodings[v] };
    return { valueString: String(v) };
  }

  /* ctx: {values, rows(fid) -> [{value}], pid, author, now} */
  function buildQR(s, ctx) {
    const item = nest(s.fields, f => {
      const vals = f.repeat ? ctx.rows(f.id).map(r => r.value) : [ctx.values[f.id]];
      const answer = vals.map(v => ansObj(f, v)).filter(Boolean);
      return answer.length ? { linkId: f.linkId || f.id, text: f.text || f.label, answer } : null;
    }, true);
    if (!item.length) return null;
    const qc = (s.sdc && !s.sdc.modified && s.sdc.url) ? s.sdc.url + (s.sdc.version ? '|' + s.sdc.version : '') : 'urn:emr-enhancer:questionnaire:' + s.id + '|' + (s.version || 1);
    return { resourceType: 'QuestionnaireResponse', questionnaire: qc, status: 'in-progress', subject: { reference: ctx.pid }, authored: ctx.now, author: { display: ctx.author }, item };
  }

  return { SDCT, TQ, UC, LIMITS, slug, qty, sdcToSet, nest, buildQuestionnaire, authorInto, ansObj, buildQR };
});
