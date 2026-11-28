// CCIS VALIDATOR, layers 6 to 8 (row 2.3): executable safety, test verification, governance.
// Prototype. Synthetic data only. Not for clinical use.
//
// Pure library, imported by ccis-validator.js: no file access, no network, no clock, no randomness, no imports.
// Nothing here runs, compiles or executes anything: layer 6 reads text patterns, layer 7 compares what a package
// says about itself in two places, layer 8 compares claims. Whether a claim is true is never judged.
//
//   executableSafetyLayer(doc, kind)                -> diagnostics (layer 6)
//   testVerificationLayer(doc, kind, { fixtures })  -> diagnostics (layer 7); `fixtures` is a list of case names, or null
//   governanceLayer(doc, kind)                      -> diagnostics (layer 8)
//
// Layer 6 works by pattern. It can miss clever text and cannot judge intent. The executor's whitelist (rows 3.x) is the
// real barrier; this layer is the early refusal.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

export const GOVERNANCE_RULES = [
  { ruleId: 'CCIS-V6-001', layer: 6, severity: 'error', summary: 'An x- extension member holds text that looks like code.' },
  { ruleId: 'CCIS-V6-002', layer: 6, severity: 'error', summary: 'A string holds markup that can run in a page, or an x- member holds a network address.' },
  { ruleId: 'CCIS-V7-001', layer: 7, severity: 'error', summary: 'A test expects an output that the package does not declare.' },
  { ruleId: 'CCIS-V7-002', layer: 7, severity: 'error', summary: 'A test enables a parameter that the package does not declare.' },
  { ruleId: 'CCIS-V7-003', layer: 7, severity: 'error', summary: 'A test expects a state that its output does not declare.' },
  { ruleId: 'CCIS-V7-004', layer: 7, severity: 'warning', summary: 'A test names a fixture case, but no fixture list was supplied, so the case name was not checked.' },
  { ruleId: 'CCIS-V7-005', layer: 7, severity: 'error', summary: 'A test names a fixture case that is not in the supplied fixture list.' },
  { ruleId: 'CCIS-V8-001', layer: 8, severity: 'error', summary: 'A validated status is claimed while the evidence statement says no evidence is claimed or no review took place.' },
  { ruleId: 'CCIS-V8-002', layer: 8, severity: 'error', summary: 'The validation scope names a different version from the artefact\'s own version.' },
  { ruleId: 'CCIS-V8-003', layer: 8, severity: 'warning', summary: 'A validated status is claimed and the artefact has no evidence statement, so the claim was not checked.' },
];

// ---------------------------------------------------------------------------------------------
// Layer 6: executable safety
// ---------------------------------------------------------------------------------------------

// Written with a character class in the middle of some words so that this file itself holds no literal dynamic-code call.
const CODE_LIKE = [
  /\bfunction\s*[\w$]*\s*\(/,
  /=>/,
  /\bev[a]l\s*\(/,
  /\bnew\s+Fun[c]tion\b/,
  /\bimp[o]rt\s*\(/,
  /\brequ[i]re\s*\(/,
  /\|\s*(sh|bash|zsh)\b/,
  /`[^`]*`/,
  /\$\([^)]*\)/,
  /\)\s*;/,
];
const MARKUP = [/<\s*script/i, /javascript\s*:/i, /<[^>]*\bon[a-z]+\s*=/i];
const ADDRESS = /\bhttps?:\/\//i;

// Calls `visit(path, text, extensionName)` for every string; extensionName is the nearest enclosing x- key, or null.
function walkStrings(value, path, ext, visit) {
  if (typeof value === 'string') visit(path, value, ext);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}/${i}`, ext, visit));
  else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) walkStrings(v, `${path}/${esc(k)}`, ext ?? (k.startsWith('x-') ? k : null), visit);
  }
}

