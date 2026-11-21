/* Package lint (Phase 6, task 42a). Browser + Node, no dependencies.
   42a1: canonicalJson and sha256Hex. The content hash of a package is SHA-256 of canonicalJson(content). */
(function (root) {
  'use strict';

  /* Canonical JSON: object keys sorted (by UTF-16 code unit, so the order never depends on the locale),
     arrays keep their order, no whitespace. Anything JSON cannot hold exactly (undefined, functions,
     symbols, NaN, Infinity, dates, other class instances) throws, so a hash is never taken over a value that was silently changed. */
  function canonicalJson(v) {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return JSON.stringify(v);
    if (t === 'number') {
      if (!Number.isFinite(v)) throw new TypeError('canonicalJson: number is not finite');
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    if (t === 'object') {
      const p = Object.getPrototypeOf(v);
      if (p !== Object.prototype && p !== null) throw new TypeError('canonicalJson: only plain objects and arrays are allowed');
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
    }
    throw new TypeError('canonicalJson: ' + t + ' is not allowed');
  }

  /* SHA-256 of the UTF-8 bytes of text, as 64 lower-case hex characters. */
  async function sha256Hex(text) {
    const s = String(text);
    const g = typeof globalThis !== 'undefined' ? globalThis : root;
    if (g.crypto && g.crypto.subtle && typeof TextEncoder !== 'undefined') {
      const buf = await g.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (typeof require === 'function') return require('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex');
    throw new Error('sha256Hex: no crypto available');
  }

  /* 42a2: lintPackage skeleton. A package file is {manifest:{id, version, ...}, content:{...}}.
     Every finding is {code, path, message}; errors block an import, warnings (added later) do not. This task checks the manifest only. */
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
  const PACKAGE_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;   // dotted lower-case words, at least two, e.g. care.intake_output or local.my_form
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  /* 42a3. Field types a set may use (the list the app's own schema check uses, plus date). A package with another type is refused. */
  const FIELD_TYPES = ['datetime', 'date', 'duration_min', 'number', 'integer', 'select', 'boolean', 'text'];
  /* 42a4. Rule operators a package may use. Must equal OPS in cds-rules.js (a test reads that file and compares). A threshold must be a JSON number: a typed string is refused here even though the app's own editor accepts one. */
  const RULE_OPS = ['<', '<=', '>', '>=', '==', '!=', 'minutes_since_gt'];
  /* 42a5. Rules, bands and dose-like text need a source. content.references = [{id, citation}] (default shape: no sample was given). Dose-like text is a number
     followed by a dose unit (for example "5 mg"), found in any text value. This is a plain pattern, not a judgement: it only decides that a source must be listed. */
  const DOSE_LIKE = /(^|[^0-9A-Za-z])\d+(?:[.,]\d+)?\s*(?:mg|mcg|\u00b5g|ug|g|ml|units?|iu|mmol|meq)(?![A-Za-z])/i;
  const MAX_FINDINGS = 5;
  function needSource(node, path, depth, out) {
    if (out.length >= MAX_FINDINGS || depth > MAX_DEPTH) return;
    if (typeof node === 'string') { if (DOSE_LIKE.test(node)) out.push(path + ' (text that looks like a dose)'); return; }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n, i) => needSource(n, path + '[' + i + ']', depth + 1, out)); return; }
    Object.keys(node).forEach((k) => {
      const v = node[k], p = path + '.' + k;
      if (depth === 0 && k === 'rules' && Array.isArray(v) && v.length) out.push(p + ' (rules)');
      else if (k.toLowerCase() === 'bands' && v && typeof v === 'object' && Object.keys(v).length) out.push(p + ' (bands)');
      else needSource(v, p, depth + 1, out);
    });
  }
  /* 42a6. Strings that look like patient data. Plain patterns, not a judgement: a real value can slip past them and a harmless one can trip them,
     so a package is still reviewed by a person. The finding names the path and the kind, never the text itself. Citations in content.references may hold
     long numbers (DOI, ISBN, PubMed id), so only the e-mail, MRN and patient-name checks apply there. */
  const PATIENT_LIKE = [
    ['long_digits', /\d{7,}/, true],
    ['phone', /(\+\s?\d[\d\s().-]{6,}\d)|(\(\d{3}\)\s?\d)|(\b\d{3}[-. ]\d{3}[-. ]\d{4}\b)/, true],
    ['email', /[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}/, false],   // bounded on purpose: an unbounded pattern is quadratic on a 1 MB string with no @
    ['mrn', /\bMRN\b|medical\s+record\s+(number|no\b)/i, false],
    ['patient_name', /\bpatient(?:['\u2019]s)?[\s_-]*name\b/i, false],
  ];
  const MAX_PATIENT_FINDINGS = 50;
  function scanPatientLike(node, path, depth, lenient, out) {
    if (out.length >= MAX_PATIENT_FINDINGS || depth > MAX_DEPTH) return;
    if (typeof node === 'string') {
      const kinds = PATIENT_LIKE.filter((k) => (k[2] ? !lenient : true) && k[1].test(node)).map((k) => k[0]);
      if (kinds.length) out.push({ path, kinds });
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n, i) => scanPatientLike(n, path + '[' + i + ']', depth + 1, lenient, out)); return; }
    Object.keys(node).forEach((k) => scanPatientLike(node[k], path + '.' + k, depth + 1, lenient || (depth === 0 && ((path === 'content' && k === 'references') || (path === 'manifest' && k === 'contentHash'))), out));
  }
  /* 42a7. Warnings only (they never block an import). opts.verifiedCodes = the app's verified codes, as a list or Set of "system|code" strings or {system, code} objects
     (the same key as api.js uses for the verified_codes table). */
  function fieldList(c) {
    const out = [];
    (Array.isArray(c.sections) ? c.sections : []).forEach((s, si) => {
      (isObj(s) && Array.isArray(s.fields) ? s.fields : []).forEach((f, fi) => { if (isObj(f)) out.push({ f, path: 'content.sections[' + si + '].fields[' + fi + ']' }); });
    });
    (Array.isArray(c.fields) ? c.fields : []).forEach((f, fi) => { if (isObj(f)) out.push({ f, path: 'content.fields[' + fi + ']' }); });
    return out;
  }
  function codeOf(f) {   // a code a field carries: field.coding = {system, code} (the bound form), or field.fhir.code = {system, code}
    const a = isObj(f.coding) && typeof f.coding.system === 'string' && typeof f.coding.code === 'string' ? { at: '.coding', system: f.coding.system, code: f.coding.code } : null;
    const b = isObj(f.fhir) && isObj(f.fhir.code) && typeof f.fhir.code.system === 'string' && typeof f.fhir.code.code === 'string' ? { at: '.fhir.code', system: f.fhir.code.system, code: f.fhir.code.code } : null;
    return [a, b].filter(Boolean);
  }
  function verifiedKeys(list) {
    const keys = new Set();
    if (list && typeof list.forEach === 'function') list.forEach((x) => { if (typeof x === 'string') keys.add(x); else if (isObj(x) && typeof x.system === 'string' && typeof x.code === 'string') keys.add(x.system + '|' + x.code); });
    return keys;
  }
  const MAX_CONTENT_BYTES = 1048576;                 // 1 MB of canonical JSON
  const BANNED_KEYS = ['eval', 'function'];          // no key of this name anywhere in the content, at any depth, in any case
  const MAX_DEPTH = 64;
  /* 42a3b. Kinds each target app accepts (default mapping: set and pathway for the EMR, analytic for the Analytics app). */
  const KINDS_BY_TARGET = { emr: ['set', 'pathway'], analytics: ['analytic'] };
  /* A definition (kind analytic) holds slots, params and access only: no clinical list, threshold or free expression, at any depth, in any case. */
  const DEF_FORBIDDEN = ['threshold', 'thresholds', 'expression', 'query', 'lists', 'clinical_list'];
  function walkForbidden(node, path, depth, out) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) { node.forEach((n, i) => walkForbidden(n, path + '[' + i + ']', depth + 1, out)); return; }
    Object.keys(node).forEach((k) => {
      if (DEF_FORBIDDEN.indexOf(k.toLowerCase()) >= 0) out.push(path + '.' + k);
      walkForbidden(node[k], path + '.' + k, depth + 1, out);
    });
  }

  function walkKeys(node, path, depth, found) {
    if (!node || typeof node !== 'object') return;
    if (depth > MAX_DEPTH) { found.deep = path; return; }
    if (Array.isArray(node)) { node.forEach((n, i) => walkKeys(n, path + '[' + i + ']', depth + 1, found)); return; }
    Object.keys(node).forEach((k) => {
      if (BANNED_KEYS.indexOf(k.toLowerCase()) >= 0) found.keys.push(path + '.' + k);
      walkKeys(node[k], path + '.' + k, depth + 1, found);
    });
  }

  /* lintPackage(pkg, opts). opts.roles = the role list this app has locally (needed for the access check; without it that check cannot run and says so),
     opts.knownSetIds = optional list or Set of set ids a pathway's members must exist in, opts.views = the Views module (found by itself in Node and in the browser).
     The content is one set or pathway body. 42a3 checks: field types, size, banned keys, view blocks, access block. 42a4: rule operators and thresholds. */
  function lintPackage(pkg, opts) {
    opts = opts || {};
    const errors = [], warnings = [];
    const err = (code, path, message) => errors.push({ code, path, message });
    if (!isObj(pkg) || !isObj(pkg.manifest)) { err('bad_manifest', 'manifest', 'The package has no manifest object.'); return { errors, warnings }; }
    const m = pkg.manifest;
    if (typeof m.id !== 'string' || m.id === '') err('bad_manifest', 'manifest.id', 'The manifest has no id.');
    else if (!PACKAGE_ID.test(m.id)) err('bad_id', 'manifest.id', 'The id must be dotted lower-case words such as care.intake_output.');
    if (typeof m.version !== 'string' || m.version === '') err('bad_manifest', 'manifest.version', 'The manifest has no version.');
    else if (!SEMVER.test(m.version)) err('bad_semver', 'manifest.version', 'The version must look like 1.2.3.');
    if (m.targetApp !== 'emr' && m.targetApp !== 'analytics') err('bad_target_app', 'manifest.targetApp', 'The manifest must say targetApp "emr" or "analytics".');
    else if (typeof m.kind !== 'string' || KINDS_BY_TARGET[m.targetApp].indexOf(m.kind) < 0) err('kind_target_mismatch', 'manifest.kind', 'Kind "' + m.kind + '" does not belong to targetApp "' + m.targetApp + '". Allowed: ' + KINDS_BY_TARGET[m.targetApp].join(', ') + '.');

    const c = pkg.content;
    if (!isObj(c)) { err('bad_content', 'content', 'The package has no content object.'); return { errors, warnings }; }
    let text;
    try { text = canonicalJson(c); } catch (e) { err('content_not_json', 'content', 'The content holds a value JSON cannot store (' + e.message + ').'); return { errors, warnings }; }
    const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
    if (bytes > MAX_CONTENT_BYTES) { err('content_too_large', 'content', 'The content is larger than 1 MB.'); return { errors, warnings }; }
    const found = { keys: [], deep: null };
    walkKeys(c, 'content', 0, found);
    found.keys.forEach((p) => err('banned_key', p, 'A key named eval or function is not allowed anywhere in a package.'));
    if (found.deep) { err('too_deep', found.deep, 'The content is nested too deeply.'); return { errors, warnings }; }
    if (m.kind === 'analytic') {
      const bad = []; walkForbidden(c, 'content', 0, bad);
      bad.forEach((p) => err('forbidden_in_definition', p, 'A definition may not hold a clinical list, threshold or free expression.'));
      if (Array.isArray(c.rules) && c.rules.length) err('forbidden_in_definition', 'content.rules', 'A definition must have an empty rules list.');
    }

    (Array.isArray(c.sections) ? c.sections : []).forEach((s, si) => {
      (isObj(s) && Array.isArray(s.fields) ? s.fields : []).forEach((f, fi) => {
        if (isObj(f) && FIELD_TYPES.indexOf(f.type) < 0) err('unknown_field_type', 'content.sections[' + si + '].fields[' + fi + '].type', 'Field "' + f.id + '" has an unknown type "' + f.type + '".');
      });
    });

    if (c.rules !== undefined) {
      if (!Array.isArray(c.rules)) err('bad_rules', 'content.rules', 'rules must be a list.');
      else c.rules.forEach((r, i) => {
        const q = 'content.rules[' + i + ']';
        if (!isObj(r)) { err('bad_rules', q, 'A rule must be an object.'); return; }
        if (RULE_OPS.indexOf(r.op) < 0) err('bad_rule_op', q + '.op', 'Operator "' + r.op + '" is not allowed. Allowed: ' + RULE_OPS.join(' ') + '.');
        if (typeof r.threshold !== 'number' || !Number.isFinite(r.threshold)) err('bad_rule_threshold', q + '.threshold', 'The threshold must be a finite number.');
      });
    }

    const warn = (code, path, message) => warnings.push({ code, path, message });
    const fl = fieldList(c), seenIds = {}, vk = opts.verifiedCodes ? verifiedKeys(opts.verifiedCodes) : null;
    let noList = false;
    fl.forEach(({ f, path }) => {
      if (typeof f.id === 'string' && f.id) { if (seenIds[f.id]) warn('duplicate_field_id', path + '.id', 'Field id "' + f.id + '" is used more than once (first at ' + seenIds[f.id] + ').'); else seenIds[f.id] = path; }
      if (f.rationale !== undefined && (typeof f.rationale !== 'string' || !f.rationale.trim())) warn('empty_rationale', path + '.rationale', 'Field "' + f.id + '" has an empty rationale.');
      codeOf(f).forEach((k) => {
        if (!vk) { noList = true; return; }
        if (!vk.has(k.system + '|' + k.code)) warn('unverified_coding', path + k.at, 'Field "' + f.id + '" carries a code (' + k.system + ') that is not in the verified table.');
      });
    });
    if (noList) warn('no_verified_list', 'content', 'The app gave no list of verified codes, so the codes in this package could not be checked.');

    const pl = [];
    scanPatientLike(m, 'manifest', 0, false, pl);
    scanPatientLike(c, 'content', 0, false, pl);
    pl.forEach((x) => err('patient_like', x.path, 'This text looks like patient data (' + x.kinds.join(', ') + '). Packages never hold patient data.'));

    const refs = c.references;
    let refsOk = false;
    if (refs !== undefined) {
      if (!Array.isArray(refs)) err('bad_reference', 'content.references', 'references must be a list.');
      else {
        const seen = {};
        refs.forEach((x, i) => {
          const q = 'content.references[' + i + ']';
          if (!isObj(x) || typeof x.id !== 'string' || !x.id.trim() || typeof x.citation !== 'string' || !x.citation.trim()) { err('bad_reference', q, 'A reference needs an id and a citation, both text.'); return; }
          if (seen[x.id]) err('bad_reference', q + '.id', 'Reference id "' + x.id + '" is used twice.');
          seen[x.id] = true;
        });
        refsOk = refs.length > 0 && !errors.some((e) => e.code === 'bad_reference');
      }
    }
    if (!refsOk) {
      const rest = Object.assign({}, c); delete rest.references;
      const need = []; needSource(rest, 'content', 0, need);
      if (need.length && !errors.some((e) => e.code === 'bad_reference')) err('missing_references', 'content.references', 'Rules, bands and dose-like text need a references entry. Found: ' + need.join('; ') + '.');
    }

    if (m.targetApp === 'analytics') {
      warn('analytic_validator_pending', 'content', 'validateAnalytic (AA1) is not part of this app yet, so only the general checks ran on this definition.');
      return { errors, warnings };
    }
    const V = opts.views || (typeof require === 'function' ? require('./views.js') : root.Views);
    if (!V) { err('no_validator', 'content', 'The view validator (views.js) is not loaded, so views and access cannot be checked.'); return { errors, warnings }; }
    V.validateView(c).errors.forEach((x) => err('bad_view', 'content.view', x));
    V.validatePathwayViews(c, opts.knownSetIds).errors.forEach((x) => err('bad_pathway_view', 'content', x));
    if (!Array.isArray(opts.roles)) err('no_role_list', 'content.access', 'The app gave no role list, so the access block cannot be checked.');
    else V.validateAccess(c, opts.roles).errors.forEach((x) => err('bad_access', 'content.access', x));
    return { errors, warnings };
  }

  /* 42b1. A registry entry carries source ('seed', 'local' or 'marketplace'), readOnly, tier ('local-draft', 'local-reviewed' or 'marketplace-verified'),
     forkedFrom ({setId, version, contentHash} or null) and package ({id, version, contentHash} or null). Entries made before these fields existed get
     defaults: seed sets are source seed and read-only, user sets are source local and editable, and every old entry is tier local-draft. A value that is
     already there (even null) is never replaced. The entry passed in is never changed: a copy is returned only when a default was needed. */
  const REGISTRY_FIELDS = ['source', 'readOnly', 'tier', 'forkedFrom', 'package'];
  function registryDefaults(entry, isSeed) {
    if (!isObj(entry)) return entry;
    const d = { source: isSeed ? 'seed' : 'local', readOnly: !!isSeed, tier: 'local-draft', forkedFrom: null, package: null };
    const missing = REGISTRY_FIELDS.filter((k) => entry[k] === undefined);
    if (!missing.length) return entry;
    const out = Object.assign({}, entry);
    missing.forEach((k) => { out[k] = d[k]; });
    return out;
  }

  /* 42b2. The badge for a registry entry, from its tier. An unknown or missing tier is shown as a local draft, so nothing looks verified unless its tier says so exactly.
     "Marketplace-verified" means peer-reviewed and hash-pinned, not approved by any regulator. */
  const TIER_BADGES = {
    'marketplace-verified': { label: 'Marketplace-verified', title: 'Installed from the marketplace: peer-reviewed, hash-pinned and read-only. This is not regulatory approval.' },
    'local-reviewed': { label: 'Local-reviewed', title: 'Approved by a reviewer at this facility.' },
    'local-draft': { label: 'Local draft', title: 'Not reviewed.' },
  };
  function tierBadge(entry) {
    const t = isObj(entry) && typeof entry.tier === 'string' && Object.prototype.hasOwnProperty.call(TIER_BADGES, entry.tier) ? entry.tier : 'local-draft';
    return { key: t, label: TIER_BADGES[t].label, title: TIER_BADGES[t].title };
  }

  /* 42b7. Fork to a local copy. The copy is a new entry: setId local.<slug> (made unique against existingIds), version 1, source local, editable, tier local-draft,
     forkedFrom {setId, version, contentHash}. It is a deep copy, so the original is never touched. Copied rules arrive disabled (a draft is unapproved). */
  async function contentHashOf(entry) {   // SHA-256 of the canonical JSON of the entry without its registry fields; an installed package keeps the hash it was checked with
    if (!isObj(entry)) throw new TypeError('contentHashOf: entry must be an object');
    if (isObj(entry.package) && typeof entry.package.contentHash === 'string' && entry.package.contentHash) return entry.package.contentHash;
    const body = Object.assign({}, entry); REGISTRY_FIELDS.forEach((k) => { delete body[k]; });
    return sha256Hex(canonicalJson(body));
  }
  function forkEntry(entry, existingIds, contentHash) {
    if (!isObj(entry) || typeof entry.setId !== 'string' || !entry.setId) throw new TypeError('forkEntry: the entry needs a setId');
    if (typeof contentHash !== 'string' || !contentHash) throw new TypeError('forkEntry: a contentHash is needed');
    const taken = new Set(Array.from(existingIds || []));
    let slug = String(entry.title || entry.setId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'copy';
    if (!/^[a-z]/.test(slug)) slug = 's_' + slug;
    const base = 'local.' + slug; let id = base, n = 2;
    while (taken.has(id)) id = base + '_' + (n++);
    const out = JSON.parse(JSON.stringify(entry));
    out.setId = id; out.version = 1; out.title = String(entry.title || entry.setId) + ' (local copy)';
    out.source = 'local'; out.readOnly = false; out.tier = 'local-draft'; out.package = null;
    out.forkedFrom = { setId: entry.setId, version: +entry.version || 1, contentHash };
    if (Array.isArray(out.rules)) out.rules = out.rules.map((r) => (isObj(r) ? Object.assign({}, r, { enabled: false }) : r));
    return out;
  }

  /* 42c2. Can this package be installed here? Checks, in this order of reporting: lintPackage errors, targetApp "emr", a usable setId that is not already in the registry,
     and manifest.contentHash equal to SHA-256 of canonicalJson(content), recomputed here. On success returns the registry entry: the content (deep copy) with
     source marketplace, readOnly, tier marketplace-verified, forkedFrom null and package {id, version, contentHash}. The content cannot declare those fields itself
     (they are overwritten), and rules arrive disabled. A file is not signed: the hash only shows the content is the content the manifest names. */
  const SET_ID = /^[A-Za-z0-9_.-]{1,100}$/;
  async function prepareInstall(pkg, opts) {
    opts = opts || {};
    const lint = lintPackage(pkg, opts), problems = [];
    if (lint.errors.length) problems.push({ code: 'lint_errors', message: 'The package has ' + lint.errors.length + ' error' + (lint.errors.length === 1 ? '' : 's') + ' and cannot be installed.' });
    const m = isObj(pkg) && isObj(pkg.manifest) ? pkg.manifest : null, c = isObj(pkg) && isObj(pkg.content) ? pkg.content : null;
    if (!m || !c) return { ok: false, problems, lint, hash: null };
    if (m.targetApp !== 'emr') problems.push({ code: 'wrong_target_app', message: 'This package is not for the EMR (targetApp must be "emr").' });
    if (typeof c.setId !== 'string' || !SET_ID.test(c.setId)) problems.push({ code: 'bad_set_id', message: 'The content has no usable setId.' });
    else if (new Set(Array.from(opts.existingIds || [])).has(c.setId)) problems.push({ code: 'already_in_registry', message: 'A set with the id ' + c.setId + ' is already here. Nothing is replaced.' });
    let hash = null;
    if (typeof m.contentHash !== 'string' || !m.contentHash) problems.push({ code: 'no_hash', message: 'The manifest has no contentHash, so the content cannot be checked.' });
    else {
      try { hash = await sha256Hex(canonicalJson(c)); } catch (e) { hash = null; }
      if (hash === null || hash !== m.contentHash.toLowerCase()) problems.push({ code: 'hash_mismatch', message: 'The content does not match the hash in the manifest. It was changed or the hash is wrong.' });
    }
    if (problems.length) return { ok: false, problems, lint, hash };
    const entry = JSON.parse(JSON.stringify(c));
    Object.assign(entry, { source: 'marketplace', readOnly: true, tier: 'marketplace-verified', forkedFrom: null, package: { id: m.id, version: m.version, contentHash: hash } });
    if (Array.isArray(entry.rules)) entry.rules = entry.rules.map((r) => (isObj(r) ? Object.assign({}, r, { enabled: false }) : r));
    return { ok: true, entry, hash, lint, problems };
  }


  /* 43a2. validateDraft(draft, output, ctx): checks what an AI drafted for a "Request a feature" sentence, before the app shows or keeps it. output is 'set', 'pathway' or 'rule'.
     ctx = {requestText, knownSetIds (list or Set), fieldRefs (list or Set of "setId/fieldId"), ownerSetId (rules only)}. Returns {ok, errors:[{code, path, message}]}; never throws.
     Checks: ids exist; the rule operator is on the whitelist (RULE_OPS); the threshold is a finite number that appears as a number in the request sentence; no dose-like text; every code empty.
     A threshold written in words ("five") does not match: the sentence must carry the digits. It checks the shape of a draft, it is not a review. */
  function numbersIn(text) {
    const out = [];
    (String(text).match(/\d+(?:[.,]\d+)*/g) || []).forEach((t) => {
      [t.replace(/,/g, ''), t.replace(/,/g, '.')].forEach((s) => { const n = Number(s); if (Number.isFinite(n)) out.push(n); });
    });
    return out;
  }
  const CODE_KEYS = ['coding', 'code', 'codes', 'system'];
  function nonEmpty(v) {
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.some(nonEmpty);
    if (isObj(v)) return Object.keys(v).some((k) => nonEmpty(v[k]));
    return v !== null && v !== undefined && v !== false;
  }
  function draftScan(node, path, depth, out) {
    if (out.length >= 20 || depth > 32) return;
    if (typeof node === 'string') { if (DOSE_LIKE.test(node)) out.push({ code: 'dose_like', path, message: 'The draft has text that looks like a dose. Doses are never drafted.' }); return; }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n, i) => draftScan(n, path + '[' + i + ']', depth + 1, out)); return; }
    Object.keys(node).forEach((k) => {
      if (CODE_KEYS.indexOf(k.toLowerCase()) >= 0 && nonEmpty(node[k])) out.push({ code: 'code_not_empty', path: path + '.' + k, message: 'The draft carries a code. Drafts leave every code empty.' });
      else draftScan(node[k], path + '.' + k, depth + 1, out);
    });
  }
  function validateDraft(draft, output, ctx) {
    const errors = [];
    const err = (code, path, message) => errors.push({ code, path, message });
    try {
      const c = isObj(ctx) ? ctx : {};
      const sets = new Set(Array.from(c.knownSetIds || []));
      const refs = new Set(Array.from(c.fieldRefs || []));
      if (['set', 'pathway', 'rule'].indexOf(output) < 0) { err('bad_output', 'output', 'The kind of draft must be set, pathway or rule.'); return { ok: false, errors }; }
      if (!isObj(draft)) { err('bad_draft', 'draft', 'The draft is not an object.'); return { ok: false, errors }; }
      if (output === 'set') {
        if (!Array.isArray(draft.sections) || !draft.sections.length) err('no_sections', 'draft.sections', 'The draft form has no sections.');
        (Array.isArray(draft.sections) ? draft.sections : []).forEach((s, si) => {
          (isObj(s) && Array.isArray(s.fields) ? s.fields : []).forEach((f, fi) => {
            const p = 'draft.sections[' + si + '].fields[' + fi + ']';
            if (!isObj(f) || FIELD_TYPES.indexOf(f.type) < 0) err('unknown_field_type', p + '.type', 'A field has a type this app does not know.');
          });
        });
      } else if (output === 'pathway') {
        if (!Array.isArray(draft.setIds) || !draft.setIds.length) err('no_members', 'draft.setIds', 'The draft pathway lists no sets.');
        (Array.isArray(draft.setIds) ? draft.setIds : []).forEach((id, i) => { if (typeof id !== 'string' || !sets.has(id)) err('unknown_set_id', 'draft.setIds[' + i + ']', 'The draft names a set that is not in this app.'); });
      } else {
        if (typeof draft.fieldRef !== 'string' || !refs.has(draft.fieldRef)) err('unknown_field_ref', 'draft.fieldRef', 'The rule points to a field that is not in this app.');
        else if (c.ownerSetId && draft.fieldRef.split('/')[0] !== c.ownerSetId) err('field_not_in_owner', 'draft.fieldRef', 'The rule points to a field outside the set it is for.');
        if (RULE_OPS.indexOf(draft.op) < 0) err('bad_rule_op', 'draft.op', 'The operator is not allowed. Allowed: ' + RULE_OPS.join(' ') + '.');
        if (typeof draft.threshold !== 'number' || !Number.isFinite(draft.threshold)) err('bad_rule_threshold', 'draft.threshold', 'The threshold is not a number.');
        else if (numbersIn(c.requestText || '').indexOf(Math.abs(draft.threshold)) < 0) err('threshold_not_in_request', 'draft.threshold', 'The threshold does not appear in the request sentence. Thresholds are never invented.');
      }
      draftScan(draft, 'draft', 0, errors);
    } catch (e) { err('draft_check_failed', 'draft', 'The draft could not be checked.'); }
    return { ok: errors.length === 0, errors };
  }

  const api = { canonicalJson, sha256Hex, lintPackage, SEMVER, PACKAGE_ID, FIELD_TYPES, MAX_CONTENT_BYTES, RULE_OPS, validateDraft, DOSE_LIKE, PATIENT_LIKE, fieldList, KINDS_BY_TARGET, DEF_FORBIDDEN, registryDefaults, REGISTRY_FIELDS, tierBadge, TIER_BADGES, forkEntry, contentHashOf, prepareInstall, SET_ID };
  if (typeof module !== 'undefined') module.exports = api;
  else root.PackageLint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
