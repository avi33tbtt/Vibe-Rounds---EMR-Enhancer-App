# Clinical Context Model: baseline contract (task B0)

Status: **DRAFT for your review. Nothing in B1 to B5 starts until you approve this file.**
Date: 2026-11-22. Documentation only: no code and no migration came with it.

This file maps every object the page keeps in the browser today to the entity and table that will hold it on the server. B1 to B5 cite its section numbers.

**Read this first (honesty note).** The book's Chapter 5 text is not in the repo. The chunk file cites "Ch5 4.3" for the `case_encounters` join, and I use only that number. Every other table and column name below is a **proposal** from the page code and the core rules. When you review, check the names against Chapter 5 sections 4 to 5 and tell me what to rename.

Where the facts came from: `emr-enhancer.html` (lines ~405 to 1000 and 1100 to 1360: `migrateFields`, `load`, `save`, `applySet`, `upgradeSet`, notes, rows), `migrations/001` to `005` (only patients and encounters exist), and `DECISIONS.md` rows for tasks 1 to 3.

---

## 1. Product rules this contract fixes

1. **The server is the system of record** for cases, element sets, observations, notes. Browser storage is only the `file://` demo fallback behind one storage adapter (B1b). A signed-in session writes no clinical data to localStorage.
2. **A case is owned by a patient**, not by an encounter. A case links to encounters through a `case_encounters` join (Ch5 4.3). A case can span several encounters.
3. **Observations are append-only.** Each has `effective_at` (when it was true clinically) and `recorded_at` (when it was entered, set by the server). A correction is a new row with `corrects_id`. A wrong entry gets `status = 'entered_in_error'` with who and when. No UPDATE of a value, no DELETE.
4. **Element sets and pathways have a stable identity plus immutable versions.** Once a version exists its content never changes. A change is a new version.
5. **A case pins exact versions.** Moving to a newer version is an explicit action and is recorded.
6. **Signer, author, amender, approver and `recorded_by` come from the session.** No route accepts them in a body.
7. **The server enforces permissions and read-only content.** The built-in sets are system-owned and cannot be edited, only forked.
8. **No hard delete of clinical data**, enforced as for `patients` and `encounters` today: a `BEFORE DELETE` trigger (`forbid_change()`) plus no DELETE/TRUNCATE grant for `emr_app` (migration 005). Every new clinical table gets both.

---

## 2. Identifiers and keys

| Thing | Today | Target |
|-------|-------|--------|
| Case id | client string `c_<base36 time><rand>` | server `serial` integer, like `patients.id` and `encounters.id`. The old string is not kept. |
| Element set identity | `id` string (`vitals`, `snake_ctx`, `sdc_<slug>`, `gen_*`) | `element_sets.key` (text, unique, never reused, never edited) + `element_sets.id` serial |
| Element set version | integer `version` (default 1) + `history[]` | row in `element_set_versions` (`element_set_id`, `version`), unique together, immutable |
| Field key | `field.id` (`cc`, `glu`, `k`) | `elements.field_key`, unique **within a set version**, stable across versions of the same set |
| Pathway identity | `id` (`pw_dm`) | `pathways.key` + `pathway_versions` (B4) |
| Observation | none (value kept in `CASE.values[fieldId]`) | `observations.id` bigserial |
| Note | client string `n_<base36 time>` | server serial; amendments get a per-note `seq` |

**Field keys are only unique inside one set.** Found while reading the code: today `CASE.values` is keyed by the bare field id, and these ids exist in two different sets each: `glu` (glucose_ss, gen_dka), `wbct` and `swell` (snake_ctx, gen_snake), `arr` and `out` (gen_snake, gen_dka). If a case applies both sets of a pair, the two forms share one stored value. The target model fixes this by keying every observation on (element set, field key), never on the field key alone. This is a **changed behaviour**, listed in section 5.

---

## 3. Mapping table: browser object to target

**Names as built (B1a, 2026-11-22):** the chunk's names won over the proposals below: case table `clinical_cases` (with `case_key`, `row_version`, status `active|resolved|closed|archived`), `case_encounters` (with `patient_id` and `relation_type`), narrative table `case_narrative_entries` (author column `author_id`). Later rows below are still proposals.

"Stays" means it never goes to the server.