export function executableSafetyLayer(doc) {
  const out = [];
  walkStrings(doc, '', null, (path, text, ext) => {
    if (ext !== null && CODE_LIKE.some((re) => re.test(text))) {
      out.push(diag('error', 'CCIS-V6-001', path,
        `The extension member "${ext}" holds text that looks like code. Packages are declarative data only.`,
        'Remove the member. Behaviour belongs in the whitelisted expression tree.'));
    }
    if (MARKUP.some((re) => re.test(text))) {
      out.push(diag('error', 'CCIS-V6-002', path,
        'This text holds markup that can run in a page. Packages are declarative data only.',
        'Remove the markup. Write plain text; nothing in a package is ever run or shown as markup.'));
    } else if (ext !== null && ADDRESS.test(text)) {
      out.push(diag('error', 'CCIS-V6-002', path,
        `The extension member "${ext}" holds a network address. Packages make no network requests.`,
        'Remove the address, or describe the source in words in a citation.'));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layer 7: test verification (declared tests against the package's own declarations; nothing is run)
// ---------------------------------------------------------------------------------------------

export function testVerificationLayer(doc, kind, ctx = {}) {
  const out = [];
  if (kind !== 'analytics-package') return out;
  const fixtures = Array.isArray(ctx.fixtures) ? new Set(ctx.fixtures) : null;
  const outputs = new Map(arr(doc.outputs).filter(isObj).map((o) => [o.id, o]));
  const params = new Set(arr(doc.parameters).filter(isObj).map((p) => p.id));

  arr(doc.tests).forEach((t, i) => {
    if (!isObj(t)) return;
    const base = `/tests/${i}`;
    if (typeof t.fixture === 'string') {
      if (fixtures === null) {
        out.push(diag('warning', 'CCIS-V7-004', `${base}/fixture`,
          `The test "${t.id}" names the fixture case "${t.fixture}", but no fixture list was supplied, so the case name was not checked.`,
          'Supply the fixture folder (for example with --fixtures) to check the case name.'));
      } else if (!fixtures.has(t.fixture)) {
        out.push(diag('error', 'CCIS-V7-005', `${base}/fixture`,
          `The test "${t.id}" names the fixture case "${t.fixture}", which is not in the supplied fixture list.`,
          'Name a fixture case that exists, or add the case.'));
      }
    }
    arr(t.enables).forEach((e, j) => {
      if (isObj(e) && typeof e.parameter === 'string' && !params.has(e.parameter)) {
        out.push(diag('error', 'CCIS-V7-002', `${base}/enables/${j}/parameter`,
          `The test "${t.id}" enables the parameter "${e.parameter}", which the package does not declare.`,
          'Enable a parameter the package declares, or declare the parameter.'));
      }
    });
    arr(t.expect).forEach((x, j) => {
      if (!isObj(x) || typeof x.output !== 'string') return;
      const o = outputs.get(x.output);
      if (!o) {
        out.push(diag('error', 'CCIS-V7-001', `${base}/expect/${j}/output`,
          'The test expects an output that the package does not declare.',
          'Use an output id from the package\'s outputs, or add the output to the package.'));
        return;
      }
      if (typeof x.state === 'string' && !arr(o.states).includes(x.state)) {
        out.push(diag('error', 'CCIS-V7-003', `${base}/expect/${j}/state`,
          `The test "${t.id}" expects the state "${x.state}" from the output "${o.id}", which does not declare that state.`,
          'Expect a state the output declares, or add the state to the output.'));
      }
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layer 8: governance (claims against claims; never whether a claim is true)
// ---------------------------------------------------------------------------------------------

// Data, not code. Extended only by a new row.
const NO_EVIDENCE_PHRASES = [/no evidence is claimed/i, /none has been reviewed/i, /no review has taken place/i, /no evidence has been (?:reviewed|claimed)/i];
const BEYOND_DRAFT = new Set(['validated', 'conditionally-validated']);

export function governanceLayer(doc) {
  const out = [];
  const m = isObj(doc.manifest) ? doc.manifest : null;
  if (m === null) return out;

  if (isObj(m.validation) && typeof m.validation.version === 'string' && typeof m.version === 'string' && m.validation.version !== m.version) {
    out.push(diag('error', 'CCIS-V8-002', '/manifest/validation/version',
      'The validation scope names a different package version from the one claimed as validated.',
      'Validate this exact version and record its version in the scope, or return the status to draft.'));
  }

  if (BEYOND_DRAFT.has(m.status)) {
    const statement = isObj(doc.evidence) && typeof doc.evidence.statement === 'string' ? doc.evidence.statement : null;
    if (statement === null) {
      out.push(diag('warning', 'CCIS-V8-003', '/manifest/status',
        `Status "${m.status}" is claimed, but this artefact has no evidence statement, so the claim was not checked.`,
        'Record the evidence, or check the claim by hand. This validator does not judge whether a review took place.'));
    } else if (NO_EVIDENCE_PHRASES.some((re) => re.test(statement))) {
      out.push(diag('error', 'CCIS-V8-001', '/manifest/status',
        `Status "${m.status}" is claimed, but the evidence statement says no evidence is claimed and no review has taken place.`,
        'Return the status to draft, or record the validation with its version, population, setting and intended use.'));
    }
  }
  return out;
}
