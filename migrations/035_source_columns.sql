-- Task D4: where imported content came from, and the pathway layout (ED-5, ED-79).
-- Source columns: the CCIS artefact id, its version and its checksum, all three or none. Old rows stay NULL.
-- entry_form and contexts: the CCIS pathway layout, on pathway versions only.
-- All of these are insert-only: a separate guard on each table (the existing guards from 007, 010 and 013 are left alone)
-- refuses any later change at every status. emr_app already has table-level INSERT and column-level UPDATE only on named
-- columns, so no grant changes and the new columns cannot be updated by the app.
ALTER TABLE element_set_versions
  ADD COLUMN source_artefact_id text CHECK (source_artefact_id IS NULL OR source_artefact_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  ADD COLUMN source_version     text CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 64),
  ADD COLUMN source_checksum    text CHECK (source_checksum IS NULL OR source_checksum ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT element_set_versions_source_all_or_none
    CHECK ((source_artefact_id IS NULL) = (source_version IS NULL) AND (source_version IS NULL) = (source_checksum IS NULL));

ALTER TABLE pathway_versions
  ADD COLUMN source_artefact_id text CHECK (source_artefact_id IS NULL OR source_artefact_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  ADD COLUMN source_version     text CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 64),
  ADD COLUMN source_checksum    text CHECK (source_checksum IS NULL OR source_checksum ~ '^[0-9a-f]{64}$'),
  ADD COLUMN entry_form         jsonb CHECK (entry_form IS NULL OR jsonb_typeof(entry_form) = 'object'),
  ADD COLUMN contexts           jsonb CHECK (contexts IS NULL OR jsonb_typeof(contexts) = 'array'),
  ADD CONSTRAINT pathway_versions_source_all_or_none
    CHECK ((source_artefact_id IS NULL) = (source_version IS NULL) AND (source_version IS NULL) = (source_checksum IS NULL));

CREATE INDEX element_set_versions_source_idx ON element_set_versions (source_artefact_id, source_version) WHERE source_artefact_id IS NOT NULL;
CREATE INDEX pathway_versions_source_idx ON pathway_versions (source_artefact_id, source_version) WHERE source_artefact_id IS NOT NULL;

CREATE FUNCTION element_set_version_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_artefact_id IS DISTINCT FROM OLD.source_artefact_id OR NEW.source_version IS DISTINCT FROM OLD.source_version
     OR NEW.source_checksum IS DISTINCT FROM OLD.source_checksum THEN
    RAISE EXCEPTION 'the source of an element set version never changes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER element_set_versions_source_guard BEFORE UPDATE ON element_set_versions
  FOR EACH ROW EXECUTE FUNCTION element_set_version_source_guard();

CREATE FUNCTION pathway_version_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_artefact_id IS DISTINCT FROM OLD.source_artefact_id OR NEW.source_version IS DISTINCT FROM OLD.source_version
     OR NEW.source_checksum IS DISTINCT FROM OLD.source_checksum THEN
    RAISE EXCEPTION 'the source of a pathway version never changes';
  END IF;
  IF NEW.entry_form IS DISTINCT FROM OLD.entry_form OR NEW.contexts IS DISTINCT FROM OLD.contexts THEN
    RAISE EXCEPTION 'the entry form and contexts of a pathway version never change (add a new version instead)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pathway_versions_source_guard BEFORE UPDATE ON pathway_versions
  FOR EACH ROW EXECUTE FUNCTION pathway_version_source_guard();
