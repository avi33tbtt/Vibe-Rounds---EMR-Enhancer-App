'use strict';
// Row R2f-4a: verify bindings against PUBLISHED local terms (system key "local"). No licensed vocabulary is used.
// A binding is verified only if a published term has the same code AND the same display (and the same version, if the binding names one).
// Anything else is unverified, with a short reason. Unknown never passes. Used by review.js at submit time.
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every binding in a stored definition (and the old single `coding` format), as objects.
function bindingsOf(def) {
  const out = [];
  for (const f of (isObj(def) && Array.isArray(def.fields) ? def.fields : [])) {
    if (!isObj(f)) continue;
    for (const b of (Array.isArray(f.bindings) ? f.bindings : [])) if (isObj(b)) out.push(b);
    if (isObj(f.coding)) out.push(f.coding);
  }
  return out;
}

// Load the published rows for the local codes the definition uses (c = a pg client or pool). Returns a Map code -> { version, display }.
async function loadPublished(c, def) {
  const codes = [...new Set(bindingsOf(def).filter(b => b.system === 'local' && typeof b.code === 'string' && b.code).map(b => b.code))];
  const map = new Map();
  if (!codes.length) return map;
  const { rows } = await c.query(`SELECT code, version, display FROM local_terms WHERE status = 'published' AND code = ANY($1)`, [codes]);
  for (const r of rows) map.set(r.code, { version: r.version, display: r.display });
  return map;
}

// A synchronous bindingState(binding) for lint, built from the loaded map.
function stateFrom(published) {
  return b => {
    if (!isObj(b) || b.system !== 'local') return 'not verified on the server';
    const t = published.get(b.code);
    if (!t) return 'term not published';
    if (typeof b.display !== 'string' || !b.display.trim()) return 'no display to compare';
    if (b.display.trim() !== t.display) return 'display does not match the published term';
    if (b.version !== undefined && b.version !== String(t.version)) return `term version changed (binding has ${b.version}, published is ${t.version})`;
    return 'verified';
  };
}

async function bindingStateFor(c, def) { return stateFrom(await loadPublished(c, def)); }

module.exports = { bindingStateFor, stateFrom, loadPublished, bindingsOf };
