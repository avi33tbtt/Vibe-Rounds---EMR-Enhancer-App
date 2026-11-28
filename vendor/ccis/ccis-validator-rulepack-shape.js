// CCIS VALIDATOR, row ECO-B13: layer 6 shape check for a data-quality rule pack (RULE-PACK-DESIGN sections 2 and 8; ED-18, ED-44). Prototype. Synthetic data only.
// Pure. A comparison is allowed only as (a) field to field, (b) time-diff against a parameter, (c) state-of against a string literal.
// Form only: it cannot judge whether a condition is clinical. The reviewer does that (design section 9). Class clinical-prompt is not checked here.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const RULEPACK_SHAPE_RULES = [
  { ruleId: 'CCIS-V6-003', layer: 6, severity: 'error', summary: 'A data-quality rule compares a value in a shape that is not allowed (field to field, time difference against a parameter, or a state test).' },
];

const COMPARE = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const PICK = new Set(['select', 'min', 'max', 'coalesce']);
const isInputRead = (e) => isObj(e) && (e.ref === 'input' || (PICK.has(e.op) && arr(e.args).length > 0 && arr(e.args).every(isInputRead)));
const isParam = (e) => isObj(e) && e.ref === 'parameter';
const isOp = (e, op) => isObj(e) && e.op === op;
const isText = (e) => isObj(e) && typeof e.literal === 'string';
const either = (a, b, f, g) => (f(a) && g(b)) || (f(b) && g(a));
const allowed = (a, b) => (isInputRead(a) && isInputRead(b)) || either(a, b, (x) => isOp(x, 'time-diff'), isParam) || either(a, b, (x) => isOp(x, 'state-of'), isText);

function walk(e, path, out, ruleId) {
  if (!isObj(e) || !Array.isArray(e.args)) return;
  if (COMPARE.has(e.op) && e.args.length === 2 && !allowed(e.args[0], e.args[1])) {
    out.push(diag('error', 'CCIS-V6-003', path, `The comparison \"${e.op}\" in the rule \"${ruleId}\" is not an allowed data-quality shape.`, 'Compare two fields, a time difference against an interval parameter, or a state against a label. A single value against a parameter or constant is a clinical cut-off.'));
  }
  e.args.forEach((a, i) => walk(a, `${path}/args/${i}`, out, ruleId));
}

export function rulePackShape(doc) {
  const out = [];
  if (!isObj(doc) || doc.class !== 'data-quality') return out;
  arr(doc.rules).forEach((r, i) => { if (isObj(r)) walk(r.when, `/rules/${i}/when`, out, r.id); });
  return out;
}
