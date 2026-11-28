// CCIS VALIDATOR, layers 1 to 3 (row 2.1): syntax, structural, reference integrity.
// Prototype. Synthetic data only. Not for clinical use.
//
// Pure library: takes text or a parsed document plus the artefacts it may resolve references against, and
// returns diagnostics. No file access, no network, no clock, no randomness. Only the CLI reads files.
//
//   validateArtefact(input, { known = [], schema } = {})
//     -> { outcome, layers, diagnostics }
//
// - `input` is JSON text (layer 1 parses it) or an already parsed document (layer 1 then checks only that it is an object).
// - `known` is a list of parsed artefacts. Layer 3 resolves references only against these, so a missing
//   artefact is reported, never assumed.
// - `schema` names a committed validator (for example "analytics") and replaces the choice made from the
//   artefact's own type. Used for schema fixtures that are not whole artefacts.
// - Layers 4 and 5 (row 2.2) live in ccis-validator-semantic.js. Layers 6 to 8 (row 2.3) live in ccis-validator-governance.js. A layer that did not run is
//   listed as `not-run` with a reason. Not run is never a pass.
// - `fixtures` is a list of fixture case names for layer 7. Without it, a test's case name is not checked (a warning).
// - A layer that fails (any error diagnostic) stops the later layers for that artefact (fail closed, CCIS-REQ-088).
//
// Diagnostics have the parts fixed in row 1.6 (CCIS-REQ-089): severity, ruleId, path, message, hint.
// `path` is a JSON pointer, except for layer 1 text errors, where it is { line, column }.
// Rule ids are stable: the catalogue grows by adding ids, never by changing one.

import {
  manifest as vManifest, element as vElement, terminologyBinding as vBinding, decisionNode as vNode,
  pathway as vPathway, analytics as vAnalytics, executionManifest as vExecution, contextEnvelope as vEnvelope,
  importReport as vReport, validationRecord as vRecord, runResult as vResult, runRecord as vRun, elementGroup as vElementGroup, terminologyPackage as vTerminology, rulePack as vRulePack,
} from './ccis/validators/ccis-validators.js';
import { semanticLayer, graphLayer, SEMANTIC_RULES } from './ccis-validator-semantic.js';
import { groupChecks, GROUP_RULES } from './ccis-validator-group.js';
import { entryFormChecks, ENTRYFORM_RULES } from './ccis-validator-entryform.js';
import { rulePackSemantic, RULEPACK_RULES } from './ccis-validator-rulepack.js';
import { rulePackChecks, RULEPACK_CHECK_RULES } from './ccis-validator-rulepack-checks.js';
import { rulePackShape, RULEPACK_SHAPE_RULES } from './ccis-validator-rulepack-shape.js';
import { rulePackCases, RULEPACK_CASE_RULES } from './ccis-validator-rulepack-cases.js';
import { rulePackGovernance, RULEPACK_GOVERNANCE_RULES } from './ccis-validator-rulepack-governance.js';
import { contextsChecks, CONTEXTS_RULES } from './ccis-validator-contexts.js';
import { ownerChecks, OWNER_RULES } from './ccis-validator-owner.js';
import { terminologyChecks, TERMINOLOGY_RULES } from './ccis-validator-terminology.js';
import { conceptChecks, CONCEPT_RULES } from './ccis-validator-concept.js';
import { conceptPackageChecks, PACKAGE_RULES } from './ccis-validator-concept-package.js';
import { conceptOwners, ownershipDiagnostics, OWNERSHIP_RULES } from './ccis-concept-owners.js';
import { executableSafetyLayer, testVerificationLayer, governanceLayer, GOVERNANCE_RULES } from './ccis-validator-governance.js';

export const LAYER_NAMES = [
  'syntax', 'structural', 'reference-integrity', 'semantic',
  'graph-and-compatibility', 'executable-safety', 'test-verification', 'governance',
];

