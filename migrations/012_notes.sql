-- Task B3c-1: clinical notes and signing, on the server.
-- A note starts as a draft. The author edits it (a stale edit is refused by row_version) and signs it, or discards it (kept, never deleted).
-- A signed note is immutable: the database refuses any UPDATE. A change is an amendment: a new row with a mandatory reason; the original text stays.
-- Author, signer and amender come from the session in the routes; the database also makes sure only the author can be the signer.
-- Nothing is ever deleted: the rules below do not rest on the route code alone.

/* ---------- case_notes ---------- */
CREATE TABLE case_notes (
  id           serial PRIMARY KEY,
  case_id      integer NOT NULL REFERENCES clinical_cases(id),
  encounter_id integer,                                                   -- the case's open linked encounter when the note was started, if any
  author_id    integer NOT NULL REFERENCES users(id),                     -- from the session
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','discarded')),
  row_version  integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  signed_by    integer REFERENCES users(id),
  signed_at    timestamptz,
  discarded_by integer REFERENCES users(id),
  discarded_at timestamptz,
  FOREIGN KEY (case_id, encounter_id) REFERENCES case_encounters (case_id, encounter_id),
  CHECK ((status = 'signed' AND signed_by IS NOT NULL AND signed_at IS NOT NULL) OR (status <> 'signed' AND signed_by IS NULL AND signed_at IS NULL)),
  CHECK ((status = 'discarded' AND discarded_by IS NOT NULL AND discarded_at IS NOT NULL) OR (status <> 'discarded' AND discarded_by IS NULL AND discarded_at IS NULL)),
  CHECK (signed_by IS NULL OR signed_by = author_id)                      -- only the author signs
);
CREATE INDEX case_notes_case_idx ON case_notes (case_id, id);

CREATE FUNCTION case_note_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'a note starts as a draft'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_notes_insert_guard BEFORE INSERT ON case_notes
  FOR EACH ROW EXECUTE FUNCTION case_note_insert_guard();

-- Only a draft changes: its text, or its one-way move to signed or discarded (the text is then exactly the one last saved).
-- A signed or discarded note refuses every UPDATE. Every update advances row_version by one, which is what makes a stale edit detectable.
CREATE FUNCTION case_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a % note cannot be changed (a signed note is amended, with a reason)', OLD.status; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the case, encounter, author and start time of a note cannot be changed';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  IF NEW.status <> 'draft' AND NEW.body IS DISTINCT FROM OLD.body THEN RAISE EXCEPTION 'a note is signed or discarded exactly as it was last saved'; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER case_notes_guard BEFORE UPDATE ON case_notes
  FOR EACH ROW EXECUTE FUNCTION case_note_guard();

/* ---------- case_note_amendments: append-only; the original text stays in case_notes.body ---------- */
CREATE TABLE case_note_amendments (
  id          serial PRIMARY KEY,
  note_id     integer NOT NULL REFERENCES case_notes(id),
  seq         integer NOT NULL CHECK (seq >= 1),
  reason      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  body        text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),   -- the full text after this amendment
  amended_by  integer NOT NULL REFERENCES users(id),                            -- from the session
  amended_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (note_id, seq)
);

CREATE FUNCTION case_note_amendment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; n integer;
BEGIN
  SELECT status INTO st FROM case_notes WHERE id = NEW.note_id;
  IF st IS DISTINCT FROM 'signed' THEN RAISE EXCEPTION 'only a signed note is amended'; END IF;
  SELECT count(*) INTO n FROM case_note_amendments WHERE note_id = NEW.note_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'amendments are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_note_amendments_guard BEFORE INSERT ON case_note_amendments
  FOR EACH ROW EXECUTE FUNCTION case_note_amendment_guard();

/* ---------- no hard delete, no truncate, for anyone ---------- */
CREATE TRIGGER case_notes_no_delete          BEFORE DELETE   ON case_notes           FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_notes_no_truncate        BEFORE TRUNCATE ON case_notes           FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_note_amendments_no_change   BEFORE UPDATE OR DELETE ON case_note_amendments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_note_amendments_no_truncate BEFORE TRUNCATE ON case_note_amendments FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

/* ---------- grants for emr_app: exactly what notes.js uses. No DELETE, no TRUNCATE. ---------- */
GRANT SELECT, INSERT ON case_notes, case_note_amendments TO emr_app;
GRANT UPDATE (body, row_version, status, signed_by, signed_at, discarded_by, discarded_at) ON case_notes TO emr_app;
GRANT USAGE ON SEQUENCE case_notes_id_seq, case_note_amendments_id_seq TO emr_app;
