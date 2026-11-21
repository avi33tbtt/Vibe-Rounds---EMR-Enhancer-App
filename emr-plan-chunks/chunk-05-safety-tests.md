# Chunk 05 — Safety-test pack + CI

**Goal:** automated checks that guard the invariants.
**Build tests for:**
1. Permission matrix: every route × every role.
2. Concurrency: two writers, second gets a conflict.
3. Audit coverage: every write route creates an audit row.
4. Seed sets contain zero rules and zero bands.
5. Migrations run from empty and from the previous version.
6. Verified-only export: unverified and mismatched codes never appear as `Coding`.
7. Signed notes cannot be edited; no hard delete route exists.
8. One browser smoke test (login, open case, enter value, export).
**Done when:** one command runs everything; CI fails on any break.