export const RULES = [
  { ruleId: 'CCIS-V1-001', layer: 1, severity: 'error', summary: 'The text is not valid JSON (line and column of the break).' },
  { ruleId: 'CCIS-V1-002', layer: 1, severity: 'error', summary: 'The top level of the document is not a JSON object.' },
  { ruleId: 'CCIS-V2-001', layer: 2, severity: 'error', summary: 'A parameter carries a value, default or suggestion (D-022).' },
  { ruleId: 'CCIS-V2-002', layer: 2, severity: 'error', summary: 'Unknown member in a closed object.' },
  { ruleId: 'CCIS-V2-003', layer: 2, severity: 'error', summary: 'A required member is missing.' },
  { ruleId: 'CCIS-V2-004', layer: 2, severity: 'error', summary: 'Wrong type, value, pattern, size or shape.' },
  { ruleId: 'CCIS-V2-005', layer: 2, severity: 'error', summary: 'The kind of artefact cannot be identified, so no schema can be chosen.' },
  { ruleId: 'CCIS-V2-006', layer: 2, severity: 'warning', summary: 'This artefact type has no structural schema yet; only its manifest was checked.' },
  { ruleId: 'CCIS-V3-001', layer: 3, severity: 'error', summary: 'A field is named that the referenced element does not define.' },
  { ruleId: 'CCIS-V3-002', layer: 3, severity: 'error', summary: 'A field key is used more than once in an element.' },
  { ruleId: 'CCIS-V3-003', layer: 3, severity: 'error', summary: 'A relationship names a field key the element does not define.' },
  { ruleId: 'CCIS-V3-004', layer: 3, severity: 'error', summary: 'A referenced artefact is not among the known artefacts.' },
  { ruleId: 'CCIS-V3-005', layer: 3, severity: 'error', summary: 'A referenced artefact is known, but no known version satisfies the reference.' },
  ...SEMANTIC_RULES,
  ...GROUP_RULES,
  ...ENTRYFORM_RULES,
  ...CONTEXTS_RULES,
  ...RULEPACK_RULES,
  ...RULEPACK_CHECK_RULES,
  ...RULEPACK_SHAPE_RULES,
  ...RULEPACK_CASE_RULES,
  ...OWNER_RULES,
  ...TERMINOLOGY_RULES,
  ...CONCEPT_RULES,
  ...PACKAGE_RULES,
  ...OWNERSHIP_RULES,
  ...GOVERNANCE_RULES,
  ...RULEPACK_GOVERNANCE_RULES,
];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });
const hasError = (list) => list.some((d) => d.severity === 'error');

// ---------------------------------------------------------------------------------------------
// Semver: exact version, ^, ~, >=, >, <=, < (as the manifest schema allows), comparators joined by one space.
// Anything not understood does not satisfy: it is never guessed.
// ---------------------------------------------------------------------------------------------

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMPARATOR = /^([~^]|[<>]=?)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

export function parseSemver(text) {
  const m = typeof text === 'string' ? SEMVER.exec(text) : null;
  if (!m) return null;
  return { major: BigInt(m[1]), minor: BigInt(m[2]), patch: BigInt(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

const sign = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) continue;
    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);
    if (na && nb) return sign(BigInt(a[i]), BigInt(b[i]));
    if (na) return -1;
    if (nb) return 1;
    return sign(a[i], b[i]);
  }
  return sign(a.length, b.length);
}

// -1, 0 or 1; null when either side is not a semantic version. Build metadata is ignored.
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  return sign(x.major, y.major) || sign(x.minor, y.minor) || sign(x.patch, y.patch) || comparePre(x.pre, y.pre);
}

// A pre-release version never satisfies a range.
export function satisfiesRange(range, version) {
  const v = parseSemver(version);
  if (!v || v.pre.length > 0 || typeof range !== 'string') return false;
  for (const part of range.split(' ')) {
    const m = COMPARATOR.exec(part);
    if (!m) return false;
    const base = parseSemver(m[2]);
    const c = compareSemver(version, m[2]);
    let ok;
    switch (m[1]) {
      case undefined: ok = c === 0; break;
      case '>=': ok = c >= 0; break;
      case '>': ok = c > 0; break;
      case '<=': ok = c <= 0; break;
      case '<': ok = c < 0; break;
      case '~': ok = c >= 0 && compareSemver(version, `${base.major}.${base.minor + 1n}.0`) < 0; break;
      default: { // '^'
        const upper = base.major > 0n ? `${base.major + 1n}.0.0`
          : base.minor > 0n ? `0.${base.minor + 1n}.0` : `0.0.${base.patch + 1n}`;
        ok = c >= 0 && compareSemver(version, upper) < 0;
      }
    }
    if (!ok) return false;
  }
  return true;
}

