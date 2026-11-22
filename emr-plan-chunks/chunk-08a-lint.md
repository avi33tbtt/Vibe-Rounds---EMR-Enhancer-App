# Chunk 08a: Shared lint module

_Part 1 of original chunk 08. No server, no UI._

**Core rules:** attach `01-core.md` too.

**Read only:** `sdc.js` (as the pattern for a UMD module), `deid.js`, the set shape in `emr-enhancer.html` (grep `CODESYS`, `displayMatch`, `migrateSet`), `seed`-set content if any.

**Build:**
1. Create `lint.js` (UMD, pure functions, no network, like `sdc.js`) returning a list of `{severity, path, rule, message}`.
2. Rules: (1) schema: required keys and valid field kinds; (2) every bound code is verified: verification state is passed in, the module never calls a server; (3) dose/threshold-like text (number plus unit, comparison signs, 'mg', 'mmol', 'bpm' and similar) without a `citation`; (4) executable content (`<script`, `javascript:`, `on*=`); (5) patient-like strings (reuse `deid.js` patterns).
3. Also return a flag `needsTwoReviewers` when the set has rules, bands or dose-like text (used by 8c).
4. Define the optional `citation` field in one line and record it in DECISIONS.md. Tests: each bad example triggers exactly its rule; a clean set passes.

**Done when:** every rule has a failing and a passing test.

**Size guard:** One new module and one test file; no change to existing files.
