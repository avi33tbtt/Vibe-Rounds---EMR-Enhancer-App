# CODING.md: free choice of coding, and profile labels

*Source: plan section 28 (plan-P-coding.md) and decisions 38 to 42 (plan-ref-decisions.md), 20 Nov 2026. A document only. The code arrives in P1 to P13.*

Forms made in the app are not tied to any one code system. An author can choose any mix of standard systems, the facility's own local codes, or no code at all. A form can also be labelled as built for a profile (a national, local or hospital-group FHIR profile) without the app knowing any particular profile.

## 1. The coding choices

On each field the author ticks which systems the field **may** carry (decision 38):

| Choice | Meaning |
|---|---|
| SNOMED CT | standard system |
| LOINC | standard system |
| ICD-10 | standard system |
| ICD-11 | standard system |
| My own local codes | the facility's own system (see section 4) |
| No code | the field carries no code. **This is the default.** |

- Any mix is allowed. Several can be ticked on one field.
- A field with no `coding` block means "No code" only.
- The choice says what a field **may** carry. It never puts a code on the field.

Code systems are data, not a fixed list in the software (decision 39). A `code_systems` table holds each system's id, URI, name, and whether it is standard or local. It is seeded with the common systems and **no codes**. A facility can add its own local system. ICD-10, a national modification of ICD-10 and ICD-11 are separate systems.

## 2. No code is always allowed

A form with no codes works fully:

- it records, with the same rules as any other form;
- it shows summary cards;
- it exports as text and numeric values;
- its coverage says "needs a code" only for an analytic or profile that asks for a code.

Nothing in the app requires a code to record, view or export a value.

## 3. The software never fills in a code

- A code appears on a field only when a person typed it and it was verified.
- Standard codes are typed by a person and checked in the official browser of that system, as now.
- No seed set, template, import, AI draft or default contains a code.
- The exporter reports what is missing. It never adds or changes a code to satisfy a profile (see section 6).
- A field with several codings carries each one as typed: a list of `system:code` pairs.

## 4. Local code systems

- A local system is created by an informatician or an admin, and is audited.
- Local codes are typed into the facility's own list (`local_codes`). There is no pre-filled content.
- A local code enters the verified list only after the same verification step as a standard code.
- A local code is never offered as a standard one, and is never shown as belonging to a standard system.
- A local system can be exported and stored. The Analytics app treats it as uncoded for now (decision 42, section 7).

## 5. Profiles

A profile is a **list of required elements**, written by anyone, with optional required code systems (decision 40).

- Profiles are data, packaged and installed like other marketplace items. **None is built in.** No national profile ships with the app.
- A profile holds slots exactly as in plan 7.1 (resource, role, unit, optional `codeSystem`). It never names a set id or a field id.
- A profile holds no clinical list, threshold, limit, band, dose or target.
- A package or form can carry several profile labels. In the marketplace each item shows its labels and can be filtered by "built for profile".
- Profile coverage is shown per required element as met, partly met or unmet, with the basis. It is a statement about what the form **can** record, never about the quality of care.

## 6. The wording rule

Labels are claims that were checked, not guarantees (decision 41). The only allowed wording is:

> built for profile X vN, checked on synthetic data on date D with validator V

- **Never** the words "compliant", "certified", "approved" or "conformant" on any screen, index entry or document.
- A failed check removes the label and nothing else.
- A profile that needs a code the user did not enter makes the export readiness list say so. The software never invents the code.
- The label shows its checked-on date.

## 7. What the Analytics app reads

For now the Analytics app reads **SNOMED CT and LOINC only** (decision 42). ICD, local codes and other systems are exported by the EMR and stored, but analytics counts them as uncoded (text mode). Supporting more systems there is a later phase. The EMR side is already ready for it.

## 8. Where each rule is enforced

| Rule | Task | Where |
|---|---|---|
| Code systems are data | P1a, P1b | migration, seed |
| A field's allowed systems are valid; no `default` or `auto` key | P2a | `views.js` |
| More than one coding per field; a disallowed system is refused | P2b | server |
| Element rows carry a list of codings | P2c | `elements.js` |
| Tick boxes in the field editor | P3 | `enhancer.html` |
| Local code lists | P4a, P4b | server, screen |
| Slot `codeSystem` in matching | P5a | `elements.js` |
| Analytics app accepts SNOMED CT and LOINC only | P5b | Analytics repo |
| Profile shape | P6 | `views.js` |
| Profile labels, filter, coverage, readiness, checked-on label | P7 to P12 | package lint, index, `elements.js`, export, CI |
| No code added by software; no "compliant" or "certified" text | P13 | safety tests |

## 9. Open decision

**Decision 43 (layer merge rule)** is still open and must be settled before P6. Proposed default: a profile may add requirements but never removes a field; a local edit may narrow but never widen; a conflict is shown to the author and nothing is merged silently.