// A reference holds an exact `version` or a `range`.
export function satisfiesReference(ref, version) {
  if (!isObj(ref)) return false;
  if (typeof ref.version === 'string') return compareSemver(ref.version, version) === 0;
  return satisfiesRange(ref.range, version);
}

// ---------------------------------------------------------------------------------------------
// Layer 1: syntax
// ---------------------------------------------------------------------------------------------

function lineColumn(text, index) {
  let line = 1;
  let start = 0;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') { line += 1; start = i + 1; }
  }
  return { line, column: index - start + 1 };
}

class Stop { constructor(index, eof, open, partial) { this.index = index; this.eof = eof; this.open = open; this.partial = partial; } }

// Finds where JSON text first breaks. Run only after the built-in parser has refused the text, so the
// location does not depend on the wording of an engine's error message.
function locate(text) {
  const n = text.length;
  const open = [];
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let i = 0;
  const stop = (partial = false) => { throw new Stop(i, i >= n, open.slice(), partial); };
  const skip = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i += 1; };
  const word = (w) => {
    for (let k = 0; k < w.length; k += 1) {
      if (i >= n) stop(true);
      if (text[i] !== w[k]) stop();
      i += 1;
    }
  };
  const string = () => {
    i += 1;
    for (;;) {
      if (i >= n) stop(true);
      const c = text[i];
      if (c === '"') { i += 1; return; }
      if (c < ' ') stop();
      if (c !== '\\') { i += 1; continue; }
      i += 1;
      if (i >= n) stop(true);
      const e = text[i];
      if (e === 'u') {
        for (let k = 1; k <= 4; k += 1) {
          if (i + k >= n) { i = n; stop(true); }
          if (!/[0-9a-fA-F]/.test(text[i + k])) { i += k; stop(); }
        }
        i += 5;
      } else if ('"\\/bfnrt'.includes(e)) i += 1;
      else stop();
    }
  };
  const container = (close, member) => {
    open.push(close === '}' ? '{' : '[');
    i += 1;
    skip();
    if (text[i] === close) { i += 1; open.pop(); return; }
    for (;;) {
      skip();
      member();
      skip();
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] === close) { i += 1; open.pop(); return; }
      stop();
    }
  };
  const value = () => {
    skip();
    const c = text[i];
    if (c === '{') {
      container('}', () => {
        if (text[i] !== '"') stop();
        string();
        skip();
        if (text[i] !== ':') stop();
        i += 1;
        value();
      });
    } else if (c === '[') container(']', value);
    else if (c === '"') string();
    else if (c === 't') word('true');
    else if (c === 'f') word('false');
    else if (c === 'n') word('null');
    else {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) stop();
      i += m[0].length;
    }
  };
  try {
    skip();
    value();
    skip();
    if (i < n) stop();
  } catch (e) {
    if (e instanceof Stop) return e;
    return null; // for example nesting too deep for the scanner: the caller falls back to the start
  }
  return null;
}

function syntaxDiagnostic(text) {
  const s = locate(text);
  if (s && s.eof && !s.partial && s.open.length === 1 && s.open[0] === '{') {
    return diag('error', 'CCIS-V1-001', lineColumn(text, s.index),
      'The file ends before the top-level object is closed, so it is not valid JSON.',
      'Add the missing closing brace. Nothing after the break was read.');
  }
  if (s && s.eof) {
    return diag('error', 'CCIS-V1-001', lineColumn(text, s.index),
      'The file ends in the middle of a JSON value, so it is not valid JSON.',
      'Complete the value and close every open brace and bracket. Nothing after the break was read.');
  }
  const at = lineColumn(text, s ? s.index : 0);
  return diag('error', 'CCIS-V1-001', at,
    `The text is not valid JSON at line ${at.line}, column ${at.column}.`,
    'Fix the text at that place. Nothing after the break was read.');
}

