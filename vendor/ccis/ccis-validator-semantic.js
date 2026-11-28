// CCIS VALIDATOR, layers 4 and 5 (row 2.2): semantic, and graph and compatibility.
// Prototype. Synthetic data only. Not for clinical use.
//
// Pure library, imported by ccis-validator.js: no file access, no network, no clock, no randomness.
//
//   semanticLayer(doc, kind)                  -> diagnostics (layer 4; analytics packages only in this row)
//   graphLayer(doc, kind, { resolve })        -> diagnostics (layer 5; pathways, decision nodes, compatibility)
//
// `kind` is what the 2.1 pipeline identified ("analytics-package", "pathway", "decision-node", ...).
// `resolve(ref)` is the pipeline's layer 3 resolver: { state: 'ok', doc } or another state. A rule that needs an
// artefact that was not supplied is skipped quietly: layer 3 already reported it. Unknown is never guessed.
//
// Element and binding checks (row 2.2b): a binding on a field that is not a code field, and unit strings that are not UCUM.
// UCUM is a small offline grammar check. What the grammar cannot decide is a warning that says "not checked", never a pass.
// Cycles are a warning only: "bounded" is not defined until gap G-09 (row 5.3).

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const SEMANTIC_RULES = [
  { ruleId: 'CCIS-V4-001', layer: 4, severity: 'error', summary: 'An operator argument has the wrong type.' },
  { ruleId: 'CCIS-V4-002', layer: 4, severity: 'error', summary: 'An operator has the wrong number of arguments.' },
  { ruleId: 'CCIS-V4-003', layer: 4, severity: 'error', summary: 'A reference or output id does not resolve (input, parameter, conversion, output).' },
  { ruleId: 'CCIS-V4-004', layer: 4, severity: 'error', summary: 'Units differ without an explicit declared conversion, or a convert does not match its conversion (REQ-042, 043).' },
  { ruleId: 'CCIS-V4-005', layer: 4, severity: 'error', summary: 'A computation can give a non-value state that its output does not declare.' },
  { ruleId: 'CCIS-V4-006', layer: 4, severity: 'error', summary: 'A time-zone conversion names a zone that is not a known time zone.' },
  { ruleId: 'CCIS-V4-007', layer: 4, severity: 'warning', summary: 'A declared input or parameter is never used by any computation.' },
  { ruleId: 'CCIS-V4-008', layer: 4, severity: 'warning', summary: 'An output declares a non-value state that its computation cannot give.' },
  { ruleId: 'CCIS-V4-009', layer: 4, severity: 'error', summary: 'A field carries a terminology binding but its type is not code.' },
  { ruleId: 'CCIS-V4-010', layer: 4, severity: 'error', summary: 'A unit string is clearly not a valid UCUM unit.' },
  { ruleId: 'CCIS-V4-011', layer: 4, severity: 'warning', summary: 'A unit string could not be decided offline (annotation or unit not in the small built-in table), so it was not checked.' },
  { ruleId: 'CCIS-V5-001', layer: 5, severity: 'error', summary: 'A transition, outcome or timing names a stage or node that does not exist.' },
  { ruleId: 'CCIS-V5-002', layer: 5, severity: 'error', summary: 'A stage cannot be reached from the first stage by any transition.' },
  { ruleId: 'CCIS-V5-003', layer: 5, severity: 'error', summary: 'An outcome tests an input that is not one of the node\'s inputs.' },
  { ruleId: 'CCIS-V5-004', layer: 5, severity: 'error', summary: 'A timing parameter is not declared by the analytics the pathway names.' },
  { ruleId: 'CCIS-V5-005', layer: 5, severity: 'error', summary: 'No outcome handles a state that the node\'s first input can be in.' },
  { ruleId: 'CCIS-V5-006', layer: 5, severity: 'error', summary: 'A stage that is not final has no transition out of it.' },
  { ruleId: 'CCIS-V5-007', layer: 5, severity: 'warning', summary: 'The transitions form a cycle; boundedness is not checked yet (gap G-09).' },
  { ruleId: 'CCIS-V5-008', layer: 5, severity: 'error', summary: 'The standard version or the operator set is one this validator does not support.' },
];

export const SUPPORTED_STANDARD_MAJORS = [0];
export const SUPPORTED_OPERATOR_SET = { name: 'ccis-core-ops', majors: [0] };

