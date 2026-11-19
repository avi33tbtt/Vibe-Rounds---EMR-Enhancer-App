-- Chunk 37a: live refresh. GET /api/cases/:id/changes finds what changed after a time. Rows, values and acknowledgements already carry one;
-- a note only had created_at and signed_at, so a draft edit left no mark. updated_at is set on create, edit and sign.
ALTER TABLE case_notes ADD COLUMN updated_at timestamptz;
UPDATE case_notes SET updated_at = GREATEST(created_at, COALESCE(signed_at, created_at));
ALTER TABLE case_notes ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();
CREATE INDEX case_notes_changed_ix ON case_notes (case_id, updated_at);
CREATE INDEX case_rows_changed_ix ON case_rows (case_id, (COALESCE(updated_at, entered_at)));
CREATE INDEX case_values_changed_ix ON case_values (case_id, updated_at);