function layer1(input) {
  if (typeof input === 'string') {
    let doc;
    try { doc = JSON.parse(input); } catch { return { doc: null, diagnostics: [syntaxDiagnostic(input)] }; }
    if (!isObj(doc)) {
      const at = lineColumn(input, input.search(/\S/));
      return { doc: null, diagnostics: [diag('error', 'CCIS-V1-002', at,
        'The top level of the document is not a JSON object.',
        'Write the artefact as one JSON object. Nothing after the first value was read.')] };
    }
    return { doc, diagnostics: [] };
  }
  if (!isObj(input)) {
    return { doc: null, diagnostics: [diag('error', 'CCIS-V1-002', '',
      'The top level of the document is not a JSON object.',
      'Write the artefact as one JSON object.')] };
  }
  return { doc: input, diagnostics: [] };
}

// ---------------------------------------------------------------------------------------------
// Layer 2: structural (the committed schema validators; nothing is compiled here)
// ---------------------------------------------------------------------------------------------

const SCHEMAS = {
  manifest: vManifest, element: vElement, terminologyBinding: vBinding, decisionNode: vNode, pathway: vPathway,
  analytics: vAnalytics, executionManifest: vExecution, contextEnvelope: vEnvelope, importReport: vReport,
  validationRecord: vRecord, runResult: vResult, runRecord: vRun, elementGroup: vElementGroup, terminologyPackage: vTerminology, rulePack: vRulePack,
};

const TYPE_TO_SCHEMA = { 'contextual-element': 'element', 'element-group': 'elementGroup', pathway: 'pathway', 'analytics-package': 'analytics', 'terminology-package': 'terminologyPackage', 'rule-pack': 'rulePack' };
const TYPES_WITHOUT_SCHEMA = ['test-validation-package'];

// What the artefact is, from its own manifest type or its shape. Decision nodes and bindings have no manifest.
function identify(doc) {
  if (isObj(doc.manifest) && typeof doc.manifest.type === 'string') return doc.manifest.type;
  if (typeof doc.id === 'string' && Array.isArray(doc.outcomes)) return 'decision-node';
  if ('codeSystem' in doc && 'code' in doc) return 'terminology-binding';
  return null;
}

const PARAMETER_VALUE_MEMBERS = new Set([
  'value', 'default', 'defaultValue', 'suggestion', 'suggested', 'suggestedValue', 'recommended', 'recommendedValue',
]);

const list = (xs) => xs.map((x) => JSON.stringify(x)).join(', ');

// Keyword table for CCIS-V2-004. Anything not listed gets the general wording; no error is dropped.
function wrongValue(e) {
  const p = e.params ?? {};
  switch (e.keyword) {
    case 'type': return ['The value has the wrong type: it must be ' + (Array.isArray(p.type) ? p.type.join(' or ') : p.type) + '.', 'Use a value of that type.'];
    case 'enum': return ['The value is not one of the allowed values: ' + list(p.allowedValues ?? []) + '.', 'Use one of the allowed values.'];
    case 'const': return ['The value must be exactly ' + JSON.stringify(p.allowedValue) + '.', 'Use exactly that value.'];
    case 'pattern': return [`The text does not match the required form ${JSON.stringify(p.pattern)}.`, 'Write the value in the required form.'];
    case 'minimum': case 'maximum': case 'exclusiveMinimum': case 'exclusiveMaximum':
      return [`The number is outside the allowed range: it ${e.message}.`, 'Use a number inside the allowed range.'];
    case 'minItems': case 'maxItems': case 'minLength': case 'maxLength': case 'minProperties': case 'maxProperties': case 'uniqueItems':
      return [`The size or uniqueness rule is not met: it ${e.message}.`, 'Change the value so that the rule is met.'];
    default:
      return [`The value does not satisfy the schema rule "${e.keyword}": it ${e.message}.`, 'Change the value to satisfy the rule named in the message.'];
  }
}

