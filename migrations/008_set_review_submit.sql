-- Task 8b: submit a draft element-set version for review (built on the B2a server versions, not on a separate snapshot table).
-- Adds the status `in_review` (draft -> in_review -> reviewed -> published -> retired) and records who submitted, when,
-- and the server's lint result. From the moment a version leaves `draft` its content and these facts are frozen in the database.
-- `reviewed` is the approved state (8c adds the reviewer rules and `rejected`).

ALTER TABLE element_set_versions DROP CONSTRAINT IF EXISTS element_set_versions_status_check;
ALTER TABLE element_set_versions ADD CONSTRAINT element_set_versions_status_check
  CHECK (status IN ('draft','in_review','reviewed','published','retired'));

ALTER TABLE element_set_versions
  ADD COLUMN submitted_by integer REFERENCES users(id),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN lint_json    jsonb;

ALTER TABLE element_set_versions ADD CONSTRAINT element_set_versions_submit_check
  CHECK (status <> 'in_review' OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND lint_json IS NOT NULL));

CREATE OR REPLACE FUNCTION element_set_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_old int; rank_new int;
BEGIN
  rank_old := CASE OLD.status WHEN 'draft' THEN 1 WHEN 'in_review' THEN 2 WHEN 'reviewed' THEN 3 WHEN 'published' THEN 4 ELSE 5 END;
  rank_new := CASE NEW.status WHEN 'draft' THEN 1 WHEN 'in_review' THEN 2 WHEN 'reviewed' THEN 3 WHEN 'published' THEN 4 ELSE 5 END;
  IF NEW.element_set_id IS DISTINCT FROM OLD.element_set_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'element set version identity is immutable';
  END IF;
  -- Once a version has left draft, what was submitted can never change.
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
  IF rank_new < rank_old THEN
    RAISE EXCEPTION 'element set version status cannot go back from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- The app may record a submission (and nothing else new). Content columns stay ungrantable.
GRANT UPDATE (submitted_by, submitted_at, lint_json) ON element_set_versions TO emr_app;
