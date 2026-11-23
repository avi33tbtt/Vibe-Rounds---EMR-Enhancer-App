-- Task B4a: pathways with immutable versions, and traceable pathway application, on the server.
-- A pathway has a stable identity (slug, never reused) and versions. A version is an ordered list of steps; each step names
-- an EXACT element set version (never "latest"), so no mutable definition is embedded. A draft version becomes published once
-- and then never changes (the database refuses it, not only the route code). Nothing is ever deleted.
-- Applying a pathway to a case writes one case_applied_pathways row and pins each member set through the existing
-- case_applied_sets rows, which keep a link to that application. Each pin stays independently withdrawable.

/* ---------- pathways ---------- */
CREATE TABLE pathways (
  id         serial PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  title      text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pathway_versions (
  id           serial PRIMARY KEY,
  pathway_id   integer NOT NULL REFERENCES pathways(id),
  version      integer NOT NULL CHECK (version >= 1),
  title        text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  checksum     text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),      -- sha256 of the canonical content (title, description, ordered steps); computed by the server
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_by   integer NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_by integer REFERENCES users(id),
  published_at timestamptz,
  retired_by   integer REFERENCES users(id),
  retired_at   timestamptz,
  UNIQUE (pathway_id, version),
  UNIQUE (id, pathway_id),
  CHECK (status = 'draft' OR (published_by IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (status <> 'retired' OR (retired_by IS NOT NULL AND retired_at IS NOT NULL))
);
CREATE INDEX pathway_versions_pathway_idx ON pathway_versions (pathway_id, version DESC);

/* ---------- the ordered members: each names an exact element set version ---------- */
CREATE TABLE pathway_version_steps (
  id                     serial PRIMARY KEY,
  pathway_version_id     integer NOT NULL REFERENCES pathway_versions(id),
  position               integer NOT NULL CHECK (position BETWEEN 1 AND 30),
  element_set_id         integer NOT NULL,
  element_set_version_id integer NOT NULL,
  UNIQUE (pathway_version_id, position),
  UNIQUE (pathway_version_id, element_set_id),                          -- a set appears once per pathway version
  FOREIGN KEY (element_set_version_id, element_set_id) REFERENCES element_set_versions (id, element_set_id)
);

/* ---------- case_applied_pathways: which version of which pathway a case applied (never changes) ---------- */
CREATE TABLE case_applied_pathways (
  id                 serial PRIMARY KEY,
  case_id            integer NOT NULL REFERENCES clinical_cases(id),
  pathway_id         integer NOT NULL,
  pathway_version_id integer NOT NULL,
  applied_by         integer NOT NULL REFERENCES users(id),             -- from the session
  applied_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (pathway_version_id, pathway_id) REFERENCES pathway_versions (id, pathway_id),
  UNIQUE (id, case_id)
);
CREATE INDEX case_applied_pathways_case_idx ON case_applied_pathways (case_id, id);

-- A pin created by a pathway names that application (same case, enforced by the foreign key). Plain pins leave it NULL.
ALTER TABLE case_applied_sets ADD COLUMN from_applied_pathway_id integer;
ALTER TABLE case_applied_sets ADD FOREIGN KEY (from_applied_pathway_id, case_id) REFERENCES case_applied_pathways (id, case_id);

-- The pin guard from migration 011, now also covering the new column: the source of a pin never changes.
CREATE OR REPLACE FUNCTION case_applied_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.element_set_id IS DISTINCT FROM OLD.element_set_id
     OR NEW.element_set_version_id IS DISTINCT FROM OLD.element_set_version_id OR NEW.applied_by IS DISTINCT FROM OLD.applied_by
     OR NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.from_applied_pathway_id IS DISTINCT FROM OLD.from_applied_pathway_id THEN
    RAISE EXCEPTION 'an applied set pin is immutable';
  END IF;
  IF OLD.state <> 'active' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.state_by IS DISTINCT FROM OLD.state_by OR NEW.state_at IS DISTINCT FROM OLD.state_at) THEN
    RAISE EXCEPTION 'a % applied set cannot change again', OLD.state;
  END IF;
  RETURN NEW;
END $$;

-- The clinical timeline gets one more event: a pathway was applied.
ALTER TABLE clinical_events DROP CONSTRAINT clinical_events_event_type_check;
ALTER TABLE clinical_events ADD CONSTRAINT clinical_events_event_type_check
  CHECK (event_type IN ('set_applied','set_upgraded','set_withdrawn','observation_recorded','observation_corrected','observation_entered_in_error','pathway_applied'));

/* ---------- guards (the server code is not the only guard) ---------- */
-- Steps are written once, while the version is a draft, and only for a published set version. They are never changed or removed.
CREATE FUNCTION pathway_step_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pstatus text; sstatus text;
BEGIN
  SELECT status INTO pstatus FROM pathway_versions WHERE id = NEW.pathway_version_id;
  IF pstatus IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'steps can only be added to a draft pathway version'; END IF;
  SELECT status INTO sstatus FROM element_set_versions WHERE id = NEW.element_set_version_id;
  IF sstatus IS DISTINCT FROM 'published' THEN RAISE EXCEPTION 'a pathway step must name a published element set version'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pathway_version_steps_insert_guard BEFORE INSERT ON pathway_version_steps
  FOR EACH ROW EXECUTE FUNCTION pathway_step_insert_guard();

-- A version is published once, with every member still published and at least one member; after that its content never changes.
CREATE FUNCTION pathway_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rank_old int; rank_new int;
BEGIN
  rank_old := CASE OLD.status WHEN 'draft' THEN 1 WHEN 'published' THEN 2 ELSE 3 END;
  rank_new := CASE NEW.status WHEN 'draft' THEN 1 WHEN 'published' THEN 2 ELSE 3 END;
  IF NEW.pathway_id IS DISTINCT FROM OLD.pathway_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pathway version identity is immutable';
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description OR NEW.checksum IS DISTINCT FROM OLD.checksum THEN
    RAISE EXCEPTION 'pathway version content is immutable (add a new version instead)';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'who published a pathway version and when can never be rewritten';
  END IF;
  IF rank_new < rank_old THEN RAISE EXCEPTION 'pathway version status cannot go back from % to %', OLD.status, NEW.status; END IF;
  IF OLD.status = 'draft' AND NEW.status = 'published' THEN
    IF NOT EXISTS (SELECT 1 FROM pathway_version_steps WHERE pathway_version_id = NEW.id) THEN
      RAISE EXCEPTION 'a pathway version needs at least one step to be published';
    END IF;
    IF EXISTS (SELECT 1 FROM pathway_version_steps s JOIN element_set_versions v ON v.id = s.element_set_version_id
                WHERE s.pathway_version_id = NEW.id AND v.status <> 'published') THEN
      RAISE EXCEPTION 'every step must name a published element set version to publish a pathway version';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pathway_versions_guard BEFORE UPDATE ON pathway_versions
  FOR EACH ROW EXECUTE FUNCTION pathway_version_guard();

CREATE FUNCTION pathway_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pathway identity (slug) is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pathways_guard BEFORE UPDATE ON pathways
  FOR EACH ROW EXECUTE FUNCTION pathway_guard();

-- Only a published version can be applied.
CREATE FUNCTION case_applied_pathway_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pstatus text;
BEGIN
  SELECT status INTO pstatus FROM pathway_versions WHERE id = NEW.pathway_version_id;
  IF pstatus IS DISTINCT FROM 'published' THEN RAISE EXCEPTION 'only a published pathway version can be applied to a case'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_applied_pathways_insert_guard BEFORE INSERT ON case_applied_pathways
  FOR EACH ROW EXECUTE FUNCTION case_applied_pathway_insert_guard();

/* ---------- no hard delete, no truncate; steps and applications never change ---------- */
CREATE TRIGGER pathways_no_delete                BEFORE DELETE   ON pathways              FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pathways_no_truncate              BEFORE TRUNCATE ON pathways              FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pathway_versions_no_delete        BEFORE DELETE   ON pathway_versions      FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pathway_versions_no_truncate      BEFORE TRUNCATE ON pathway_versions      FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pathway_version_steps_no_change   BEFORE UPDATE OR DELETE ON pathway_version_steps FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pathway_version_steps_no_truncate BEFORE TRUNCATE ON pathway_version_steps FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_applied_pathways_no_change   BEFORE UPDATE OR DELETE ON case_applied_pathways FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_applied_pathways_no_truncate BEFORE TRUNCATE ON case_applied_pathways FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

/* ---------- grants for emr_app: exactly what pathways.js uses. No DELETE, no TRUNCATE. ---------- */
GRANT SELECT, INSERT ON pathways, pathway_versions, pathway_version_steps, case_applied_pathways TO emr_app;
GRANT UPDATE (title, status, updated_at) ON pathways TO emr_app;
GRANT UPDATE (status, published_by, published_at, retired_by, retired_at) ON pathway_versions TO emr_app;
GRANT USAGE ON SEQUENCE pathways_id_seq, pathway_versions_id_seq, pathway_version_steps_id_seq, case_applied_pathways_id_seq TO emr_app;