function mapSchemaError(e, prefix, schemaName) {
  const at = prefix + e.instancePath;
  if (e.keyword === 'additionalProperties') {
    const m = e.params.additionalProperty;
    if (schemaName === 'analytics' && /^\/parameters\/\d+$/.test(e.instancePath) && PARAMETER_VALUE_MEMBERS.has(m)) {
      return diag('error', 'CCIS-V2-001', `${at}/${esc(m)}`,
        `A parameter declares a member "${m}". Parameters arrive disabled and carry no value in a package.`,
        'Remove the member. The value is supplied locally at run time by a named clinician.');
    }
    return diag('error', 'CCIS-V2-002', `${at}/${esc(m)}`,
      `The member "${m}" is not defined here.`,
      'Remove the member, or give it the prefix "x-" if it is a local extension.');
  }
  if (e.keyword === 'required') {
    const m = e.params.missingProperty;
    return diag('error', 'CCIS-V2-003', `${at}/${esc(m)}`,
      `The required member "${m}" is missing.`, `Add the member "${m}".`);
  }
  const [message, hint] = wrongValue(e);
  return diag('error', 'CCIS-V2-004', at, message, hint);
}

function check(validator, data, prefix, schemaName) {
  if (validator(data) === true) return [];
  return validator.errors.map((e) => mapSchemaError(e, prefix, schemaName));
}