const NON_VALUE_STATES = new Set(['needs-data', 'indeterminate', 'not-applicable', 'conflict', 'parameter-not-enabled']);
// Arity: exact number, or a minimum written as { min }.
export const ARITY = {
  and: { min: 2 }, or: { min: 2 }, not: 1, 'is-present': 1, 'state-of': 1,
  eq: 2, ne: 2, lt: 2, le: 2, gt: 2, ge: 2, add: 2, sub: 2, 'time-diff': 2, convert: 2, if: 3,
  count: { min: 1 }, select: { min: 1 },
};
const TIMES = new Set(['datetime', 'date']);
const NUMBERS = new Set(['quantity', 'integer']);
const TEXT = new Set(['code', 'string', 'state']);
const LABEL = { datetime: 'date-time', date: 'date', quantity: 'quantity', integer: 'integer', boolean: 'boolean', code: 'code', string: 'text', state: 'state', set: 'set', criteria: 'criteria', conversion: 'conversion' };
const group = (t) => (TEXT.has(t) ? 'text' : TIMES.has(t) ? 'time' : NUMBERS.has(t) ? 'number' : t);

// ---------------------------------------------------------------------------------------------
// Layer 4: analytics
// ---------------------------------------------------------------------------------------------

function knownZone(name) {
  if (typeof name !== 'string') return false;
  if (name === 'UTC') return true;
  try { new Intl.DateTimeFormat('en', { timeZone: name }); return true; } catch { return false; }
}

// The expression's result states, found by walking only the result positions of `if`.
function resultLiterals(e, path, out = []) {
  if (!isObj(e)) return out;
  if (typeof e.literal === 'string') { if (NON_VALUE_STATES.has(e.literal)) out.push([path, e.literal]); } else if (e.op === 'if' && Array.isArray(e.args)) {
    resultLiterals(e.args[1], `${path}/args/1`, out);
    resultLiterals(e.args[2], `${path}/args/2`, out);
  }
  return out;
}


// ---------------------------------------------------------------------------------------------
// Layer 4: elements (row 2.2b): bindings and UCUM unit strings
// ---------------------------------------------------------------------------------------------

// Small built-in table (data, not a download). true = a metric unit that takes a prefix; false = it does not.
const UCUM_UNITS = new Map([
  ['m', true], ['g', true], ['s', true], ['L', true], ['l', true], ['mol', true], ['eq', true], ['U', true],
  ['Pa', true], ['Hz', true], ['J', true], ['W', true], ['N', true],
  ['min', false], ['h', false], ['d', false], ['wk', false], ['mo', false], ['a', false], ['%', false],
]);
const UCUM_PREFIXES = ['da', 'Y', 'Z', 'E', 'P', 'T', 'G', 'M', 'k', 'h', 'd', 'c', 'm', 'u', 'n', 'p', 'f', 'a', 'z', 'y'];

