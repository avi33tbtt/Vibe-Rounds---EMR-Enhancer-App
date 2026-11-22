-- Task 8c-2: publish only an approved version, enforced in the database.
-- Until now an admin could publish a draft or an in-review version (the route allowed it, and so did the trigger).
-- From here a version becomes `published` only from `reviewed`, which itself needs the approvals counted in element_set_reviews (009).
-- A version that is already published or retired is unaffected. Nothing else changes; no grants are added.

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
  -- Publishing is earned too (8c-2): only an approved (`reviewed`) version can become published.
  IF NEW.status = 'published' AND OLD.status <> 'published' AND OLD.status <> 'reviewed' THEN
    RAISE EXCEPTION 'only an approved (reviewed) version can be published';
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
