// CCIS VALIDATOR, row ECO-B12: layer 4 checks for a rule pack (design: RULE-PACK-DESIGN sections 4 and 8). Prototype. Synthetic data only.
// Pure. References, duplicates, argument counts and true-or-false shape only. No clinical judgement, no number.
import { ARITY } from './ccis-validator-semantic.js';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const RULEPACK_RULES = [
  { ruleId: 'CCIS-V4-012', layer: 4, severity: 'error', summary: 'A rule reads an input that the rule pack does not declare.' },
  { ruleId: 'CCIS-V4-013', layer: 4, severity: 'error', summary: 'A rule reads a parameter that the rule pack does not declare.' },
  { ruleId: 'CCIS-V4-014', layer: 4, severity: 'error', summary: 'A rule pack test names a rule that is not in the pack, or enables a parameter that is not declared.' },
  { ruleId: 'CCIS-V4-015', layer: 4, severity: 'error', summary: 'Two rules, tests, inputs or parameters of a rule pack share an id.' },
  { ruleId: 'CCIS-V4-016', layer: 4, severity: 'error', summary: 'A rule operator has the wrong number of arguments.' },
  { ruleId: 'CCIS-V4-017', layer: 4, severity: 'error', summary: 'A rule condition is not a true-or-false expression, or a logical operator has an argument that is not.' },
  { ruleId: 'CCIS-V4-018', layer: 4, severity: 'warning', summary: 'A rule pack declares an input or a parameter that no rule reads.' },
];

const BOOLEAN_OPS = new Set(['and', 'or', 'not', 'is-present', 'eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const LOGICAL = new Set(['and', 'or', 'not']);
const isBool = (e) => isObj(e) && (typeof e.literal === 'boolean' || BOOLEAN_OPS.has(e.op));

export function rulePackSemantic(doc) {
  const out = [];
  const inputs = new Set(arr(doc.inputs).filter(isObj).map((x) => x.id));
  const params = new Set(arr(doc.parameters).filter(isObj).map((x) => x.id));
  const used = new Set();
  const ruleIds = new Set(arr(doc.rules).filter(isObj).map((x) => x.id));

  for (const [list, label] of [['rules', 'rule'], ['tests', 'test'], ['inputs', 'input'], ['parameters', 'parameter']]) {
    const seen = new Set();
    arr(doc[list]).forEach((x, i) => {
      if (!isObj(x) || typeof x.id !== 'string') return;
      if (seen.has(x.id)) out.push(diag('error', 'CCIS-V4-015', `/${list}/${i}/id`, `The ${label} id "${x.id}" is used more than once.`, 'Give each one its own id.'));
      seen.add(x.id);
    });
  }

  const walk = (e, path) => {
    if (!isObj(e)) return;
    if (e.ref === 'input' || e.ref === 'parameter') {
      const isIn = e.ref === 'input';
      (isIn ? used : used).add(`${e.ref}:${e.id}`);
      if (!(isIn ? inputs : params).has(e.id)) {
        out.push(diag('error', isIn ? 'CCIS-V4-012' : 'CCIS-V4-013', `${path}/id`, `The rule reads the ${e.ref} "${e.id}", which is not declared.`, `Declare the ${e.ref}, or correct the id.`));
      }
      return;
    }
    if (typeof e.op !== 'string' || !Array.isArray(e.args)) return;
    const want = ARITY[e.op];
    if (want !== undefined && (typeof want === 'number' ? e.args.length !== want : e.args.length < want.min)) {
      out.push(diag('error', 'CCIS-V4-016', `${path}/args`, `The ${e.op} operator needs ${typeof want === 'number' ? `exactly ${want}` : `at least ${want.min}`} argument${(typeof want === 'number' ? want : want.min) === 1 ? '' : 's'}, but has ${e.args.length}.`, 'Give the operator the number of arguments it needs.'));
    }
    if (LOGICAL.has(e.op)) {
      e.args.forEach((a, j) => { if (isObj(a) && !isBool(a)) out.push(diag('error', 'CCIS-V4-017', `${path}/args/${j}`, `The ${e.op} operator needs true-or-false arguments.`, 'Use a comparison, a presence test or a true-or-false value here.')); });
    }
    e.args.forEach((a, j) => walk(a, `${path}/args/${j}`));
  };

  arr(doc.rules).forEach((r, i) => {
    if (!isObj(r)) return;
    if (isObj(r.when) && !isBool(r.when)) out.push(diag('error', 'CCIS-V4-017', `/rules/${i}/when`, 'The rule condition must be a true-or-false expression.', 'Start the condition with a comparison, a presence test or a logical operator.'));
    walk(r.when, `/rules/${i}/when`);
  });
  arr(doc.tests).forEach((t, i) => {
    if (!isObj(t)) return;
    if (typeof t.rule === 'string' && !ruleIds.has(t.rule)) out.push(diag('error', 'CCIS-V4-014', `/tests/${i}/rule`, `The test names the rule "${t.rule}", which is not in the pack.`, 'Correct the rule id.'));
    arr(t.enables).forEach((en, j) => { if (isObj(en) && !params.has(en.parameter)) out.push(diag('error', 'CCIS-V4-014', `/tests/${i}/enables/${j}/parameter`, `The test enables the parameter "${en.parameter}", which is not declared.`, 'Declare the parameter, or correct the id.')); });
  });
  arr(doc.inputs).forEach((x, i) => { if (isObj(x) && !used.has(`input:${x.id}`)) out.push(diag('warning', 'CCIS-V4-018', `/inputs/${i}`, `The input "${x.id}" is declared but no rule reads it.`, 'Remove it, or use it in a rule.')); });
  arr(doc.parameters).forEach((x, i) => { if (isObj(x) && !used.has(`parameter:${x.id}`)) out.push(diag('warning', 'CCIS-V4-018', `/parameters/${i}`, `The parameter "${x.id}" is declared but no rule reads it.`, 'Remove it, or use it in a rule.')); });
  return out;
}
