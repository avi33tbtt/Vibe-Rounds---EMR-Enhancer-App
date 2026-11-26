# Decisions

## R6f-2b (2026-11-26)
| ID | Decision |
|----|----------|
| R6F2B-1 | "Chart" is the case: the person names `caseId`, `appliedSetId` and `fieldKey`; nothing is matched from the imported label. The patient on the proposal is taken from that case. The server needs an applied set and a field to store a value, so the field is always a person's choice. |
| R6F2B-2 | Units are never assumed or converted: a unit-bearing field refuses a value with no unit or another unit. A whole `number` fits an integer field (shapeValue refuses a fraction); text fits text or select; unknown fits any field. |
| R6F2B-3 | Accept needs `import:write` AND `cases:write` (admin and doctor hold both). It records `source_ref = import:<bundle>/<key>` (no content), leaves a normal `observation.record` audit row plus `import.proposal_accept`, and adds the usual timeline event. |
