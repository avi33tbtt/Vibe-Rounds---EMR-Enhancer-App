-- Task R2f-2: review workflow for local terms (same rules as element sets, one approval is enough).
-- Adds who/when columns, an append-only review table, database rules for each status step, and the application role's UPDATE
-- on the status and who/when columns ONLY (never display, code or definition: the guard trigger refuses those too).

ALTER TABLE local_terms
  ADD COLUMN submitted_by integer REFERENCES users(id),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN published_by integer REFERENCES users(id),
  ADD COLUMN published_at timestamptz,
  ADD COLUMN retired_by   integer REFERENCES users(id),
  ADD COLUMN retired_at   timestamptz;

CREATE TABLE local_term_reviews (
  id          serial PRIMARY KEY,
  term_id     integer NOT NULL REFERENCES local_terms(id),
  reviewer_id integer NOT NULL REFERENCES users(id),     -- from the session
  decision    text NOT NULL CHECK (decision IN ('approve','reject')),
  reason      text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (term_id, reviewer_id)
);

CREATE FUNCTION local_term_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record; r text;
BEGIN
  SELECT status, created_by, submitted_by INTO v FROM local_terms WHERE id = NEW.term_id;
  IF v.status IS DISTINCT FROM 'in_review' THEN RAISE EXCEPTION 'only a local term in review can be reviewed'; END IF;
  IF NEW.reviewer_id IN (v.created_by, v.submitted_by) THEN RAISE EXCEPTION 'a reviewer cannot be the author or the submitter of the term'; END IF;
  SELECT role INTO r FROM users WHERE id = NEW.reviewer_id;
  IF r IS DISTINCT FROM 'informatician' THEN RAISE EXCEPTION 'only an informatician can review'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER local_term_reviews_guard       BEFORE INSERT          ON local_term_reviews FOR EACH ROW       EXECUTE FUNCTION local_term_review_guard();
CREATE TRIGGER local_term_reviews_no_change   BEFORE UPDATE OR DELETE ON local_term_reviews FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER local_term_reviews_no_truncate BEFORE TRUNCATE        ON local_term_reviews FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE OR REPLACE FUNCTION local_term_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rank_old int; rank_new int;
BEGIN
  rank_old := CASE OLD.status WHEN 'draft' THEN 1 WHEN 'in_review' THEN 2 WHEN 'rejected' THEN 3 WHEN 'reviewed' THEN 3 WHEN 'published' THEN 4 ELSE 5 END;
  rank_new := CASE NEW.status WHEN 'draft' THEN 1 WHEN 'in_review' THEN 2 WHEN 'rejected' THEN 3 WHEN 'reviewed' THEN 3 WHEN 'published' THEN 4 ELSE 5 END;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'local term identity is immutable';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.display IS DISTINCT FROM OLD.display OR NEW.category IS DISTINCT FROM OLD.category OR NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN
    RAISE EXCEPTION 'a submitted local term version is immutable';
  END IF;
  IF OLD.status IN ('published','retired') AND (NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'a published local term version is immutable';
  END IF;
  IF OLD.status = 'rejected' AND NEW.status <> 'rejected' THEN RAISE EXCEPTION 'a rejected local term version is final'; END IF;
  IF NEW.status = 'rejected' AND OLD.status NOT IN ('in_review','rejected') THEN RAISE EXCEPTION 'only a term in review can be rejected'; END IF;
  IF rank_new < rank_old THEN RAISE EXCEPTION 'local term status cannot go back from % to %', OLD.status, NEW.status; END IF;
  IF NEW.status = 'in_review' AND OLD.status = 'draft' AND (NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL) THEN RAISE EXCEPTION 'a submitted term needs who and when'; END IF;
  IF NEW.status = 'reviewed' AND OLD.status <> 'reviewed' THEN
    IF OLD.status <> 'in_review' THEN RAISE EXCEPTION 'only a term in review can be approved'; END IF;
    IF NOT EXISTS (SELECT 1 FROM local_term_reviews WHERE term_id = OLD.id AND decision = 'approve') THEN RAISE EXCEPTION 'a term needs an approval before it is reviewed'; END IF;
  END IF;
  IF NEW.status = 'published' AND OLD.status NOT IN ('reviewed','published') THEN RAISE EXCEPTION 'only an approved (reviewed) term can be published'; END IF;
  IF NEW.status = 'published' AND OLD.status = 'reviewed' AND (NEW.published_by IS NULL OR NEW.published_at IS NULL) THEN RAISE EXCEPTION 'a published term needs who and when'; END IF;
  IF NEW.status = 'retired' AND OLD.status NOT IN ('published','retired') THEN RAISE EXCEPTION 'only a published term can be retired'; END IF;
  IF NEW.status = 'retired' AND OLD.status = 'published' AND (NEW.retired_by IS NULL OR NEW.retired_at IS NULL) THEN RAISE EXCEPTION 'a retired term needs who and when'; END IF;
  RETURN NEW;
END $$;

GRANT UPDATE (status, submitted_by, submitted_at, published_by, published_at, retired_by, retired_at) ON local_terms TO emr_app;
GRANT SELECT, INSERT ON local_term_reviews TO emr_app;
GRANT USAGE ON SEQUENCE local_term_reviews_id_seq TO emr_app;
