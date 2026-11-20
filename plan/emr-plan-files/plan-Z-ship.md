# Phase Z: ship the composable library

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 29. Phase Z: ship the composable library (final phase)

*See section 3. Do this last, after Phase 7 and the release gates of 39 to 41. Work is in the registry repo (`emr-enhancer-registry`) unless stated. Decision 34 applies.*

#### [ ] Z1. Package the seed content
**Files:** registry `scripts/export-seeds.js` | **Paste:** the package manifest shape, `element-sets.js` (one set)
```text
Write a script that turns each seed set, EMR view pathway and order/allergy/MAR/ADT set into packages/<id>/<version>/package.json with manifest, content, license and targetApp "emr". Content is copied unchanged; the script must not add doses, thresholds, rules or codes. Test: content hash equals the hash of the seed.
```

#### [ ] Z2a. Package wave 1 analytics, part 1
**Files:** registry `packages/analytic.*` | **Paste:** the definition example in 7.1, validateAnalytic output
```text
Write definitions for data completeness, demographic distributions, encounter utilisation and procedure volume (7.3) with targetApp "analytics", slots, params with min/max/default, access and rules []. No clinical list. Each must pass validateAnalytic.
```

#### [ ] Z2b. Package wave 1 analytics, part 2
**Files:** registry `packages/analytic.*` | **Paste:** one definition from Z2a
```text
Same for condition prevalence, medication utilisation, and lab and vital summary (no abnormal share).
```

#### [ ] Z3. Index, lint and CI on the whole library
**Files:** build-index.js, ci.yml | **Paste:** 45b1, 45b3
```text
CI lints every package with the validator of its targetApp, recomputes hashes, rebuilds the index with provides and requires (M1), and fails on any error, on a kind/targetApp mismatch, and when the shared copies of compatibility() and package-lint.js differ from the apps' copies.
```

#### [ ] Z4. Review record for every item
**Files:** GOVERNANCE.md, review checklist | **Paste:** 47b1
```text
For each package record who reviewed it, when, and the checklist result. A package with rules or limit-like text needs two distinct reviewers. Items without the required reviewers keep tier local-draft in the index and are not labelled verified. State plainly in README that verified means peer review, not regulatory approval.
```

#### [ ] Z5. Sign and release index v1
**File:** release.yml | **Paste:** 45c1
```text
Sign index.json with the ed25519 key from secrets, publish index.json and index.json.sig, tag the release. Withdrawn list present and empty. Write the public key into both apps' docs.
```

#### [ ] Z6. EMR clean-install test
**Files:** EMR repo, `market-clean.test.js` | **Paste:** the install route tests (46a2c)
```text
On a fresh database: run migrations and seed, fetch the released index from a local copy of the registry, install every targetApp "emr" package, check each is read-only, hash-pinned, tiered and shows its coverage; try to install an analytic package and expect refusal.
```

#### [ ] Z7. Analytics-app clean-install test
**Files:** Analytics repo, selftest/e2e script | **Paste:** AA3, AA4
```text
On a fresh database: fetch the same released index, install every targetApp "analytics" package, refuse an emr package, tamper one byte and expect refusal, import the synthetic export bundle with its manifest, and run each wave 1 definition showing coverage, readiness and masked results.
```

#### [ ] Z8a. Acceptance script: EMR half
**Files:** EMR repo | **Paste:** nothing
```text
Script and checklist: load the ten demo patients (Phase D), register one more synthetic patient, open an encounter, record from an installed pathway, view the derived summary, place and change an order through the engine, record allergy and MAR, run the export, read the EMR audit log.
```

#### [ ] Z8b. Acceptance script: Analytics half
**Files:** Analytics repo | **Paste:** the output of Z8a
```text
Script and checklist: import the export with its manifest, run wave 1 definitions, read the audit log. Record the result of both halves in section 10.
```

#### [ ] Z9. Pre-release checklist and pilot
**Files:** GOVERNANCE.md, GOLIVE.md | **Paste:** 47b2, 41c2
```text
Complete the pre-release checklist (terminology licences, device-software rules, privacy, disclaimer, top 10 risks) and run a synthetic pilot with at least one named clinician reviewing wording and screens. The banner stays.
```

#### [ ] Z10. Author guide
**Files:** registry CONTRIBUTING.md, AUTHORING.md | **Paste:** VIEWS.md, ELEMENTS.md
```text
Write AUTHORING.md: how to write each kind of package, how to run the lint locally, how coverage is shown, what reviewers check, and the rules (no doses, thresholds, codes you did not verify, patient data). Test it by having someone else write one package from it.
```

**Gate Z:** every row of 3.2 is true and checked.