function layer2(doc, override) {
  if (override !== undefined) {
    if (!Object.hasOwn(SCHEMAS, override)) throw new Error(`unknown schema name: ${override}`);
    return check(SCHEMAS[override], doc, '', override);
  }
  const kind = identify(doc);
  if (kind === null) {
    return [diag('error', 'CCIS-V2-005', '',
      'The kind of artefact cannot be identified: there is no manifest type, and the shape is not a decision node or a terminology binding.',
      'Add a manifest with a type, or write the artefact in one of the known shapes.')];
  }
  const name = TYPE_TO_SCHEMA[kind] ?? (kind === 'decision-node' ? 'decisionNode' : kind === 'terminology-binding' ? 'terminologyBinding' : null);
  if (name) return check(SCHEMAS[name], doc, '', name);
  // A manifest type with no schema yet (or a type the manifest schema itself will refuse).
  const out = check(vManifest, doc.manifest, '/manifest', 'manifest');
  if (TYPES_WITHOUT_SCHEMA.includes(kind)) {
    out.push(diag('warning', 'CCIS-V2-006', '/manifest/type',
      `No structural schema exists yet for the type "${kind}", so only the manifest was checked.`,
      'Treat the rest of this artefact as unchecked until its schema exists.'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layer 3: reference integrity, within the artefacts provided
// ---------------------------------------------------------------------------------------------

function indexKnown(known) {
  const byId = new Map();
  for (const d of known ?? []) {
    const m = isObj(d) ? d.manifest : null;
    if (!isObj(m) || typeof m.id !== 'string' || typeof m.type !== 'string' || typeof m.version !== 'string') continue;
    if (!byId.has(m.id)) byId.set(m.id, []);
    byId.get(m.id).push({ type: m.type, version: m.version, doc: d });
  }
  return byId;
}

function resolve(index, ref) {
  if (!isObj(ref) || typeof ref.id !== 'string') return { state: 'skip' };
  const candidates = (index.get(ref.id) ?? []).filter((c) => c.type === ref.type);
  if (candidates.length === 0) return { state: 'missing' };
  const ok = candidates.filter((c) => satisfiesReference(ref, c.version));
  if (ok.length === 0) return { state: 'no-version', versions: candidates.map((c) => c.version) };
  ok.sort((a, b) => compareSemver(b.version, a.version));
  return { state: 'ok', doc: ok[0].doc };
}

const arr = (x) => (Array.isArray(x) ? x : []);

// The specific references (context, elements, analytics) come before the manifest's list, so when an element is
// named by both, the artefact's own context entry decides which element version its fields are checked against.
function collectRefs(doc, kind) {
  const out = [];
  if (kind === 'analytics-package') arr(doc.context).forEach((c, i) => isObj(c) && out.push([`/context/${i}/ref`, c.ref]));
  if (kind === 'rule-pack') arr(doc.scope?.pathways).forEach((r, i) => out.push([`/scope/pathways/${i}`, r]));
  if (kind === 'element-group') arr(doc.members).forEach((m, i) => isObj(m) && out.push([`/members/${i}/element`, m.element]));
  if (kind === 'pathway') {
    arr(doc.elements).forEach((r, i) => out.push([`/elements/${i}`, r]));
    arr(doc.analytics).forEach((a, i) => isObj(a) && out.push([`/analytics/${i}/ref`, a.ref]));
  }
  if (isObj(doc.manifest)) arr(doc.manifest.references).forEach((r, i) => out.push([`/manifest/references/${i}`, r]));
  return out;
}

// Every field of an element, core and conditional modules, with where it sits.
function elementFields(doc) {
  const out = [];
  arr(doc.fields).forEach((f, i) => isObj(f) && out.push([`/fields/${i}`, f.key]));
  arr(doc.modules).forEach((m, mi) => isObj(m) && arr(m.fields).forEach((f, i) => isObj(f) && out.push([`/modules/${mi}/fields/${i}`, f.key])));
  return out;
}

function elementChecks(doc, out) {
  const seen = new Set();
  for (const [path, key] of elementFields(doc)) {
    if (typeof key !== 'string') continue;
    if (seen.has(key)) {
      out.push(diag('error', 'CCIS-V3-002', `${path}/key`,
        `The field key "${key}" is used more than once in this element.`, 'Give every field its own key.'));
    }
    seen.add(key);
  }
  arr(doc.relationships).forEach((r, i) => {
    if (!isObj(r)) return;
    for (const end of ['from', 'to']) {
      if (typeof r[end] === 'string' && !seen.has(r[end])) {
        out.push(diag('error', 'CCIS-V3-003', `/relationships/${i}/${end}`,
          `A relationship names the field "${r[end]}" (member "${end}"), which this element does not define.`,
          'Use a field key the element defines.'));
      }
    }
  });
}

function layer3(doc, knownIndex) {
  const out = [];
  const kind = identify(doc);
  if (kind === 'contextual-element') elementChecks(doc, out);

  const refs = collectRefs(doc, kind);
  for (const [path, ref] of refs) {
    const r = resolve(knownIndex, ref);
    if (r.state === 'missing') {
      out.push(diag('error', 'CCIS-V3-004', path,
        `The reference to "${ref.id}" (${ref.type}) is not among the known artefacts.`,
        'Supply the artefact to the validator, or correct the reference. Nothing is assumed about artefacts that were not given.'));
    } else if (r.state === 'no-version') {
      const asks = typeof ref.version === 'string' ? `version "${ref.version}"` : `range "${ref.range}"`;
      out.push(diag('error', 'CCIS-V3-005', path,
        `The reference to "${ref.id}" (${ref.type}) asks for ${asks}, but no known version satisfies it (known: ${r.versions.join(', ')}).`,
        'Supply a version that satisfies the reference, or correct the reference.'));
    }
  }

  // Which element a named element id means: this artefact's own reference first, otherwise the highest known version.
  const keysOf = new Map();
  const keySet = (d) => {
    if (!keysOf.has(d)) keysOf.set(d, new Set(elementFields(d).map(([, k]) => k)));
    return keysOf.get(d);
  };
  const reported = new Set();
  const elementFor = (id, path) => {
    const own = refs.filter(([, r]) => isObj(r) && r.id === id && r.type === 'contextual-element');
    if (own.length > 0) {
      for (const [, r] of own) {
        const x = resolve(knownIndex, r);
        if (x.state === 'ok') return x.doc;
      }
      return null; // already reported at the reference
    }
    const x = resolve(knownIndex, { id, type: 'contextual-element', range: '>=0.0.0' });
    if (x.state === 'ok') return x.doc;
    if (!reported.has(id)) {
      reported.add(id);
      out.push(diag('error', 'CCIS-V3-004', path,
        `The reference to "${id}" (contextual-element) is not among the known artefacts.`,
        'Supply the artefact to the validator, or correct the reference. Nothing is assumed about artefacts that were not given.'));
    }
    return null;
  };
  const inputs = (base, list) => arr(list).forEach((inp, i) => {
    if (!isObj(inp) || typeof inp.element !== 'string' || typeof inp.field !== 'string') return;
    const el = elementFor(inp.element, `${base}/${i}/element`);
    if (el && !keySet(el).has(inp.field)) {
      out.push(diag('error', 'CCIS-V3-001', `${base}/${i}/field`,
        `Input "${inp.key}" names field "${inp.field}", which element "${inp.element}" does not define.`,
        'Use a field key the element defines, or correct the element reference.'));
    }
  });

  if (kind === 'analytics-package') {
    inputs('/inputs', doc.inputs);
    arr(doc.context).forEach((c, i) => {
      if (!isObj(c) || !isObj(c.ref)) return;
      const r = resolve(knownIndex, c.ref);
      if (r.state !== 'ok') return;
      arr(c.fields).forEach((f, j) => {
        if (typeof f === 'string' && !keySet(r.doc).has(f)) {
          out.push(diag('error', 'CCIS-V3-001', `/context/${i}/fields/${j}`,
            `The context entry names field "${f}", which element "${c.ref.id}" does not define.`,
            'Use a field key the element defines, or correct the element reference.'));
        }
      });
    });
  } else if (kind === 'decision-node') {
    inputs('/inputs', doc.inputs);
  } else if (kind === 'pathway') {
    arr(doc.nodes).forEach((n, i) => isObj(n) && inputs(`/nodes/${i}/inputs`, n.inputs));
    // A stage's `needs` keys are checked against the pathway's elements, only when every one of them resolved.
    const resolved = arr(doc.elements).map((r) => resolve(knownIndex, r));
    if (resolved.length > 0 && resolved.every((r) => r.state === 'ok')) {
      const union = new Set(resolved.flatMap((r) => [...keySet(r.doc)]));
      arr(doc.stages).forEach((s, i) => isObj(s) && arr(s.needs).forEach((k, j) => {
        if (typeof k === 'string' && !union.has(k)) {
          out.push(diag('error', 'CCIS-V3-001', `/stages/${i}/needs/${j}`,
            `Stage "${s.id}" needs field "${k}", which none of the elements the pathway names defines.`,
            'Use a field key one of the pathway\'s elements defines, or correct the stage.'));
        }
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The pipeline (one function for authoring, ingestion and runtime preflight, CCIS-REQ-088)
// ---------------------------------------------------------------------------------------------

const segments = (p) => (typeof p === 'string' ? p.split('/') : []);
function comparePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  const x = segments(a);
  const y = segments(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    if (x[i] === y[i]) continue;
    if (/^\d+$/.test(x[i]) && /^\d+$/.test(y[i])) return Number(x[i]) - Number(y[i]);
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}
const ordered = (d) => d.slice().sort((a, b) => comparePath(a.path, b.path) || sign(a.ruleId, b.ruleId) || sign(a.message, b.message));

export function validateArtefact(input, options = {}) {
  const layers = {};
  // Layers 4 and 5 list diagnostics by rule id first, then path, so that the defects of one rule sit together
  // (the order of the row 1.6 expected files). Layers 1 to 3 order by path.
  const byRule = (d) => d.slice().sort((a, b) => sign(a.ruleId, b.ruleId) || comparePath(a.path, b.path) || sign(a.message, b.message));
  const mark = (name, diagnostics) => {
    const later = LAYER_NAMES.indexOf(name) >= 3;
    layers[name] = { outcome: hasError(diagnostics) ? 'failed' : 'passed', diagnostics: later ? byRule(diagnostics) : ordered(diagnostics) };
  };
  const skip = (name, reason) => { layers[name] = { outcome: 'not-run', reason, diagnostics: [] }; };

  const first = layer1(input);
  mark('syntax', first.diagnostics);
  if (layers.syntax.outcome === 'failed') {
    skip('structural', 'Layer 1 (syntax) found errors, so later layers do not run on this artefact.');
  } else {
    mark('structural', layer2(first.doc, options.schema));
  }
  if (layers.structural.outcome === 'not-run' || layers.structural.outcome === 'failed') {
    skip('reference-integrity', layers.structural.outcome === 'failed'
      ? 'Layer 2 (structural) found errors, so later layers do not run on this artefact.'
      : layers.structural.reason);
  } else {
    mark('reference-integrity', layer3(first.doc, indexKnown(options.known)));
  }
  const kind = identify(first.doc ?? {});
  const stopped = (which) => (layers[which].outcome === 'failed'
    ? `Layer ${LAYER_NAMES.indexOf(which) + 1} (${which}) found errors, so later layers do not run on this artefact.`
    : layers[which].reason);
  if (layers['reference-integrity'].outcome !== 'passed') {
    skip('semantic', stopped('reference-integrity'));
  } else {
    mark('semantic', kind === 'rule-pack' ? rulePackSemantic(first.doc) : semanticLayer(first.doc, kind));
  }
  if (layers.semantic.outcome !== 'passed') {
    skip('graph-and-compatibility', stopped('semantic'));
  } else {
    const index = indexKnown(options.known);
    const ctx = { resolve: (ref) => resolve(index, ref) };
    mark('graph-and-compatibility', [...graphLayer(first.doc, kind, ctx), ...(kind === 'element-group' ? groupChecks(first.doc, ctx) : []), ...(kind === 'pathway' ? entryFormChecks(first.doc, ctx) : []), ...(kind === 'pathway' ? contextsChecks(first.doc, ctx) : []), ...(kind === 'rule-pack' ? rulePackChecks(first.doc, ctx) : []), ...(kind === 'contextual-element' ? ownerChecks(first.doc, ctx) : []), ...(kind === 'contextual-element' ? conceptChecks(first.doc) : []), ...(kind === 'contextual-element' ? conceptPackageChecks(first.doc, ctx) : []), ...(kind === 'contextual-element' ? ownershipDiagnostics(first.doc, conceptOwners([...(options.known ?? []), first.doc]), options.strictOwnership === true) : []), ...(kind === 'terminology-package' ? terminologyChecks(first.doc) : [])]);
  }
  // Layers 6 to 8 (row 2.3). Each runs only if the one before passed (fail closed). `options.fixtures` is a list of fixture case names.
  const chain = [
    ['executable-safety', 'graph-and-compatibility', () => [...executableSafetyLayer(first.doc), ...(kind === 'rule-pack' ? rulePackShape(first.doc) : [])]],
    ['test-verification', 'executable-safety', () => [...testVerificationLayer(first.doc, kind, { fixtures: options.fixtures }), ...(kind === 'rule-pack' ? rulePackCases(first.doc, { fixtures: options.fixtures }) : [])]],
    ['governance', 'test-verification', () => [...governanceLayer(first.doc), ...(kind === 'rule-pack' ? rulePackGovernance(first.doc) : [])]],
  ];
  for (const [name, before, check] of chain) {
    if (layers[before].outcome !== 'passed') skip(name, stopped(before));
    else mark(name, check());
  }

  const diagnostics = LAYER_NAMES.flatMap((name) => layers[name].diagnostics);
  const outcome = hasError(diagnostics) ? 'failed' : 'no-errors-so-far';
  return { outcome, layers, diagnostics };
}

// ---------------------------------------------------------------------------------------------
// Plain-text rendering of the same data (CCIS-REQ-089)
// ---------------------------------------------------------------------------------------------

const where = (path) => (isObj(path) ? `line ${path.line}, column ${path.column}` : path === '' ? 'the top level' : path);

export function renderText(result, label = 'artefact') {
  const lines = [`${label}: ${result.outcome}`];
  LAYER_NAMES.forEach((name, i) => {
    const l = result.layers[name];
    lines.push(`  layer ${i + 1} ${name}: ${l.outcome}${l.outcome === 'not-run' ? ` (${l.reason})` : ''}`);
  });
  for (const d of result.diagnostics) {
    lines.push(`  ${d.severity} ${d.ruleId} at ${where(d.path)}: ${d.message}`, `    hint: ${d.hint}`);
  }
  return lines.join('\n');
}
