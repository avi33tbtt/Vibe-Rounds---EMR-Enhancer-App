// CCIS VALIDATOR, row ECO-B13a: layer 7 for a rule pack (RULE-PACK-DESIGN sections 8 and 10; ED-45). Prototype. Synthetic data only.
// Pure. Counts the declared test cases per rule and checks fixture names. It never runs a rule (that is B14's test) and never judges meaning.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const RULEPACK_CASE_RULES = [
  { ruleId: 'CCIS-V7-006', layer: 7, severity: 'error', summary: 'A rule lacks a required test case (fires, does-not-fire, not-evaluated).' },
  { ruleId: 'CCIS-V7-007', layer: 7, severity: 'error', summary: 'A rule that reads a parameter has no not-evaluated test that leaves a parameter disabled.' },
];

const CASES = ['fires', 'does-not-fire', 'not-evaluated'];

function paramsOf(e, into = new Set()) {
  if (!isObj(e)) return into;
  if (e.ref === 'parameter' && typeof e.id === 'string') into.add(e.id);
  arr(e.args).forEach((a) => paramsOf(a, into));
  return into;
}

export function rulePackCases(doc, ctx = {}) {
  const out = [];
  const fixtures = Array.isArray(ctx.fixtures) ? new Set(ctx.fixtures) : null;
  const tests = arr(doc.tests).filter(isObj);
  arr(doc.tests).forEach((t, i) => {
    if (!isObj(t) || typeof t.fixture !== 'string') return;
    if (fixtures === null) out.push(diag('warning', 'CCIS-V7-004', `/tests/${i}/fixture`, `The test "${t.id}" names the fixture case "${t.fixture}", but no fixture list was supplied, so the case name was not checked.`, 'Supply the fixture folder (for example with --fixtures) to check the case name.'));
    else if (!fixtures.has(t.fixture)) out.push(diag('error', 'CCIS-V7-005', `/tests/${i}/fixture`, `The test "${t.id}" names the fixture case "${t.fixture}", which is not in the supplied fixture list.`, 'Name a fixture case that exists, or add the case.'));
  });
  arr(doc.rules).forEach((rule, i) => {
    if (!isObj(rule)) return;
    const params = [...paramsOf(rule.when)];
    const mine = tests.filter((t) => t.rule === rule.id);
    const enablesAll = (t) => params.every((p) => arr(t.enables).some((e) => isObj(e) && e.parameter === p));
    for (const c of CASES) {
      const ok = mine.some((t) => t.expect === c && (c !== 'not-evaluated' || enablesAll(t)));
      if (!ok) out.push(diag('error', 'CCIS-V7-006', `/rules/${i}`, `The rule "${rule.id}" has no "${c}" test case${c === 'not-evaluated' && params.length > 0 ? ' that enables all its parameters' : ''}.`, 'Add a synthetic test with that expected result.'));
    }
    if (params.length > 0 && !mine.some((t) => t.expect === 'not-evaluated' && !enablesAll(t))) {
      out.push(diag('error', 'CCIS-V7-007', `/rules/${i}`, `The rule "${rule.id}" reads a parameter but has no "not-evaluated" test that leaves a parameter disabled.`, 'Add a test with expected result not-evaluated that does not enable every parameter.'));
    }
  });
  return out;
}
