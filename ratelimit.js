'use strict';
// In-memory fixed-window limiter. No dependency.
// LIMITATION: state lives in this process. With more than one server instance each keeps its own counts,
// so the real limit is (limit x instances). Before running several instances, move this to a shared store.
function createLimiter({ max, windowMs, maxKeys = 5000, now = Date.now }) {
  const hits = new Map();   // key -> { n, reset, told }
  const purge = t => {
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
    while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);   // oldest first; makes room, so size never exceeds maxKeys
  };
  function entry(key) {
    const t = now();
    let e = hits.get(key);
    if (!e || e.reset <= t) { if (hits.size >= maxKeys) purge(t); e = { n: 0, reset: t + windowMs, told: false }; hits.set(key, e); }
    return e;
  }
  return {
    max, windowMs,
    // Count one request. ok=false once the window is full. first=true only on the first refusal in a window
    // (the caller writes ONE audit row per key per window, so a flood cannot fill the audit log).
    hit(key) {
      const e = entry(key);
      e.n += 1;
      if (e.n <= max) return { ok: true };
      const first = !e.told; e.told = true;
      return { ok: false, first, retryAfter: Math.max(1, Math.ceil((e.reset - now()) / 1000)) };
    },
    // Look without counting (used to refuse a login before spending a password check).
    blocked(key) {
      const e = hits.get(key);
      if (!e || e.reset <= now() || e.n < max) return null;
      const first = !e.told; e.told = true;
      return { ok: false, first, retryAfter: Math.max(1, Math.ceil((e.reset - now()) / 1000)) };
    },
    reset(key) { hits.delete(key); },
    size: () => hits.size,
  };
}
module.exports = { createLimiter };
