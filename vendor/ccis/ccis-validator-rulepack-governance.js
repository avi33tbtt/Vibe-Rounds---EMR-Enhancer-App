// CCIS VALIDATOR, row ECO-B13c: layer 8 for a rule pack (RULE-PACK-DESIGN sections 7 to 9; ED-47). Prototype. Synthetic data only.
// Pure. Compares claims in the file (author, owner, reviewer records, status). A name match is not proof of independence (ED-19).
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const diag = (severity, ruleId, path, message, hint) => ({ severity, ruleId, path, message, hint });
const norm = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '');

export const RULEPACK_GOVERNANCE_RULES = [
  { ruleId: 'CCIS-V8-004', layer: 8, severity: 'error', summary: 'A reviewer record names the author of the rule pack.' },
  { ruleId: 'CCIS-V8-005', layer: 8, severity: 'error', summary: 'A clinical-prompt rule pack has no named owner.' },
  { ruleId: 'CCIS-V8-006', layer: 8, severity: 'error', summary: 'The status is reviewed or beyond, and no reviewer record names this exact version.' },
  { ruleId: 'CCIS-V8-007', layer: 8, severity: 'error', summary: 'The status is beyond draft, and the rule pack names no author.' },
];

const NEEDS_REVIEW = new Set(['reviewed', 'validated', 'conditionally-validated']);

export function rulePackGovernance(doc) {
  const out = [];
  const m = isObj(doc.manifest) ? doc.manifest : {};
  const g = isObj(doc.governance) ? doc.governance : {};
  const author = norm(g.author);
  arr(g.reviewers).forEach((r, i) => {
    if (isObj(r) && author !== '' && norm(r.name) === author) out.push(diag('error', 'CCIS-V8-004', `/governance/reviewers/${i}/name`, 'A reviewer record names the author of this rule pack.', 'Ask a different person to review, and record that person.'));
  });
  if (doc.class === 'clinical-prompt' && (norm(g.owner) === '' || norm(g.owner) === 'unassigned')) {
    out.push(diag('error', 'CCIS-V8-005', '/governance/owner', 'A clinical-prompt rule pack needs a named owner.', 'Name the clinician who owns this pack (ED-2).'));
  }
  if (NEEDS_REVIEW.has(m.status) && !arr(g.reviewers).some((r) => isObj(r) && r.version === m.version)) {
    out.push(diag('error', 'CCIS-V8-006', '/manifest/status', `The status "${m.status}" is claimed, but no reviewer record names version ${m.version}.`, 'Record who reviewed this exact version, or return the status to draft.'));
  }
  if (typeof m.status === 'string' && m.status !== 'draft' && norm(g.author) === '') {
    out.push(diag('error', 'CCIS-V8-007', '/manifest/status', `The status "${m.status}" is claimed, but the rule pack names no author.`, 'Name the author in the governance record, or return the status to draft.'));
  }
  return out;
}
