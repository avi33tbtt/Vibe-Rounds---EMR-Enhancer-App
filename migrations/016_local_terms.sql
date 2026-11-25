-- Task R2f-1: local terms (a free, in-house vocabulary; no licensed code system is used or loaded).
-- A local term is a code of our own (system key "local") with a display text. Verified = the code exists AND the display matches
-- a PUBLISHED version here (rule applied in later rows). Codes are never reused; a changed display is a NEW version.
-- Nothing is ever deleted. This row only adds drafts; review and publish come in R2f-2, so the application role gets SELECT and INSERT only.

CREATE TABLE local_terms (
  id          serial PRIMARY KEY,
  code        text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  version     integer NOT NULL CHECK (version >= 1),
  display     text NOT NULL CHECK (char_length(btrim(display)) BETWEEN 1 AND 200),
  category    text NOT NULL DEFAULT 'other' CHECK (category IN ('finding','condition','test','procedure','observation','other')),
  definition  text CHECK (definition IS NULL OR char_length(btrim(definition)) BETWEEN 1 AND 500),   -- plain text meaning, for humans
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','rejected','reviewed','published','retired')),
  created_by  integer NOT NULL REFERENCES users(id),                                                 -- from the session
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (code, version)
);
CREATE INDEX local_terms_code_idx ON local_terms (code, version DESC);

-- Once a version leaves draft, what it says can never change; status only moves forward; identity never changes.
CREATE FUNCTION local_term_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rank_old int; rank_new int;
BEGIN
  rank_old := CASE OLD.status WHEN 'draft' THEN 1 WHEN 'in_review' THEN 2 WHEN 'rejected' THEN 3 WHEN 'reviewed' THEN 3 WHEN 'published' THEN 4 ELSE 5 END;
  rank_new := CASE NEW.status WHEN 'draft' THEN 1 WHEN 'in_review' THEN 2 WHEN 'rejected' THEN 3 WHEN 'reviewed' THEN 3 WHEN 'published' THEN 4 ELSE 5 END;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'local term identity is immutable';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.display IS DISTINCT FROM OLD.display OR NEW.category IS DISTINCT FROM OLD.category OR NEW.definition IS DISTINCT FROM OLD.definition) THEN
    RAISE EXCEPTION 'a submitted local term version is immutable';
  END IF;
  IF rank_new < rank_old THEN RAISE EXCEPTION 'local term status cannot go back from % to %', OLD.status, NEW.status; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER local_terms_guard       BEFORE UPDATE   ON local_terms FOR EACH ROW       EXECUTE FUNCTION local_term_guard();
CREATE TRIGGER local_terms_no_delete   BEFORE DELETE   ON local_terms FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER local_terms_no_truncate BEFORE TRUNCATE ON local_terms FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON local_terms TO emr_app;
GRANT USAGE ON SEQUENCE local_terms_id_seq TO emr_app;
