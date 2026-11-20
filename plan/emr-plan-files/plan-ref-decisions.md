# Reference: open decisions (section 13)

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 13. Open decisions

Answer before the task that needs it, or accept the default.

| # | Default | Needed by |
|---|---|---|
| 1 | Locked-account sign-in attempts are not logged | 40b |
| 2 | Admin may chart, approve and sign | 39 |
| 3 | Informatician cannot open patients | 44, 46 |
| 6 | Patient searches not audited; opening a record is | 40c |
| 8 | Audit CSV omits before/after contents | 40c |
| 9 | Reference-data conflicts offer only "Reload the app" | done |
| 10 | Two reviewers for packages with rules | 44a2d |
| **11** | **Who turns EMR view pathways on:** admin picks the facility's active view pathways in Settings (stored in `app_settings`, audited); everyone sees them. Not a per-case "apply", so the rule "a nurse cannot apply pathways" is not in the way. | V7 |
| **12** | **Orders entry:** set `access` (section 5): `care.orders` enter by doctor and admin, `care.mar` enter open to nurses. | R3, R4 |
| **13** | **Which version of a view block a case uses:** the version recorded on the case (same as fields). Only synthetic data exists today, so after a seed bump, re-apply the set on test cases. Revisit before real patients. | V4b |
| **14** | **MAR link:** the MAR row stores a copy of the order text plus the order row id in a plain text field, no new field type. | 49b |
| **15** | **ADT vs Encounter:** the server's encounter record owns ward and bed (one open encounter per bed). ADT rows are informational and never change it silently; a button "Apply to encounter" calls the existing encounter route. | 50a |
| **16** | **Analytics cards:** stay as they are for now; their hand-named lines sit on the allow-list until 38a4. Make them data-declared later only if you want. | 38a4 |
| **17** | **Fixed frame:** Summary, Flowsheets, Notes, Pathway, Alerts, Export stay fixed (E7). Say if you want more of them made data-driven. | V7 |
| **18** | **Scope:** roles stay global (no ward or team restriction) for now. Say if a nurse must see only her own ward. | R3 |
| **19** | **Who changes an element's access:** admin only. | R7 |
| **20** | **Analytics role:** superseded by decision 30 (analytics are in the Analytics app). | AA11 |
| **21** | **SETTLED by owner:** all analytics run in the Analytics app; the EMR only exports (section 2). No in-app engine. | F7, AA0 |
| **22** | **Dates in the bridge and in exports:** days since the encounter start (matches 38b3). Yearly trends (V4) then need a year field; say if a constant per-site date shift is preferred. Inside the app (Route 2) real dates are used under roles and audit. | F7 |
| **23** | **Reference lists (class 3):** local only, informatician approves, two reviewers when limits are held, never in a package by default. Wave 1 analytics use none. | AA13 |
| **24** | **First role list:** the seven in 6.4 (time, quantity, category, status, text, actor, link). | F2 |
| **25** | **Who approves a new role:** informatician proposes, admin approves, with a test and a doc line. | F1 |
| **26** | **Manual binding:** stored locally in `field_bindings`, audited, never in a package; set and analytic versions recorded; flagged for re-check on any version change. Set by admin or informatician. | M6 |
| **27** | **Summary layouts:** derived cards are built in; layouts become marketplace items later. | S3 |
| **28** | **Diagnoses and procedures as elements:** add a data-only `care.diagnoses` (Condition) and a `care.procedures` (Procedure) recording set before analytics 2 and 12 are offered. Say if diagnoses stay on the case only. | F4, AA7 |
| **29** | **Export coverage:** only Observation, Condition, MedicationRequest, AllergyIntolerance, Encounter and Procedure feed analytics at first; MAR and non-medication orders do not. | F7, AA7 to AA9 |
| **30** | **Roles in the Analytics app:** viewer, analyst, admin. Analyst runs enabled definitions and sees aggregates; only admin installs, imports and sees patient lists. (Replaces decision 20 for analytics.) | AA11 |
| **31** | **EMR Demo mode analytics:** none; the Analytics tab shows export only. Say if the synthetic-case chart buttons should survive in Demo mode. | F9 |
| **32** | **The existing 14 analytics:** stay built in to the Analytics app; marketplace definitions are an additional layer. Moving them into packages is a later choice. | AA7 |
| **33** | **Export pushed or pulled:** pushed by an admin from the EMR (default); a scheduled pull by the Analytics app is a later option. | F7 |
| **34** | **Seed vs marketplace:** core seed sets stay built in (tier seed) so the EMR works offline from day one; the same content is also published as packages (same ids and versions, same hash) so updates and new items come through the marketplace. Say if the EMR should ship empty and install everything from the registry. | Z1 |
| **35** | **Demo patient identity:** ten patients named "Demo Patient 01" to "10", a clearly synthetic MRN pattern and a synthetic marker; times as offsets from one anchor date (default: a fixed date so tests are stable). Say if you want different names or a different count. | D1, D2 |
| **36** | **Demo seeding:** only on a throwaway database, refused in production (patients are never deleted). | D3 |
| **37** | **Demo volume:** the Analytics app's own generator supplies volume; the EMR builds no second generator. | D8 |
| **38** | **Coding choice per field:** author ticks which systems the field may carry (SNOMED CT, LOINC, ICD-10, ICD-11, local, none); several allowed; "none" is always allowed and is the default. | P2, P3 |
| **39** | **Code systems are data:** a `code_systems` table (id, URI, name, standard or local). Seeded with the common systems and no codes; a facility adds its own local system. ICD-10, a national ICD-10 modification and ICD-11 are separate systems. | P1 |
| **40** | **Profiles are data, none built in:** a profile is a package (a list of required elements, optional required code systems) written by anyone. No national profile ships with the app. | P6 |
| **41** | **Profile wording:** "built for profile X vN, checked on synthetic data on date D with validator V". Never "compliant" or "certified". A profile that needs a code the user did not enter makes the export readiness list say so; the software never invents a code. | P11, P12 |
| **42** | **Analytics app codes (settled by owner, 20 Nov 2026):** the Analytics app reads SNOMED CT and LOINC only for now. ICD, local codes and others are exported by the EMR and stored, but analytics treats them as uncoded (V1 text mode). Supporting more systems there is a future phase; the EMR side is already ready for it. | P5b |
| **43** | **Layer merge rule (open):** when a profile, a disease template and a local edit disagree, which wins? Proposed default: a profile may add requirements but never removes a field; a local edit may narrow but never widen; a conflict is shown to the author and nothing is merged silently. Needs an answer before P6. | P6, P9 |
