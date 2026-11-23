# Demo script (DRAFT, row DM0, 2026-11-23)

Synthetic data only. Prototype. Not for clinical use. Length 5 to 7 minutes.

**Correction to the early idea:** the CCIS snake slice reports *process metrics* (interval from bite to antivenom, documentation completeness). It does not decide whether treatment criteria are met, and it contains no thresholds (CCIS D-008). The demo therefore shows descriptive outputs, missing-data states and provenance, never a treatment recommendation.

## The story
Synthetic patient "DEMO, Patient A" arrives after a snake bite. A clinician documents the case; the EMR hands a de-identified snapshot to CCIS; CCIS returns descriptive results with provenance; the clinician reviews and acknowledges.

## Steps (later rows cite these numbers)
1. **Open the case** (DM1 seed). Pathway "snake envenomation documentation" is pinned at an exact published version. Show the version badge.
2. **Timeline.** About 8 observations with effective times and recorded times; one value is `Unknown`, one item is missing. Point out that unknown is not "normal".
3. **Export the context envelope** (B5b). Show that name, ID and narrative are absent. Show the export log hash.
4. **Run CCIS** (DM3 bridge, or CLI by hand). Show the command and the run record file.
5. **Insights panel** (DM2b). Outputs: interval metric, documentation completeness. Show: a value where data exist, "not enabled" where a parameter is disabled, "missing data" where the record is incomplete. Show package version, engine version and the parameter list. Banner: demo placeholders, not clinical values.
6. **Acknowledge** as the clinician. The record itself is unchanged; show that notes and observations did not change.
7. **Platform moment** (CCIS DS6). Staged cohort view over the 23 synthetic fixture cases, labelled "staged, not the cohort engine". Close on the roadmap slide: what is real, what is planned.

## Real versus staged
Real: case, pins, observations, envelope, CLI run, run-record import, provenance, acknowledgement.
Staged or absent: terminology server, orders and results, medications, IPD, FHIR, cohort engine, second package.

## Two cuts
Clinician: steps 1, 2, 5, 6. Technical or investor: steps 3, 4, 7 and the architecture diagram (shown once, early).

## Likely questions
Does it replace our EMR? (No: boundary.) Where does data go? (Nowhere: files, local.) Who is responsible for a suggestion? (Outputs are descriptive; clinician reviews; acknowledgement recorded.)
