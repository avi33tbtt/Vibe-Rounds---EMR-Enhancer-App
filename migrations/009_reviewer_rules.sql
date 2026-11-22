-- Task 8c: reviewer role, approve/reject with a reason, and the rules enforced in the database.
-- A version in review becomes `reviewed` (approved) only when enough different reviewers approved it:
-- one reviewer, or two when lint flagged the set (needsTwoReviewers). A reviewer is never the author or the submitter.
-- One reject ends the version (`rejected`, final); the author adds a new draft version instead. Nothing is ever deleted.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','doctor','nurse','viewer','informatician'));

ALTER TABLE element_set_versions DROP CONSTRAINT IF EXISTS element_set_versions_status_check;
ALTER TABLE element_set_versions ADD CONSTRAINT element_set_versions_status_check
  CHECK (status IN ('draft','in_review','rejected','reviewed','published','retired'));

CREATE TABLE element_set_reviews (
  id             serial PRIMARY KEY,
  element_set_id integer NOT NULL,
  version        integer NOT NULL,
  reviewer_id    integer NOT NULL REFERENCES users(id),
  decision       text NOT NULL CHECK (decision IN ('approve','reject')),
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (element_set_id, version) REFERENCES element_set_versions(element_set_id, version),
  UNIQUE (element_set_id, version, reviewer_id)          -- the same reviewer cannot review a version twice
);

CREATE FUNCTION element_set_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v record; r text;
BEGIN
  SELECT status, created_by, submitted_by INTO v FROM element_set_versions WHERE element_set_id = NEW.element_set_id AND version = NEW.version;
  IF v.status IS DISTINCT FROM 'in_review' THEN RAISE EXCEPTION 'only a version in review can be reviewed'; END IF;
  IF NEW.reviewer_id IN (v.created_by, v.submitted_by) THEN RAISE EXCEPTION 'a reviewer cannot be the author or the submitter of the version'; END IF;
  SELECT role INTO r FROM users WHERE id = NEW.reviewer_id;
  IF r IS DISTINCT FROM 'informatician' THEN RAISE EXCEPTION 'only an informatician can review'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER element_set_reviews_guard BEFORE INSERT ON element_set_reviews FOR EACH ROW EXECUTE FUNCTION element_set_review_guard();
CREATE TRIGGER element_set_reviews_no_change   BEFORE UPDATE OR DELETE ON element_set_reviews FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER element_set_reviews_no_truncate BEFORE TRUNCATE         ON element_set_reviews FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE OR REPLACE FUNCTION element_set_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_old int; rank_new int; needed int; approvals int;
BEGIN
  rank_old := CASE OLD.status WHEN 'draft' THEN 1 WHEN 'in_review' THEN 2 WHEN 'rejected' THEN 3 WHEN 'reviewed' THEN 3 WHEN 'published' THEN 4 ELSE 5 END;
  rank_new := CASE NEW.status WHEN 'draft' THEN 1 WHEN 'in_review' THEN 2 WHEN 'rejected' THEN 3 WHEN 'reviewed' THEN 3 WHEN 'published' THEN 4 ELSE 5 END;
  IF NEW.element_set_id IS DISTINCT FROM OLD.element_set_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'element set version identity is immutable';
  END IF;
  -- Once a version has left draft, what was submitted can never change (this covers approved, published and retired versions too).
  IF OLD.status <> 'draft' AND (
       NEW.definition_json IS DISTINCT FROM OLD.definition_json OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.lint_json IS DISTINCT FROM OLD.lint_json) THEN
    RAISE EXCEPTION 'a submitted element set version is immutable';
  END IF;
  IF OLD.status IN ('published','retired') AND (
       NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'a published element set version is immutable';
  END IF;
  IF OLD.status = 'rejected' AND NEW.status <> 'rejected' THEN RAISE EXCEPTION 'a rejected element set version is final'; END IF;
  IF NEW.status = 'rejected' AND OLD.status NOT IN ('in_review','rejected') THEN RAISE EXCEPTION 'only a version in review can be rejected'; END IF;
  IF rank_new < rank_old THEN
    RAISE EXCEPTION 'element set version status cannot go back from % to %', OLD.status, NEW.status;
  END IF;
  -- Approval is earned, not set: enough different approving reviewers (never the author or submitter), counted from the reviews table.
  IF NEW.status = 'reviewed' AND OLD.status <> 'reviewed' THEN
    IF OLD.status <> 'in_review' THEN RAISE EXCEPTION 'only a version in review can be approved'; END IF;
    needed := CASE WHEN OLD.lint_json->>'needsTwoReviewers' = 'true' THEN 2 ELSE 1 END;
    SELECT count(DISTINCT reviewer_id) INTO approvals FROM element_set_reviews
      WHERE element_set_id = OLD.element_set_id AND version = OLD.version AND decision = 'approve'
        AND reviewer_id NOT IN (OLD.created_by, OLD.submitted_by);
    IF approvals < needed THEN RAISE EXCEPTION 'this version needs % different approving reviewer(s); it has %', needed, approvals; END IF;
  END IF;
  RETURN NEW;
END $$;

GRANT SELECT, INSERT ON element_set_reviews TO emr_app;
GRANT USAGE ON SEQUENCE element_set_reviews_id_seq TO emr_app;
