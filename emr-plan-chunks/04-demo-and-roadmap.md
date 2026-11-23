# Demo track and advanced-EMR roadmap (added 2026-11-23)

Goal 1 (DEMO, rows B5a to DM4): one believable synthetic patient story that runs end to end: EMR case -> context envelope -> CCIS run -> result with provenance back in the EMR -> clinician acknowledges. Real: the envelope, the hand-off, the run-record import, provenance, acknowledgement. Staged: terminology server, orders, IPD, FHIR, cohort engine.

Goal 2 (ROADMAP, rows R0 to R8): the full advanced EMR. All LOCKED until DM4 is DONE and you say **"start roadmap"**.

## Boundary rules (never break)
1. The EMR owns clinical facts. CCIS never writes to clinical tables. Results arrive as imported, append-only run records; a clinician acknowledges them.
2. Hand-off is by file or local CLI. No network service between the two products (CCIS D-001, D-002, D-010).
3. The envelope follows the CCIS `context-envelope` schema (CCIS row 1.4). It supersedes the shape written in `chunk-B5-context-service.md`.
4. Demo parameter values are test-only placeholders, never clinical. The UI must say so wherever a demo result is shown.
5. Every new route updates the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose.

## Global build order across both repos
CCIS 1.5b -> EMR B5a -> B5b -> CCIS DS1 -> DS2a -> DS2b -> DS3 -> DS4 -> EMR DM1 -> DM2a -> DM2b -> DM3 -> CCIS DS5 -> DS6 -> DS7 -> EMR DM4.
(DM0 and CCIS DS0 are docs, delivered with this plan.)

## Roadmap rows (chunk file written when reached, from these briefs)
Every R row must state its **context impact**: which envelope section it adds or changes, and whether the CCIS `context-envelope` schema needs a minor or major version. No clinical capability ships without that line.

| Row | Workstream | Brief | Context impact | Size guard |
|---|---|---|---|---|
| R0 | (engineering) | Split `emr-enhancer.html` into modules, no behaviour change, tests stay green. Do before R1. | none | 1 refactor row, split per screen |
| R1 | A. Encounter experience | Complaint-oriented OPD; structured symptom attributes; adaptive history; structured examination; assessment and plan; quick and detailed modes. Built on element sets and pathways. | new observation kinds only | 1 screen per sub-row |
| R2 | B. Terminology | Server-side code search and verification (replaces "cannot verify"); LOINC and ICD bindings; local terminology; terminology version table. Licence check first (you). | bindings carry version | server then page |
| R3 | D. Longitudinal record | Problem list, allergies, medication history, results and encounter timeline across cases. | new envelope sections: problems, allergies | migration + route + page per item |
| R4 | C. Orders and results | Medication orders and reconciliation; investigation orders, specimen, result, abnormal acknowledgement; referrals; procedures. Needs a named clinician owner and a drug-data licence decision before starting. | new sections: orders, results | 1 order type per row |
| R5 | C. IPD | Admission, progress notes, medication administration record, discharge and follow-up. Needs R4. | new section: administrations | split heavily |
| R6 | E. Interoperability | FHIR R4 export of verified codings (existing rule), import of Questionnaire/Bundle, conformance tests. | none (export boundary only) | 1 resource per row |
| R7 | F. Integration hardening | Batch envelope export (D8b), envelope versioning policy, run-record retention, de-identification review. | envelope major version policy | 1 row each |
| R8 | Validation | End-to-end workflow tests, clinician walkthrough, privacy and security review, safety case. Largely your tasks; Claude prepares checklists. | none | docs and tests |

Not for clinical use until R8 passes and the go-live checklist is signed.
