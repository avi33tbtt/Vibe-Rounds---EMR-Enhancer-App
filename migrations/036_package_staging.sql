-- Task D6: staging of package imports on the server. A staged package is a list of PROPOSALS for a person to read; nothing here is an element set, a pathway or a clinical record.
-- Stored: the bundle hash, counts, the concept map and the parser's own proposals (plain text, checked in D5). NEVER the raw bundle.
-- Nothing is deleted. A proposal moves staged -> rejected (with a reason) or staged -> accepted (only a READY proposal; D7 and D8 do the accepting). Both are final.
-- Prototype. Synthetic data only. Not for clinical use.

CREATE TABLE package_imports (
  id           serial PRIMARY KEY,
  bundle_hash  text NOT NULL UNIQUE CHECK (bundle_hash ~ '^[0-9a-f]{64}$'),
  summary      jsonb NOT NULL,        -- counts only
  blockers     jsonb NOT NULL DEFAULT '[]'::jsonb,
  concept_map  jsonb NOT NULL DEFAULT '[]'::jsonb,
  staged_by    integer NOT NULL REFERENCES users(id),
  staged_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(summary) = 'object' AND jsonb_typeof(blockers) = 'array' AND jsonb_typeof(concept_map) = 'array')
);

CREATE TABLE package_proposals (
  id            serial PRIMARY KEY,
  import_id     integer NOT NULL REFERENCES package_imports(id),
  key           text NOT NULL CHECK (length(key) BETWEEN 3 AND 80),
  kind          text NOT NULL CHECK (kind IN ('set','pathway')),
  slug          text NOT NULL CHECK (length(slug) BETWEEN 1 AND 80),
  body          jsonb NOT NULL,       -- the parser's proposal as it is
  blockers      jsonb NOT NULL DEFAULT '[]'::jsonb,
  ready         boolean NOT NULL,
  status        text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','rejected','accepted')),
  row_version   integer NOT NULL DEFAULT 1,
  rejected_by   integer REFERENCES users(id),
  rejected_at   timestamptz,
  reject_reason text CHECK (reject_reason IS NULL OR length(btrim(reject_reason)) BETWEEN 1 AND 1000),
  accepted_by   integer REFERENCES users(id),                  -- set by D7 and D8, from the session
  accepted_at   timestamptz,
  accepted_ref  integer,                                       -- the set or pathway made from it (D7, D8)
  UNIQUE (import_id, key),
  CHECK (jsonb_typeof(body) = 'object' AND jsonb_typeof(blockers) = 'array'),
  CHECK (ready = (jsonb_array_length(blockers) = 0)),
  CHECK (status <> 'staged' OR (rejected_by IS NULL AND rejected_at IS NULL AND reject_reason IS NULL AND accepted_by IS NULL AND accepted_at IS NULL AND accepted_ref IS NULL)),
  CHECK (status <> 'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND reject_reason IS NOT NULL AND accepted_by IS NULL AND accepted_at IS NULL AND accepted_ref IS NULL)),
  CHECK (status <> 'accepted' OR (ready AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL AND reject_reason IS NULL))
);
CREATE INDEX package_proposals_import_idx ON package_proposals (import_id, id);

CREATE FUNCTION package_proposal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'staged' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'a proposal starts as staged'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER package_proposals_insert_guard BEFORE INSERT ON package_proposals FOR EACH ROW EXECUTE FUNCTION package_proposal_insert_guard();

-- Only the status move changes a row: staged -> rejected | accepted. Both are final. What was staged never changes.
CREATE FUNCTION package_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.import_id IS DISTINCT FROM OLD.import_id OR NEW.key IS DISTINCT FROM OLD.key OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.slug IS DISTINCT FROM OLD.slug OR NEW.body IS DISTINCT FROM OLD.body OR NEW.blockers IS DISTINCT FROM OLD.blockers OR NEW.ready IS DISTINCT FROM OLD.ready THEN
    RAISE EXCEPTION 'what was staged cannot be changed';
  END IF;
  IF OLD.status <> 'staged' THEN RAISE EXCEPTION 'a proposal that was % is final', OLD.status; END IF;
  IF NEW.status NOT IN ('rejected','accepted') THEN RAISE EXCEPTION 'a staged proposal is rejected or accepted'; END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER package_proposals_guard BEFORE UPDATE ON package_proposals FOR EACH ROW EXECUTE FUNCTION package_proposal_guard();

CREATE TRIGGER package_imports_no_change     BEFORE UPDATE OR DELETE ON package_imports   FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER package_imports_no_truncate   BEFORE TRUNCATE         ON package_imports   FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER package_proposals_no_delete   BEFORE DELETE           ON package_proposals FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER package_proposals_no_truncate BEFORE TRUNCATE         ON package_proposals FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON package_imports, package_proposals TO emr_app;
GRANT UPDATE (status, row_version, rejected_by, rejected_at, reject_reason, accepted_by, accepted_at, accepted_ref) ON package_proposals TO emr_app;
GRANT USAGE ON SEQUENCE package_imports_id_seq, package_proposals_id_seq TO emr_app;