| # | Browser object (where) | Target entity / table | Identifiers and keys | Lifecycle states | Lost or changed |
|---|------------------------|-----------------------|----------------------|------------------|-----------------|
| 1 | `vr_traj` blob `{cases, current, customs}` (localStorage) | Split into the rows below. `current` (open case) stays in the page only. | n/a | n/a | The single blob goes away for signed-in users. `current` is a view setting, not clinical. |
| 2 | **Case** `{id, patientId, patient{}, narrative, applied[], values{}, notes[], status, createdAt, updatedAt}` | `cases` (`id`, `patient_id` NOT NULL, `status`, `created_by`, `created_at`, `updated_at`, `archived_at`, `archived_by`) | `cases.id` serial | `open` -> `archived` -> `open` (restore). Archive only, never delete. | Server cases require a registered patient. `updatedAt` becomes server-set and is bumped by child writes. `createdBy` is new. |
| 3 | `case.patient{name,mrn,age,sex}` (typed, for unlinked demo cases) | **Stays in browser** (file:// demo fallback only) | n/a | n/a | Not stored on the server. A server case always uses the `patients` row (identity is already server-owned, DECISIONS task 1). |
| 4 | `case.patientId` | `cases.patient_id` -> `patients.id` | FK | fixed at creation | Cannot be changed afterwards (a different patient is a different case). |
| 5 | Case to encounter link (not stored today; the page only shows `Srv.pts[id].open_bed`) | `case_encounters` (`case_id`, `encounter_id`, `linked_at`, `linked_by`) per Ch5 4.3 | unique (`case_id`, `encounter_id`) | a link is never removed | New. The server rejects a link to an encounter of another patient. A case opened while the patient has an open encounter links to it automatically. |
| 6 | `case.narrative` (one text box, overwritten on each save) | `case_narratives` (`case_id`, `body`, `saved_by`, `saved_at`); current = latest row | serial | append-only | **Changed:** overwriting loses history, so each save adds a row (the page saves on change, not per keystroke). PROPOSED; see decision D3. |
| 7 | `case.applied[]` entry `{setId, version, addedAt, fromPathway}` | `case_applied_sets` (`case_id`, `element_set_version_id`, `added_at`, `added_by`, `from_pathway_version_id` null, `removed_at`, `removed_by`) | serial | `active` -> `removed` (columns set, row kept) | **Changed:** `removeSet` today deletes the entry. The row is kept with `removed_at/by`. Entered values stay linked to the set. Re-applying a removed set adds a new row. |
| 8 | Applied-set version pin `a.version`, and `upgradeSet()` | The `element_set_version_id` on `case_applied_sets`. An upgrade adds a new `case_applied_sets` row for the new version, marks the old row `superseded_at`, and writes a `case_events` row `set_upgraded`. | FK | `pinned` -> `superseded` | New: who upgraded and when. Values carry over by `field_key`, as `upgradeSet` does today ("Entered values are kept"). |
| 9 | **Element set** (`REGISTRY` entry: `id, kind, title, desc, fields[], custom, sdc, curation, generated, questionnaire, version, history[]`) | `element_sets` (`id`, `key`, `kind` template/disease/care, `origin` builtin/custom/sdc/ai_draft, `owner_id` null for system, `created_by`, `created_at`, `archived`) + `element_set_versions` (`id`, `element_set_id`, `version`, `title`, `desc`, `sdc` jsonb, `curation` jsonb, `created_by`, `created_at`) | `key`; (`element_set_id`, `version`) | A version is immutable. Review states (draft/submitted/approved) are added by 8b and 8c as columns or a child table; B2a does not invent them. | `custom:true` and `generated:true` become `origin`. **Changed:** today a title or description edit overwrites the set silently (only a `fields` change bumps the version). Target: any change to title, desc, fields, bindings or sdc is a new version. |
| 10 | **BUILTIN** sets and `DEMO_SNAKE`, `DEMO_DKA` (constants in the page) | Seeded as `element_sets` with `origin = 'builtin'`, `owner_id` null, version 1, by the seed script. Read-only, enforced by the server; fork to edit. | `key` = current `id` | immutable | Demo sets stay in the page for the file:// fallback. Seeding on the server is B2a. |
| 11 | `set.history[]` entry `{version, title, desc, fields, at}` | Rows of `element_set_versions` (one per old version) | (`element_set_id`, `version`) | immutable | A history `at` means "superseded at", not "created at". Browser history is **not** migrated (decision D1). |
| 12 | **Field** `{id, label, type, unit, options, repeat, derived, flag, codingPolicy, bindings[], legacyCoding}` | `elements` (`id`, `element_set_version_id`, `field_key`, `position`, `label`, `type`, `unit`, `options` jsonb, `repeat` bool, `derived` bool, `flag`, `coding_policy`) | `field_key` unique within the set version | immutable with its version | `legacyCoding` is not carried: it exists only for pre-`bindings[]` data and nothing on the server has it. `flag` (dose/threshold-like warning) is kept so a flagged field stays flagged. |
| 13 | `field.bindings[]` `{system, code, display, source}` | `element_bindings` (`element_id`, `system`, `code`, `display`, `source` manual/llm/sdc) | unique (`element_id`, `system`, `code`) | immutable with its version | **Verified status is not stored with the binding.** It stays derived (code exists on the terminology server AND display matches), as today. Only verified bindings reach FHIR `Coding` (core rule). |
| 14 | `case.values[fieldId]` scalar (text, number, select, boolean, datetime) | `observations` (see 3a below), one row per entry | `observations.id` | `final` -> `entered_in_error`; correction by new row (`corrects_id`) | **Changed:** `setVal()` overwrites today; the server keeps every value. The page commits on change/blur, not per keystroke. Keyed on (set, field), see section 2. |
| 15 | `case.values[fieldId]` repeat rows `[{ts, value, status, errorBy, errorAt}]` | `observations` (same table; `effective_at` = `ts`) | `observations.id` | `final` -> `entered_in_error` | `ts` is minute precision local text today; the server stores `timestamptz`. `errorBy/errorAt` map to `error_by/error_at`. The 8f page rule (rows are never removed) becomes a DB rule. |
| 16 | Derived value `balance` (stored in `values`, computed from `intake` - `output`) | **Not stored.** `elements.derived = true`; the page computes it. | n/a | n/a | **Changed:** no observation row for a derived field, so no stale balance. The rule stays in the page for now. |
| 17 | **Note** `{id, kind, title, body, status, createdAt, signedBy, signedAt, discardedAt, amendments[]}` | `notes` (`id`, `case_id`, `encounter_id` null, `kind`, `title`, `body`, `status`, `created_by`, `created_at`, `signed_by`, `signed_at`, `discarded_by`, `discarded_at`) | serial | `draft` -> `signed`; `draft` -> `discarded`. A signed note is immutable (trigger). | New: `created_by`, `discarded_by`, optional `encounter_id`. A draft body can be edited; draft edit history is not kept. |
| 18 | `note.amendments[]` `{at, by, reason, body}` | `note_amendments` (`note_id`, `seq`, `body`, `reason`, `amended_by`, `amended_at`) | unique (`note_id`, `seq`) | append-only | `by` comes from the session. A reason is required (server check). The original signed body stays in `notes.body`. |
| 19 | Structured-snapshot note body (text built from current values) | Same `notes` row, `kind = 'structured'`; body is text. Optional `note_observations` link (note_id, observation_id) later. | n/a | same as 17 | Today the snapshot is plain text with no link to the values it came from. The link is NOT in B3c unless you ask for it. |
| 20 | **Pathway** (`PATHWAYS` constant: `id, kind, title, desc, members[]`; no custom pathways exist) | `pathways` (`id`, `key`, `title`...) + `pathway_versions` + `pathway_members` (`pathway_version_id`, `element_set_id`, `position`) (B4) | `key` | version immutable | Members name a **set** (not a set version); applying a pathway pins the then-current set versions per case, as `applySet` does today. `fromPathway` becomes `from_pathway_version_id`. |
| 21 | Case timeline events (implicit: apply, remove, upgrade, archive, restore) | `case_events` (`case_id`, `type`, `payload` jsonb, `actor_id`, `at`) (B3a) | serial | append-only | New. This is the clinical timeline, separate from the security `audit_log`; both are written in the same transaction as the action. |
| 22 | SDC Questionnaire stored on a set (`set.questionnaire`, `set.sdc`) | `element_set_versions.sdc` jsonb (url, authored/modified). The Questionnaire is **rebuilt** by `sdc.js`, not stored. | n/a | n/a | Imported Questionnaire JSON is not kept verbatim. If you need the original kept, say so (decision D4). |
| 23 | QuestionnaireResponse, FHIR bundle (export only) | **Derived**, never stored. FHIR is the export boundary. | n/a | n/a | Author comes from the session. Entered-in-error rows export as `entered-in-error` (8f). |
| 24 | AI-generated draft set (`LAST_GENERATED`, `GEN_STASH`) | **Stays in browser** until the user saves it; saving creates an `element_sets` row with `origin = 'ai_draft'` | n/a | n/a | Drafts are not stored on the server before a human saves them. |
| 25 | `vr_codes`, `vr_mm` (terminology lookup caches) | **Stay in browser** (non-clinical, rebuilt from the terminology server) | n/a | n/a | None. |
| 26 | `vr_cfg`, `vr_set` (terminology host, demo switch), `vr_traj_pre_bindings` (one-time backup) | **Stay in browser** | n/a | n/a | `vr_traj_pre_bindings` is a demo-only backup and is not needed on the server. |
| 27 | `vr_user` (typed signer) | **Gone.** Purged since 8e. | n/a | n/a | n/a |
| 28 | `Srv.pts`, `Srv.user` | Already server-owned (migration 003). Page cache only. | `patients.id` | n/a | None. |
| 29 | UI state (`AMEND`, `SHOW_ERR`, search boxes, `CASE` pointer) | **Stays in browser** | n/a | n/a | None. |

### 3a. `observations` (proposed columns, for B3a to confirm)

`id` bigserial; `case_id`; `case_applied_set_id` (which pin it was entered under); `element_id` (the exact version's field); `element_set_id` + `field_key` (stable identity, for trajectories across versions); `value_text`, `value_num`, `value_ts`, `value_bool` (one used per row, by element type); `unit`; `effective_at` timestamptz NOT NULL; `recorded_at` timestamptz default now(), server-set; `recorded_by` from session; `status` `final` | `entered_in_error`; `corrects_id` null; `error_by`, `error_at`, `error_reason` null.

Rules: no UPDATE except the one-way move to `entered_in_error` (trigger); no DELETE; `recorded_by`, `recorded_at` never taken from a request body.

The "current value" of a scalar field is the latest `final` row for (case, set, field) by `recorded_at`. The trajectory of a repeat field is all `final` rows ordered by `effective_at`.

---

## 4. Not moved yet (explicit list)

These exist only in the plan, not in the browser objects above, and B1 to B5 do **not** create them: decision nodes and graphs, evidence and research links, phenotype definitions, analytics packages and templates, cohort definitions, run records, the test marketplace, the review workflow tables (8b to 8d add them), and any patient-level export route.

Stays out of the server on purpose: marketplace content must never hold registration data (core rule).

## 5. What changes for the user or for existing data

1. Values are no longer overwritten; the history of changes exists on the server. The page may show only the latest.
2. Removing a set from a case hides it; the data stays.
3. Two sets with the same field id no longer share a value.
4. A title or description edit on a custom set now creates a new version.
5. `balance` is computed, never saved.
6. Existing browser cases, sets and notes are **not** imported (D1). They were synthetic data.

## 6. Build order (from the tracker; B2r is merged into 8b to 8d)

`B1a` cases server -> `B1b` cases in the page -> `B2a` element sets server -> `B2b` library and pinning in the page -> `8b`/`8c`/`8d` review workflow on server versions -> `B3a` observations, applied sets, events (server) -> `B3b` values in the page -> `B3c` notes on the server -> `B4` pathways -> `B5` context service.

Each new route updates the permission matrix (`test/safety-routes.test.js`) and audit tests on purpose; each new table gets the DELETE-forbid trigger and only the grants `emr_app` needs.

---

## 7. Decisions I need from you

| ID | Question | My proposal |
|----|----------|-------------|
| D1 | Import existing browser cases, sets and notes into the server? | No. They are synthetic. Start clean; keep the old localStorage untouched. |
| D2 | Table and column names | Accept my proposals, or give me the Ch5 section 4 to 5 names to use instead. |
| D3 | Narrative as append-only revisions (row 6) | Yes. Otherwise a signed-in user can erase earlier text. |
| D4 | Keep an imported Questionnaire's original JSON? | No; keep only `sdc.url` and rebuild. Say yes if the original must be reproducible. |
| D5 | Who may create and edit custom sets and apply them? | Create/edit: admin and doctor. Apply to a case: admin, doctor, nurse. Viewer: read only. Settled in B2a/B1a against `permissions.js`. |
| D6 | Link a case to the open encounter automatically? | Yes on creation, plus a manual link action. |

**Done when you reply** "B0 approved" (with any changes to the names or D1 to D6). Then B1a can start.
