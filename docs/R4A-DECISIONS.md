# R4a: owner decisions for orders and results (recorded 2026-11-26)

_Decisions by the project owner. Synthetic data only; not for clinical use._

| # | Question | Decision |
|---|---|---|
| 1 | Drug data source for R4 medication orders | **Local drug list only.** Our own in-house list, reviewed and published like local terms (R2f: draft, review, publish, retire; author never reviews). **No licensed or open drug database is loaded, shipped or demoed.** No licence check is needed. If one is wanted later, add a new row and do the licence check first. |
| 2 | Named clinician owner for R4 order content | **The project owner, for the synthetic demo only.** A named, qualified clinician is still required before any real use. This is a go-live gate item (see R8e and `docs/GO-LIVE-CHECKLIST.md`). |

## What this means for R4b to R4j

- A medication order may name its medication from a **published local term** (new term category for drugs) or in free text as recorded, as the R3e list does. Free text is never treated as verified.
- The local drug list holds names only. It has **no dose, strength, interaction, allergy-conflict or "usual dose" content**, and nothing is checked against it clinically.
- No doses or thresholds are suggested by AI or by the page (core rule). Dose, route and frequency stay free text as typed.
- Signer or orderer comes from the session only (core rule).
- Order, change (with reason) and stop; nothing is deleted. Entered-in-error is final.
- Investigation orders, results, referrals and procedures follow the same rules; their names also come from local terms or free text.
- Any rule content (thresholds, bands, medication safety) still needs a named clinician owner; as the demo-only owner, you must not enable such content for real use.

## Follow-ups added to the tracker

- R4b gets a first step: add the drug category to local terms (R2f routes) so orders can pick from it. Split off a row if that fills the size guard.
