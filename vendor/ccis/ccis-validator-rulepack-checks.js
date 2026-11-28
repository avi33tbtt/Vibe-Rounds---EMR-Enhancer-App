// CCIS VALIDATOR, row ECO-B12a: layer 5 checks for a rule pack (RULE-PACK-DESIGN sections 4, 6 and 8; ED-43). Prototype. Synthetic data only.
// Pure. Limits, concept fit and message form only. Messages name ids and paths, never clinical content.
// The instruction-word list is a crude guard; the clinical reviewer is the real control (design section 6).
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });

export const RULEPACK_CHECK_RULES = [
  { ruleId: 'CCIS-V5-048', layer: 5, severity: 'error', summary: 'A rule condition is deeper than 8 operator levels or has more than 40 nodes.' },
  { ruleId: 'CCIS-V5-049', layer: 5, severity: 'error', summary: 'A rule input reads a concept that no field of the referenced element carries.' },
  { ruleId: 'CCIS-V5-050', layer: 5, severity: 'error', summary: 'A rule message uses a placeholder outside the closed set, or has an unbalanced brace.' },
  { ruleId: 'CCIS-V5-051', layer: 5, severity: 'error', summary: 'A rule message holds markup, a URL or a control character.' },
  { ruleId: 'CCIS-V5-052', layer: 5, severity: 'error', summary: 'A rule message contains an instruction word from the closed list.' },
  { ruleId: 'CCIS-V5-053', layer: 5, severity: 'warning', summary: 'A rule input names an element that is not in manifest.references, so its concept cannot be checked.' },
];

const MAX_DEPTH = 8;
const MAX_NODES = 40;
const PLACEHOLDERS = new Set(['concept', 'parameter', 'count']);
const VERBS = /\b(order|start|stop|give|prescribe|increase|reduce|discontinue|administer|initiate|withhold|titrate)\b/i;

// Operator levels (root operator is level 1) and every node (operators, references, literals).
function measure(e) {
  if (!isObj(e)) return { depth: 0, nodes: 1 };
  if (!Array.isArray(e.args) || typeof e.op !== 'string') return { depth: 0, nodes: 1 };
  let depth = 0; let nodes = 1;
  for (const a of e.args) { const m = measure(a); depth = Math.max(depth, m.depth); nodes += m.nodes; }
  return { depth: depth + 1, nodes };
}

const fieldCodes = (el) => new Set([
  ...arr(el.fields),
  ...arr(el.modules).flatMap((m) => (isObj(m) ? arr(m.fields) : [])),
].filter((f) => isObj(f) && isObj(f.concept) && typeof f.concept.code === 'string').map((f) => f.concept.code));

export function rulePackChecks(doc, ctx) {
  const out = [];
  const refs = isObj(doc.manifest) ? arr(doc.manifest.references).filter((r) => isObj(r) && r.type === 'contextual-element') : [];
  const docs = refs.map((r) => ({ id: r.id, r: ctx.resolve(r) })).filter((x) => x.r.state === 'ok' && isObj(x.r.doc)).map((x) => ({ id: x.id, codes: fieldCodes(x.r.doc) }));

  arr(doc.rules).forEach((rule, i) => {
    if (!isObj(rule)) return;
    const m = measure(rule.when);
    if (m.depth > MAX_DEPTH || m.nodes > MAX_NODES) out.push(diag('error', 'CCIS-V5-048', `/rules/${i}/when`, `The condition of the rule "${rule.id}" has ${m.depth} operator levels and ${m.nodes} nodes; the limits are ${MAX_DEPTH} and ${MAX_NODES}.`, 'Split the rule into smaller rules.'));
    const t = isObj(rule.message) ? rule.message.template : undefined;
    if (typeof t !== 'string') return;
    const at = `/rules/${i}/message/template`;
    const bare = t.replace(/\{[^{}]*\}/g, (g) => (PLACEHOLDERS.has(g.slice(1, -1)) ? '' : '\u0001'));
    if (bare.includes('\u0001') || /[{}]/.test(bare)) out.push(diag('error', 'CCIS-V5-050', at, `The message of the rule "${rule.id}" uses a placeholder outside {concept}, {parameter}, {count}, or has an unbalanced brace.`, 'Use only the three placeholders, each in matched braces.'));
    const plain = bare.replace(/\u0001/g, ' ');
    if (/[<>]/.test(t) || /:\/\/|www\.|mailto:/i.test(t) || /[\u0000-\u001f\u007f]/.test(t)) out.push(diag('error', 'CCIS-V5-051', at, `The message of the rule "${rule.id}" holds markup, a URL or a control character.`, 'Write plain text only.'));
    if (VERBS.test(plain)) out.push(diag('error', 'CCIS-V5-052', at, `The message of the rule "${rule.id}" contains an instruction word.`, 'Describe the data gap; do not tell anyone what to do.'));
  });

  arr(doc.inputs).forEach((inp, i) => {
    if (!isObj(inp) || typeof inp.concept !== 'string') return;
    const at = `/inputs/${i}/concept`;
    if (typeof inp.element === 'string') {
      if (!refs.some((r) => r.id === inp.element)) { out.push(diag('warning', 'CCIS-V5-053', `/inputs/${i}/element`, `The input "${inp.id}" names the element "${inp.element}", which is not in manifest.references.`, 'Add the element to manifest.references so its concept can be checked.')); return; }
      const mine = docs.filter((d) => d.id === inp.element);
      if (mine.length > 0 && !mine.some((d) => d.codes.has(inp.concept))) out.push(diag('error', 'CCIS-V5-049', at, `The concept "${inp.concept}" of the input "${inp.id}" is carried by no field of the element "${inp.element}".`, 'Correct the concept, or read it from an element that carries it.'));
    } else if (docs.length > 0 && !docs.some((d) => d.codes.has(inp.concept))) {
      out.push(diag('error', 'CCIS-V5-049', at, `The concept "${inp.concept}" of the input "${inp.id}" is carried by no referenced element.`, 'Correct the concept, or reference an element that carries it.'));
    }
  });
  return out;
}
