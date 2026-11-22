-- Task B2a: versioned element sets on the server.
-- A set has a stable identity (slug, never reused) and immutable-once-published versions.
-- Content (definition_json) is declarative data only; sets.js validates it and computes the checksum.
-- Nothing is ever deleted: versions are retired, not removed.

CREATE TABLE element_sets (
  id         serial PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  title      text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  kind       text NOT NULL CHECK (kind IN ('disease','care','template','custom')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE element_set_versions (
  id             serial PRIMARY KEY,
  element_set_id integer NOT NULL REFERENCES element_sets(id),
  version        integer NOT NULL CHECK (version >= 1),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  definition_json jsonb NOT NULL CHECK (jsonb_typeof(definition_json) = 'object'),
  checksum       text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),   -- sha256 of the canonical JSON, computed by the server
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','published','retired')),
  created_by     integer NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_by   integer REFERENCES users(id),
  published_at   timestamptz,
  retired_by     integer REFERENCES users(id),
  retired_at     timestamptz,
  UNIQUE (element_set_id, version),
  CHECK (status NOT IN ('published','retired') OR (published_by IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (status <> 'retired' OR (retired_by IS NOT NULL AND retired_at IS NOT NULL))
);
CREATE INDEX element_set_versions_set_idx ON element_set_versions (element_set_id, version DESC);

-- Immutability, enforced in the database (the server code is not the only guard):
--  * once a version is published (or retired) its content, checksum, identity and creator can never change;
--  * status only moves forward: draft -> reviewed -> published -> retired;
--  * who published and when can never be rewritten.
CREATE FUNCTION element_set_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_old int; rank_new int;
BEGIN
  rank_old := CASE OLD.status WHEN 'draft' THEN 1 WHEN 'reviewed' THEN 2 WHEN 'published' THEN 3 ELSE 4 END;
  rank_new := CASE NEW.status WHEN 'draft' THEN 1 WHEN 'reviewed' THEN 2 WHEN 'published' THEN 3 ELSE 4 END;
  IF NEW.element_set_id IS DISTINCT FROM OLD.element_set_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'element set version identity is immutable';
  END IF;
  IF OLD.status IN ('published','retired') AND (
       NEW.definition_json IS DISTINCT FROM OLD.definition_json OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'a published element set version is immutable';
  END IF;
  IF rank_new < rank_old THEN
    RAISE EXCEPTION 'element set version status cannot go back from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER element_set_versions_guard BEFORE UPDATE ON element_set_versions
  FOR EACH ROW EXECUTE FUNCTION element_set_version_guard();

-- The set's identity never changes after creation (title and status do, by publish and retire).
CREATE FUNCTION element_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'element set identity (slug, kind) is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER element_sets_guard BEFORE UPDATE ON element_sets
  FOR EACH ROW EXECUTE FUNCTION element_set_guard();

-- No hard delete, no truncate, for anyone.
CREATE TRIGGER element_sets_no_delete          BEFORE DELETE   ON element_sets         FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER element_sets_no_truncate        BEFORE TRUNCATE ON element_sets         FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER element_set_versions_no_delete  BEFORE DELETE   ON element_set_versions FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER element_set_versions_no_truncate BEFORE TRUNCATE ON element_set_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Grants for emr_app: exactly what sets.js uses. No DELETE, no TRUNCATE.
-- UPDATE is limited to the columns that publish and retire change; content columns can never be updated by the app.
GRANT SELECT, INSERT ON element_sets, element_set_versions TO emr_app;
GRANT UPDATE (title, status, updated_at) ON element_sets TO emr_app;
GRANT UPDATE (status, published_by, published_at, retired_by, retired_at) ON element_set_versions TO emr_app;
GRANT USAGE ON SEQUENCE element_sets_id_seq, element_set_versions_id_seq TO emr_app;
