'use strict';
/* Shared element-set lint (chunk 08a). ONE copy, used by the browser page (<script src="lint.js">) and by the server (require('./lint')).
   Pure functions: no network, no DOM, no database. Anything that depends on the app is passed in:
     env.bindingState(binding, field) -> 'verified' or any other word (the page passes its own bst; never called against a server here)
     env.scrub(text, known)           -> { text, counts } like deid.scrub. Default in Node: ./deid. Pass false to switch the check off.
     env.known                        -> optional registered-patient matchers (deid.buildKnown) so typed names are caught exactly
     env.systems                      -> optional list of valid code-system keys
   lint(set, env) returns { ok, findings, needsTwoReviewers }, findings = [{severity, path, rule, message}], severity 'error' | 'warning'.
   `ok` means no 'error' finding. Unknown never counts as passing: no bindingState supplied means every bound code is reported unverified.

   Optional `citation` (on a set or on a field): free text, 1 to 500 characters, saying where a dose, threshold or number comes from
   (guideline, year, section or URL). It is never scanned for patient-like text, since a citation may be a URL. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmrLint = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const RULES = ['schema', 'unverified-code', 'dose-no-citation', 'executable', 'patient-like'];
  const SET_KINDS = ['template', 'care', 'disease', 'pathway'];
  const FIELD_TYPES = ['text', 'number', 'integer', 'select', 'boolean', 'datetime'];
  const POLICY_MODES = ['skip', 'custom'];
  const MAX_CITATION = 500;

  // Keys that mean "this set carries a rule or a band". None exist in seed content (test/safety-content.test.js).
  const RULEISH_KEYS = ['rule', 'rules', 'band', 'bands', 'threshold', 'thresholds', 'cutoff', 'cutoffs', 'alert', 'alerts',
    'trigger', 'triggers', 'formula', 'expression', 'calculated', 'enablewhen'];

  // Dose or threshold-like text: a number with a unit, or a comparison sign before a number. Superset of the page's DOSE_RE.
  const DOSE_RE = /\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|μg|ug|g|kg|ml|l|units?|iu|meq|mmol|µmol|μmol|umol|mol|mmhg|bpm|\/min|%)(?![a-z0-9])|[≥≤<>]=?\s*\d/i;

  // Executable or markup-like content. Element-set text is plain text; none of this belongs in it.
  const EXEC = [
    [/<\s*\/?\s*script/i, '<script'],
    [/(?:java|vb)script\s*:/i, 'a javascript: URL'],
    [/\bdata\s*:\s*text\/html/i, 'a data:text/html URL'],
    [/\bon(?:abort|animation\w*|blur|change|click|copy|cut|dblclick|drag\w*|drop|error|focus\w*|hashchange|input|key\w+|load\w*|message|mouse\w+|paste|pointer\w+|reset|resize|scroll|select|submit|toggle|touch\w+|transition\w+|unload|wheel|begin|end)\s*=/i, 'an on…= event handler'],
    [/["'`\/]on[a-z]{3,}\s*=/i, 'an on…= event handler'],
    [/<\/?[a-z][a-z0-9-]*[\s>\/]/i, 'an HTML tag']
  ];

  let defaultScrub = null;
  try { if (typeof require === 'function' && typeof module === 'object') defaultScrub = require('./deid').scrub; } catch (_) { /* browser, or deid.js missing */ }

  const isStr = v => typeof v === 'string';
  const nonEmpty = v => isStr(v) && v.trim() !== '';
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const join = (p, k) => (p ? p + '.' : '') + k;

  function walkStrings(v, path, fn, depth = 0) {
    if (depth > 20) return;
    if (isStr(v)) fn(path, v);
    else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, fn, depth + 1));
    else if (isObj(v)) Object.keys(v).forEach(k => walkStrings(v[k], join(path, k), fn, depth + 1));
  }

  // The free text a person wrote (current version only): what the dose and patient-like rules read. The citation is left out on purpose.
  function freeText(set) {
    const out = [];
    const add = (path, v) => { if (isStr(v) && v.trim()) out.push({ path, text: v }); };
    add('title', set.title); add('desc', set.desc);
    (Array.isArray(set.fields) ? set.fields : []).forEach((f, i) => {
      if (!isObj(f)) return;
      add(`fields[${i}].label`, f.label); add(`fields[${i}].rationale`, f.rationale);
      (Array.isArray(f.options) ? f.options : []).forEach((o, j) => add(`fields[${i}].options[${j}]`, o));
    });
    return out;
  }

  function checkCitation(v, path, add) {
    if (v === undefined) return;
    if (!nonEmpty(v) || v.length > MAX_CITATION) add('error', path, 'schema', `citation must be text of 1 to ${MAX_CITATION} characters.`);
  }

  /* Rule 1: schema */
  function checkSchema(set, env, add) {
    if (!isObj(set)) return add('error', '', 'schema', 'An element set must be an object.');
    if (!nonEmpty(set.id)) add('error', 'id', 'schema', 'id is required.');
    if (!nonEmpty(set.title)) add('error', 'title', 'schema', 'title is required.');
    if (!SET_KINDS.includes(set.kind)) add('error', 'kind', 'schema', `kind must be one of: ${SET_KINDS.join(', ')}.`);
    if (set.desc !== undefined && !isStr(set.desc)) add('error', 'desc', 'schema', 'desc must be text.');
    checkCitation(set.citation, 'citation', add);
    if (set.kind === 'pathway') {
      if (!Array.isArray(set.members) || !set.members.length || !set.members.every(nonEmpty)) add('error', 'members', 'schema', 'A pathway needs a non-empty list of member set ids.');
      return;
    }
    if (!Array.isArray(set.fields) || !set.fields.length) return add('error', 'fields', 'schema', 'fields must be a non-empty list.');
    const seen = new Set();
    set.fields.forEach((f, i) => {
      const p = `fields[${i}]`;
      if (!isObj(f)) return add('error', p, 'schema', 'A field must be an object.');
      if (!nonEmpty(f.id)) add('error', `${p}.id`, 'schema', 'Field id is required.');
      else if (seen.has(f.id)) add('error', `${p}.id`, 'schema', `Duplicate field id "${f.id}".`);
      else seen.add(f.id);
      if (!nonEmpty(f.label)) add('error', `${p}.label`, 'schema', 'Field label is required.');
      if (!FIELD_TYPES.includes(f.type)) add('error', `${p}.type`, 'schema', `type must be one of: ${FIELD_TYPES.join(', ')}.`);
      if (f.type === 'select') {
        if (!Array.isArray(f.options) || !f.options.length || !f.options.every(nonEmpty)) add('error', `${p}.options`, 'schema', 'A select field needs a non-empty list of options.');
      } else if (f.options !== undefined) add('error', `${p}.options`, 'schema', 'options belong to select fields only.');
      if (f.unit !== undefined && !isStr(f.unit)) add('error', `${p}.unit`, 'schema', 'unit must be text.');
      for (const k of ['repeat', 'required']) if (f[k] !== undefined && typeof f[k] !== 'boolean') add('error', `${p}.${k}`, 'schema', `${k} must be true or false.`);
      checkCitation(f.citation, `${p}.citation`, add);
      if (f.bindings !== undefined) {
        if (!Array.isArray(f.bindings)) add('error', `${p}.bindings`, 'schema', 'bindings must be a list.');
        else f.bindings.forEach((b, j) => {
          const bp = `${p}.bindings[${j}]`;
          if (!isObj(b)) return add('error', bp, 'schema', 'A binding must be an object.');
          if (!nonEmpty(b.system)) add('error', `${bp}.system`, 'schema', 'Binding system is required.');
          else if (Array.isArray(env.systems) && !env.systems.includes(b.system)) add('error', `${bp}.system`, 'schema', `Unknown code system "${b.system}".`);
          if (!nonEmpty(b.code)) add('error', `${bp}.code`, 'schema', 'Binding code is required.');
          if (b.display !== undefined && !isStr(b.display)) add('error', `${bp}.display`, 'schema', 'Binding display must be text.');
        });
      }
      if (f.codingPolicy !== undefined) {
        const cp = f.codingPolicy;
        if (!isObj(cp) || !POLICY_MODES.includes(cp.mode)) add('error', `${p}.codingPolicy`, 'schema', `codingPolicy.mode must be one of: ${POLICY_MODES.join(', ')}.`);
        else if (cp.mode === 'custom' && !(Array.isArray(cp.systems) && cp.systems.every(nonEmpty))) add('error', `${p}.codingPolicy.systems`, 'schema', 'A custom coding policy needs a list of system keys.');
      }
    });
  }

  /* Rule 2: every bound code is verified (the state is passed in; nothing is looked up here). Coding stays optional: no binding, no finding. */
  function checkCodes(set, env, add) {
    if (!Array.isArray(set.fields)) return;
    const check = (b, f, path, label) => {
      let state = 'unknown';
      if (typeof env.bindingState === 'function') { try { state = String(env.bindingState(b, f)); } catch (_) { state = 'error'; } }
      if (state !== 'verified') add('error', path, 'unverified-code', `${label} ${b.system || '(no system)'} ${b.code} is not verified (${state}). Verify it, or remove the binding.`);
    };
    set.fields.forEach((f, i) => {
      if (!isObj(f)) return;
      (Array.isArray(f.bindings) ? f.bindings : []).forEach((b, j) => { if (isObj(b) && nonEmpty(b.code)) check(b, f, `fields[${i}].bindings[${j}]`, 'Code'); });
      if (isObj(f.coding) && nonEmpty(f.coding.code)) check(f.coding, f, `fields[${i}].coding`, 'Code (old coding format)');
    });
  }

  /* Rule 3: dose or threshold-like text needs a citation (on the field or on the set). Returns true if any such text exists. */
  function checkDoses(set, add) {
    let found = false;
    const setCited = nonEmpty(set.citation);
    for (const { path, text } of freeText(set)) {
      if (!DOSE_RE.test(text)) continue;
      found = true;
      const m = /^fields\[(\d+)\]/.exec(path);
      const f = m && Array.isArray(set.fields) ? set.fields[+m[1]] : null;
      if (setCited || (f && nonEmpty(f.citation))) continue;
      add('error', path, 'dose-no-citation', 'Dose or threshold-like text without a citation. Add a citation, or remove the text.');
    }
    return found;
  }

  /* Rule 4: executable or markup-like content anywhere in the set (every string, any depth). One finding per string. */
  function checkExecutable(set, add) {
    walkStrings(set, '', (path, s) => {
      const hit = EXEC.find(([re]) => re.test(s));
      if (hit) add('error', path, 'executable', `Contains ${hit[1]}. Element sets are plain text; remove it.`);
    });
  }

  /* Rule 5: patient-like strings, using the de-identification patterns (deid.js). A safety net, not a guarantee. */
  function checkPatientLike(set, env, add) {
    const scrub = env.scrub === false ? null : (typeof env.scrub === 'function' ? env.scrub : defaultScrub);
    if (!scrub) return add('warning', '', 'patient-like', 'Patient-like text was not checked here (no scrub function). The server checks again.');
    for (const { path, text } of freeText(set)) {
      const { counts } = scrub(text, env.known);
      const kinds = Object.keys(counts || {});
      if (kinds.length) add('error', path, 'patient-like', `Looks like patient data (${kinds.join(', ')}). Remove it; element sets never hold patient details.`);
    }
  }

  function hasRuleishKeys(set) {
    const has = o => isObj(o) && Object.keys(o).some(k => RULEISH_KEYS.includes(k.toLowerCase()));
    return has(set) || (Array.isArray(set.fields) && set.fields.some(has));
  }

  function lint(set, env) {
    env = env || {};
    const findings = [];
    const add = (severity, path, rule, message) => findings.push({ severity, path, rule, message });
    checkSchema(set, env, add);
    let needsTwoReviewers = false;
    if (isObj(set)) {
      checkCodes(set, env, add);
      needsTwoReviewers = checkDoses(set, add) || hasRuleishKeys(set);
      checkExecutable(set, add);
      checkPatientLike(set, env, add);
    }
    return { ok: !findings.some(f => f.severity === 'error'), findings, needsTwoReviewers };
  }

  return { lint, RULES, SET_KINDS, FIELD_TYPES, MAX_CITATION };
});
