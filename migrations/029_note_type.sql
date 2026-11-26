-- Task R5c-1: a note has a type: 'general' (what every existing note is) or 'progress' (an inpatient progress note).
-- The type is chosen when the note is started and never changes (not for a draft, not for a signed note); signed notes stay immutable (migration 012).
-- The type is a label only: it adds no rule, no code and no suggestion. No new table, no new route, no new grant: emr_app's column-limited UPDATE grant on case_notes does not list note_type.
ALTER TABLE case_notes ADD COLUMN note_type text NOT NULL DEFAULT 'general' CHECK (note_type IN ('general','progress'));

-- Same guard as migration 012, plus: the type of a note cannot be changed.
CREATE OR REPLACE FUNCTION case_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a % note cannot be changed (a signed note is amended, with a reason)', OLD.status; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the case, encounter, author and start time of a note cannot be changed';
  END IF;
  IF NEW.note_type IS DISTINCT FROM OLD.note_type THEN RAISE EXCEPTION 'the type of a note cannot be changed'; END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  IF NEW.status <> 'draft' AND NEW.body IS DISTINCT FROM OLD.body THEN RAISE EXCEPTION 'a note is signed or discarded exactly as it was last saved'; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