// One unit atom (a symbol with an optional exponent). Returns { s: 'ok' | 'unknown' | 'error', why }.
function ucumAtom(atom) {
  if (/^\d+$/.test(atom)) return { s: 'ok' };
  if (/^10[*^]-?\d+$/.test(atom)) return { s: 'ok' };
  if (!/^[A-Za-z0-9_%[\]*^+\-']+$/.test(atom)) return { s: 'error', why: `"${atom}" has a character that UCUM does not allow` };
  const m = /^(.*?[^\d+-])([+-]?\d+)?$/.exec(atom);
  const base = m ? m[1] : atom;
  if (UCUM_UNITS.has(base)) return { s: 'ok' };
  for (const p of UCUM_PREFIXES) {
    if (base.startsWith(p) && base.length > p.length && UCUM_UNITS.has(base.slice(p.length))) {
      return UCUM_UNITS.get(base.slice(p.length)) ? { s: 'ok' } : { s: 'error', why: `the prefix "${p}" cannot go with the unit "${base.slice(p.length)}"` };
    }
  }
  return { s: 'unknown', why: `the unit "${base}" is not in the built-in table` };
}

// The whole string. Structure errors are found first; an unknown atom or an annotation gives 'unknown', never 'ok'.
function checkUcum(unit) {
  if (typeof unit !== 'string') return { s: 'unknown', why: 'it is not text' };
  if (unit === '') return { s: 'error', why: 'it is empty' };
  let annotated = false;
  let open = false;
  let flat = '';
  for (const ch of unit) {
    if (ch === '{') { if (open) return { s: 'error', why: 'braces are nested' }; open = true; annotated = true; flat += '1'; } else if (ch === '}') { if (!open) return { s: 'error', why: 'a closing brace has no opening brace' }; open = false; } else if (!open) flat += ch;
  }
  if (open) return { s: 'error', why: 'a brace is not closed' };
  if (/\s/.test(flat)) return { s: 'error', why: 'it has a space (UCUM has none)' };
  let at = 0;
  let worst = annotated ? { s: 'unknown', why: 'it has a brace annotation' } : { s: 'ok' };
  const fail = (why) => ({ s: 'error', why });
  const atoms = [];
  let bad = null;
  const factor = () => {
    if (flat[at] === '(') {
      at += 1;
      const r = term(false);
      if (r) return r;
      if (flat[at] !== ')') return fail('a bracket is not closed');
      at += 1;
      return null;
    }
    let j = at;
    while (j < flat.length && !'./()'.includes(flat[j])) j += 1;
    if (j === at) return fail('an operator has nothing on one side');
    atoms.push(flat.slice(at, j));
    at = j;
    return null;
  };
  const term = (top) => {
    if (flat[at] === '/' && top) at += 1; // a single leading slash is allowed
    let r = factor();
    if (r) return r;
    while (at < flat.length && (flat[at] === '.' || flat[at] === '/')) {
      at += 1;
      r = factor();
      if (r) return r;
    }
    return null;
  };
  bad = term(true);
  if (bad) return bad;
  if (at < flat.length) return fail(flat[at] === ')' ? 'a closing bracket has no opening bracket' : 'it cannot be read');
  for (const a of atoms) {
    const r = ucumAtom(a);
    if (r.s === 'error') return r;
    if (r.s === 'unknown' && worst.s === 'ok') worst = r;
  }
  return worst;
}

function unitDiag(out, unit, path, what) {
  const r = checkUcum(unit);
  if (r.s === 'error') {
    out.push(diag('error', 'CCIS-V4-010', path, `The unit "${unit}" of ${what} is not a valid UCUM unit: ${r.why}.`, 'Write the unit as a UCUM string. A count with no unit is "1".'));
  } else if (r.s === 'unknown') {
    out.push(diag('warning', 'CCIS-V4-011', path, `The unit "${unit}" of ${what} was not checked: ${r.why}.`, 'Check the unit by hand against UCUM. This validator checks only a small built-in set offline.'));
  }
}

function fieldChecks(f, base, out) {
  if (!isObj(f)) return;
  if (f.binding !== undefined && f.type !== 'code') {
    out.push(diag('error', 'CCIS-V4-009', `${base}/binding`,
      `The field "${f.key}" has a terminology binding, but its type is ${LABEL[f.type] ?? String(f.type)}, not code.`,
      'Remove the binding, or make the field a code field. A binding names a code, so it fits only a code field.'));
  }
  arr(f.units).forEach((u, j) => unitDiag(out, u, `${base}/units/${j}`, `the field "${f.key}"`));
}

function elementChecks(doc, out) {
  arr(doc.fields).forEach((f, i) => fieldChecks(f, `/fields/${i}`, out));
  arr(doc.modules).forEach((m, k) => isObj(m) && arr(m.fields).forEach((f, i) => fieldChecks(f, `/modules/${k}/fields/${i}`, out)));
}

function analyticsUnitChecks(doc, out) {
  arr(doc.inputs).forEach((x, i) => isObj(x) && arr(x.units).forEach((u, j) => unitDiag(out, u, `/inputs/${i}/units/${j}`, `the input "${x.key}"`)));
  arr(doc.parameters).forEach((x, i) => isObj(x) && arr(x.units).forEach((u, j) => unitDiag(out, u, `/parameters/${i}/units/${j}`, `the parameter "${x.id}"`)));
  arr(doc.outputs).forEach((x, i) => { if (isObj(x) && x.unit !== undefined) unitDiag(out, x.unit, `/outputs/${i}/unit`, `the output "${x.id}"`); });
  arr(doc.conversions).forEach((c, i) => {
    if (!isObj(c) || c.kind === 'time-zone') return;
    for (const end of ['from', 'to']) if (c[end] !== undefined) unitDiag(out, c[end], `/conversions/${i}/${end}`, `the conversion "${c.id}"`);
  });
}

export function semanticLayer(doc, kind) {
  const out = [];
  if (kind === 'contextual-element') { elementChecks(doc, out); return out; }
  if (kind !== 'analytics-package') return out;
  analyticsUnitChecks(doc, out);

  const inputs = new Map();
  arr(doc.inputs).forEach((x, i) => isObj(x) && typeof x.key === 'string' && inputs.set(x.key, { ...x, at: i }));
  const params = new Map();
  arr(doc.parameters).forEach((x, i) => isObj(x) && typeof x.id === 'string' && params.set(x.id, { ...x, at: i }));
  const convs = new Map();
  arr(doc.conversions).forEach((x, i) => isObj(x) && typeof x.id === 'string' && convs.set(x.id, { ...x, at: i }));
  const outputs = new Map();
  arr(doc.outputs).forEach((x, i) => isObj(x) && typeof x.id === 'string' && outputs.set(x.id, { ...x, at: i }));
  const usedInputs = new Set();
  const usedParams = new Set();

  // Time zones named by declared conversions.
  arr(doc.conversions).forEach((c, i) => {
    if (!isObj(c) || c.kind !== 'time-zone') return;
    for (const end of ['from', 'to']) {
      if (typeof c[end] === 'string' && !knownZone(c[end])) {
        out.push(diag('error', 'CCIS-V4-006', `/conversions/${i}/${end}`,
          `The conversion "${c.id}" names the time zone "${c[end]}", which is not a known time zone.`,
          'Use a zone name from the IANA time zone database, such as "UTC".'));
      }
    }
  });

  const text = (t, units) => ({ t, units: units ?? null });
  const describe = (e, ty) => {
    if (isObj(e) && e.ref === 'input') return `"${e.id}" is ${/^[aeiou]/.test(LABEL[ty.t]) ? 'an' : 'a'} ${LABEL[ty.t]} input`;
    if (isObj(e) && e.ref === 'parameter') return `"${e.id}" is ${/^[aeiou]/.test(LABEL[ty.t]) ? 'an' : 'a'} ${LABEL[ty.t]} parameter`;
    return `this argument is ${/^[aeiou]/.test(LABEL[ty.t]) ? 'an' : 'a'} ${LABEL[ty.t]}`;
  };
  const argPath = (e, p) => (isObj(e) && typeof e.ref === 'string' ? `${p}/id` : p);

  // Walks one expression. Returns { t, units }: t is null when it cannot be decided (never guessed).
  function walk(e, path) {
    if (!isObj(e)) return text(null);
    if (typeof e.ref === 'string') {
      if (e.ref === 'input') {
        const x = inputs.get(e.id);
        if (!x) {
          out.push(diag('error', 'CCIS-V4-003', `${path}/id`, `The computation reads the input "${e.id}", which is not declared.`, 'Declare the input, or correct the id.'));
          return text(null);
        }
        usedInputs.add(e.id);
        return text(x.type, x.units);
      }
      if (e.ref === 'parameter') {
        const x = params.get(e.id);
        if (!x) {
          out.push(diag('error', 'CCIS-V4-003', `${path}/id`, `The computation reads the parameter "${e.id}", which is not declared.`, 'Declare the parameter, or correct the id.'));
          return text(null);
        }
        usedParams.add(e.id);
        if (x.kind === 'duration') return text('quantity', x.units);
        return text(x.kind === 'choice' ? 'string' : x.kind);
      }
      const x = convs.get(e.id); // ref: conversion
      if (!x) {
        out.push(diag('error', 'CCIS-V4-003', `${path}/id`, `The computation names the conversion "${e.id}", which is not declared.`, 'Declare the conversion in "conversions", or correct the id.'));
        return text(null);
      }
      return { t: 'conversion', units: null, conv: x };
    }
    if (typeof e.literal === 'boolean') return text('boolean');
    if (typeof e.literal === 'string') return text(NON_VALUE_STATES.has(e.literal) ? 'state' : 'string');
    if (typeof e.op !== 'string' || !Array.isArray(e.args)) return text(null);

    const want = ARITY[e.op];
    const n = e.args.length;
    if (want !== undefined) {
      const bad = typeof want === 'number' ? n !== want : n < want.min;
      if (bad) {
        out.push(diag('error', 'CCIS-V4-002', `${path}/args`,
          `The ${e.op} operator needs ${typeof want === 'number' ? `exactly ${want}` : `at least ${want.min}`} argument${(typeof want === 'number' ? want : want.min) === 1 ? '' : 's'}, but has ${n}.`,
          'Give the operator the number of arguments it needs.'));
      }
    }
    const a = e.args.map((x, j) => walk(x, `${path}/args/${j}`));
    const wrong = (j, expectText, hint) => out.push(diag('error', 'CCIS-V4-001', argPath(e.args[j], `${path}/args/${j}`),
      `The ${e.op} operator needs ${expectText}, but ${describe(e.args[j], a[j])}.`, hint));
    const unitsOf = (ty) => (ty.units && ty.units.length === 1 ? ty.units[0] : null);
    const needSameUnit = (j, k) => {
      if (!NUMBERS.has(a[j].t) || !NUMBERS.has(a[k].t) || !a[j].units || !a[k].units) return;
      const same = a[j].units.length === 1 && a[k].units.length === 1 && a[j].units[0] === a[k].units[0];
      if (!same) {
        out.push(diag('error', 'CCIS-V4-004', argPath(e.args[k], `${path}/args/${k}`),
          `The ${e.op} operator compares or combines values in different or undecided units (${a[j].units.join(' or ')} and ${a[k].units.join(' or ')}).`,
          'Use the convert operator with a declared conversion so that both sides are in the same single unit. Nothing is converted implicitly.'));
      }
    };

    switch (e.op) {
      case 'and': case 'or': case 'not':
        a.forEach((ty, j) => { if (ty.t !== null && ty.t !== 'boolean') wrong(j, 'true or false arguments', 'Use a comparison, a presence test or a true-or-false value here.'); });
        return text('boolean');
      case 'is-present':
        return text('boolean');
      case 'state-of':
        if (n === 1 && !(isObj(e.args[0]) && e.args[0].ref === 'input')) wrong(0, 'an input as its argument', 'Name a declared input here.');
        return text('state');
      case 'eq': case 'ne':
        if (n === 2 && a[0].t !== null && a[1].t !== null) {
          if (group(a[0].t) !== group(a[1].t)) wrong(1, `an argument of the same kind as the first (${LABEL[a[0].t]})`, 'Compare values of the same kind.');
          else needSameUnit(0, 1);
        }
        return text('boolean');
      case 'lt': case 'le': case 'gt': case 'ge':
        if (n === 2) {
          for (let j = 0; j < 2; j += 1) {
            if (a[j].t !== null && !NUMBERS.has(a[j].t) && !TIMES.has(a[j].t)) { wrong(j, 'two numbers or two times that can be put in order', 'Use a quantity, a whole number, a date or a date-time here.'); return text('boolean'); }
          }
          if (a[0].t !== null && a[1].t !== null) {
            if (group(a[0].t) !== group(a[1].t)) wrong(1, `an argument of the same kind as the first (${LABEL[a[0].t]})`, 'Compare values of the same kind.');
            else needSameUnit(0, 1);
          }
        }
        return text('boolean');
      case 'add': case 'sub':
        for (let j = 0; j < n; j += 1) {
          if (a[j].t !== null && !NUMBERS.has(a[j].t)) { wrong(j, 'two quantities or whole numbers', 'Use a quantity or a whole number here.'); return text(null); }
        }
        if (n === 2) needSameUnit(0, 1);
        return n === 2 && a[0].units && a[1].units && a[0].units.length === 1 && a[0].units[0] === unitsOf(a[1]) ? text(a[0].t, a[0].units) : text(null);
      case 'time-diff':
        for (let j = 0; j < n; j += 1) {
          if (a[j].t !== null && !TIMES.has(a[j].t)) wrong(j, 'two date-time arguments', 'Use a date-time input here, or remove the time-diff.');
        }
        return text('quantity', ['min']);
      case 'convert': {
        if (n !== 2) return text(null);
        const c = a[1];
        if (c.t !== null && c.t !== 'conversion') { wrong(1, 'a declared conversion as its second argument', 'Name a conversion declared in "conversions".'); return text(null); }
        if (c.t !== 'conversion') return text(null);
        const conv = c.conv;
        if (conv.kind === 'time-zone') {
          if (a[0].t !== null && !TIMES.has(a[0].t)) wrong(0, 'a date-time to convert between time zones', 'Use a date-time input here.');
          return text('datetime');
        }
        if (a[0].t !== null && !NUMBERS.has(a[0].t)) { wrong(0, 'a quantity to convert', 'Use a quantity here.'); return text(null); }
        if (a[0].units && !a[0].units.includes(conv.from) && !a[0].units.includes(conv.to)) {
          out.push(diag('error', 'CCIS-V4-004', argPath(e.args[1], `${path}/args/1`),
            `The conversion "${conv.id}" goes from ${conv.from} to ${conv.to}, but the value is in ${a[0].units.join(' or ')}.`,
            'Name a conversion whose "from" unit is one of the value\'s units.'));
        }
        return text('quantity', [conv.to]);
      }
      case 'if': {
        if (n === 3) {
          if (a[0].t !== null && a[0].t !== 'boolean') wrong(0, 'a true-or-false condition as its first argument', 'Use a comparison, a presence test or a true-or-false value here.');
          const [, x, y] = a;
          if (x.t === 'state') return y;
          if (y.t === 'state') return x;
          if (x.t === y.t) return text(x.t, x.units && y.units && x.units.join() === y.units.join() ? x.units : null);
        }
        return text(null);
      }
      case 'count': return text('integer', ['1']);
      case 'select': return text(null); // a table select, or a membership test: not decided here
      default: return text(null);
    }
  }

  const computed = new Set();
  arr(doc.computation).forEach((c, i) => {
    if (!isObj(c)) return;
    walk(c.expr, `/computation/${i}/expr`);
    const o = outputs.get(c.output);
    if (!o) {
      out.push(diag('error', 'CCIS-V4-003', `/computation/${i}/output`,
        `The computation is for the output "${c.output}", which is not declared in "outputs".`, 'Declare the output, or correct the id.'));
      return;
    }
    computed.add(c.output);
    const declared = new Set(arr(o.states));
    // A classification label may share its name with a state (for example "indeterminate"); a declared label is a label.
    const labels = new Set(arr(o.labels));
    const results = resultLiterals(c.expr, `/computation/${i}/expr`).filter(([, s]) => !labels.has(s));
    for (const [p, s] of results) {
      if (!declared.has(s)) {
        out.push(diag('error', 'CCIS-V4-005', p,
          `The computation for "${c.output}" can give the state "${s}", but the output does not declare it.`,
          'Add the state to the output\'s "states", or remove it from the computation.'));
      }
    }
    // Which states can this output reach: a result literal, or the onMissing state of an input the computation reads.
    const reach = new Set(results.map(([, s]) => s));
    const reads = (e) => {
      if (!isObj(e)) return;
      if (e.ref === 'input' && inputs.has(e.id)) reach.add(inputs.get(e.id).onMissing);
      arr(e.args).forEach(reads);
    };
    reads(c.expr);
    arr(o.states).forEach((s, k) => {
      if (!reach.has(s)) {
        out.push(diag('warning', 'CCIS-V4-008', `/outputs/${o.at}/states/${k}`,
          `The output "${o.id}" declares the state "${s}", but its computation cannot give it.`,
          'Remove the state, or change the computation so that it can occur.'));
      }
    });
  });
  for (const [id, o] of outputs) {
    if (!computed.has(id)) {
      out.push(diag('error', 'CCIS-V4-003', `/outputs/${o.at}/id`,
        `The output "${id}" has no computation.`, 'Add a computation for the output, or remove the output.'));
    }
  }

  // Declared but never used. A `criteria` parameter is exempt: its use is outside the expression tree (documented).
  for (const [key, x] of inputs) {
    if (!usedInputs.has(key)) {
      out.push(diag('warning', 'CCIS-V4-007', `/inputs/${x.at}/key`, `The input "${key}" is declared but no computation uses it.`, 'Remove the input, or use it.'));
    }
  }
  for (const [id, x] of params) {
    if (!usedParams.has(id) && x.kind !== 'criteria') {
      out.push(diag('warning', 'CCIS-V4-007', `/parameters/${x.at}/id`, `The parameter "${id}" is declared but no computation uses it.`, 'Remove the parameter, or use it.'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layer 5: pathways, decision nodes, compatibility
// ---------------------------------------------------------------------------------------------

const STATES_TO_COVER = ['present', 'absent', 'unknown', 'not-collected', 'explicitly-negative', 'conflicting'];

function nodeChecks(node, base, out, stageIds) {
  if (!isObj(node)) return;
  const keys = new Set(arr(node.inputs).map((x) => (isObj(x) ? x.key : null)));
  arr(node.outcomes).forEach((o, j) => {
    if (!isObj(o)) return;
    arr(o.when).forEach((w, k) => {
      if (isObj(w) && typeof w.input === 'string' && !keys.has(w.input)) {
        out.push(diag('error', 'CCIS-V5-003', `${base}/outcomes/${j}/when/${k}/input`,
          `The outcome "${o.id}" tests the input "${w.input}", which is not one of the inputs of node "${node.id}".`,
          'Test one of the node\'s inputs, or add the input to the node.'));
      }
    });
    if (stageIds && isObj(o.next) && typeof o.next.stage === 'string' && !stageIds.has(o.next.stage)) {
      out.push(diag('error', 'CCIS-V5-001', `${base}/outcomes/${j}/next/stage`,
        `The outcome "${o.id}" of node "${node.id}" leads to stage "${o.next.stage}", which does not exist.`,
        'Point the outcome at an existing stage id.'));
    }
  });
  const first = arr(node.inputs).find(isObj);
  if (first && typeof first.key === 'string') {
    const seen = new Set();
    arr(node.outcomes).forEach((o) => isObj(o) && arr(o.when).forEach((w) => isObj(w) && w.input === first.key && seen.add(w.is)));
    for (const s of STATES_TO_COVER) {
      if (!seen.has(s)) {
        out.push(diag('error', 'CCIS-V5-005', `${base}/outcomes`,
          `No outcome of node "${node.id}" handles the input "${first.key}" when it is in the state "${s}".`,
          'Add an outcome for that state. An unhandled state must never fall through as normal.'));
      }
    }
  }
}

function pathwayChecks(doc, ctx, out) {
  const stages = arr(doc.stages);
  const stageIds = new Set(stages.map((s) => (isObj(s) ? s.id : null)));
  const nodeIds = new Set(arr(doc.nodes).map((n) => (isObj(n) ? n.id : null)));
  const trans = arr(doc.transitions);

  trans.forEach((t, i) => {
    if (!isObj(t)) return;
    if (typeof t.from === 'string' && !stageIds.has(t.from)) {
      out.push(diag('error', 'CCIS-V5-001', `/transitions/${i}/from`,
        `The transition to "${t.to}" starts at stage "${t.from}", which does not exist.`, 'Point the transition at an existing stage id.'));
    }
    if (typeof t.to === 'string' && !stageIds.has(t.to)) {
      out.push(diag('error', 'CCIS-V5-001', `/transitions/${i}/to`,
        `The transition from "${t.from}" leads to stage "${t.to}", which does not exist.`, 'Point the transition at an existing stage id.'));
    }
    if (typeof t.via === 'string' && !nodeIds.has(t.via)) {
      out.push(diag('error', 'CCIS-V5-001', `/transitions/${i}/via`,
        `The transition from "${t.from}" goes via the node "${t.via}", which does not exist.`, 'Name a node the pathway contains.'));
    }
  });
  arr(doc.timing).forEach((t, i) => {
    if (!isObj(t) || !isObj(t.between)) return;
    for (const end of ['from', 'to']) {
      if (typeof t.between[end] === 'string' && !stageIds.has(t.between[end])) {
        out.push(diag('error', 'CCIS-V5-001', `/timing/${i}/between/${end}`,
          `The timing "${t.id}" names stage "${t.between[end]}", which does not exist.`, 'Point the timing at an existing stage id.'));
      }
    }
  });
  arr(doc.nodes).forEach((n, i) => nodeChecks(n, `/nodes/${i}`, out, stageIds));

  // Reachability from the first stage, over transitions only.
  const edges = new Map();
  for (const t of trans) {
    if (isObj(t) && stageIds.has(t.from) && stageIds.has(t.to)) {
      if (!edges.has(t.from)) edges.set(t.from, []);
      edges.get(t.from).push(t.to);
    }
  }
  const firstStage = stages.find(isObj);
  if (firstStage) {
    const reached = new Set([firstStage.id]);
    const queue = [firstStage.id];
    while (queue.length > 0) {
      for (const next of edges.get(queue.shift()) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
    }
    stages.forEach((s, i) => {
      if (isObj(s) && !reached.has(s.id)) {
        out.push(diag('error', 'CCIS-V5-002', `/stages/${i}`,
          `Stage "${s.id}" cannot be reached from the first stage by any transition.`, 'Add a transition that reaches the stage, or remove the stage.'));
      }
    });
  }

  // A stage that is not a report stage must have a way out.
  stages.forEach((s, i) => {
    if (isObj(s) && s.kind !== 'report' && !trans.some((t) => isObj(t) && t.from === s.id)) {
      out.push(diag('error', 'CCIS-V5-006', `/stages/${i}`,
        `Stage "${s.id}" is not a final (report) stage, but no transition leaves it.`, 'Add a transition out of the stage, or make it a report stage.'));
    }
  });

  // Cycles: a warning only, one per pathway.
  const state = new Map();
  let cycleAt = null;
  const dfs = (id) => {
    state.set(id, 1);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === 1) { cycleAt ??= next; } else if (!state.has(next)) dfs(next);
    }
    state.set(id, 2);
  };
  for (const s of stages) if (isObj(s) && !state.has(s.id)) dfs(s.id);
  if (cycleAt !== null) {
    const i = trans.findIndex((t) => isObj(t) && t.to === cycleAt);
    out.push(diag('warning', 'CCIS-V5-007', `/transitions/${i}`,
      `The transitions form a cycle through stage "${cycleAt}". Whether the cycle is bounded is not checked yet.`,
      'Check by hand that the cycle ends. Boundedness checks arrive in a later row.'));
  }

  // Timing parameters against the analytics the pathway names (those that were supplied).
  const declared = new Set();
  let supplied = 0;
  arr(doc.analytics).forEach((a) => {
    const r = isObj(a) ? ctx.resolve(a.ref) : { state: 'skip' };
    if (r.state === 'ok') { supplied += 1; arr(r.doc.parameters).forEach((p) => isObj(p) && declared.add(p.id)); }
  });
  if (supplied > 0) {
    arr(doc.timing).forEach((t, i) => {
      if (isObj(t) && typeof t.parameter === 'string' && !declared.has(t.parameter)) {
        out.push(diag('error', 'CCIS-V5-004', `/timing/${i}/parameter`,
          `The timing "${t.id}" names the parameter "${t.parameter}", which none of the named analytics declares.`,
          'Name a parameter that one of the pathway\'s analytics packages declares.'));
      }
    });
  }
}

function compatibilityChecks(doc, kind, out) {
  const v = isObj(doc.manifest) && isObj(doc.manifest.standard) ? doc.manifest.standard.version : null;
  const major = (x) => { const m = typeof x === 'string' ? /^(0|[1-9]\d*)\./.exec(x) : null; return m ? Number(m[1]) : null; };
  if (major(v) !== null && !SUPPORTED_STANDARD_MAJORS.includes(major(v))) {
    out.push(diag('error', 'CCIS-V5-008', '/manifest/standard/version',
      `The artefact is written for standard version ${v}, whose major version this validator does not support (it supports ${SUPPORTED_STANDARD_MAJORS.map((m) => `${m}.x`).join(', ')}).`,
      'Use a validator that supports that standard, or rewrite the artefact for a supported one.'));
  }
  if (kind === 'analytics-package' && isObj(doc.operatorSet)) {
    const { name, version } = doc.operatorSet;
    if (name !== SUPPORTED_OPERATOR_SET.name || (major(version) !== null && !SUPPORTED_OPERATOR_SET.majors.includes(major(version)))) {
      out.push(diag('error', 'CCIS-V5-008', '/operatorSet',
        `The operator set "${name}" ${version} is not one this validator knows (it knows ${SUPPORTED_OPERATOR_SET.name} ${SUPPORTED_OPERATOR_SET.majors.map((m) => `${m}.x`).join(', ')}).`,
        'Use the operator set this validator supports. Operators outside it are never guessed.'));
    }
  }
}

export function graphLayer(doc, kind, ctx = { resolve: () => ({ state: 'skip' }) }) {
  const out = [];
  if (kind === 'pathway') pathwayChecks(doc, ctx, out);
  else if (kind === 'decision-node') nodeChecks(doc, '', out, null);
  compatibilityChecks(doc, kind, out);
  return out;
}
