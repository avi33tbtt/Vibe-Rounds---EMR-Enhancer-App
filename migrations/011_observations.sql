-- Task B3a: applied sets (the version pin), observations and clinical events, on the server.
-- A case pins the EXACT published element-set version it applied (case_applied_sets). Observations are append-only:
-- a value is never overwritten; a correction is a new row (corrects_id) and a wrong entry is marked entered_in_error (row kept, who and when).
-- clinical_events is the clinical timeline (apply, upgrade, withdraw, record, correct, entered in error); it is separate from the security audit_log.
-- The database refuses the rewrites itself, so the rules do not rest on the route code alone. Nothing is ever deleted.

-- Lets an applied-set row prove in the database that the version belongs to the set it names.
ALTER TABLE element_set_versions ADD CONSTRAINT element_set_versions_id_set_uq UNIQUE (id, element_set_id);

/* ---------- case_applied_sets: which version of which set a case applied ---------- */
CREATE TABLE case_applied_sets (
  id                     serial PRIMARY KEY,
  case_id                integer NOT NULL REFERENCES clinical_cases(id),
  element_set_id         integer NOT NULL,
  element_set_version_id integer NOT NULL,
  state                  text NOT NULL DEFAULT 'active' CHECK (state IN ('active','superseded','withdrawn')),
  applied_by             integer NOT NULL REFERENCES users(id),
  applied_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  supersedes_id          integer REFERENCES case_applied_sets(id),     -- set when this row is an explicit update of an earlier pin
  state_by               integer REFERENCES users(id),                 -- who superseded or withdrew it
  state_at               timestamptz,
  FOREIGN KEY (element_set_version_id, element_set_id) REFERENCES element_set_versions (id, element_set_id),
  UNIQUE (id, case_id),
  CHECK ((state = 'active' AND state_by IS NULL AND state_at IS NULL) OR (state <> 'active' AND state_by IS NOT NULL AND state_at IS NOT NULL))
);
-- One active pin per set per case; a pin has at most one successor.
CREATE UNIQUE INDEX case_applied_sets_one_active_uq ON case_applied_sets (case_id, element_set_id) WHERE state = 'active';
CREATE UNIQUE INDEX case_applied_sets_successor_uq  ON case_applied_sets (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX case_applied_sets_case_idx ON case_applied_sets (case_id, id);

CREATE FUNCTION case_applied_set_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vstatus text; prev record;
BEGIN
  SELECT status INTO vstatus FROM element_set_versions WHERE id = NEW.element_set_version_id;
  IF vstatus IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'only a published element set version can be applied to a case';
  END IF;
  IF NEW.state <> 'active' THEN RAISE EXCEPTION 'a new applied set starts active'; END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT case_id, element_set_id, state INTO prev FROM case_applied_sets WHERE id = NEW.supersedes_id;
    IF NOT FOUND OR prev.case_id <> NEW.case_id OR prev.element_set_id <> NEW.element_set_id OR prev.state <> 'superseded' THEN
      RAISE EXCEPTION 'an update must replace a superseded pin of the same set in the same case';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_applied_sets_insert_guard BEFORE INSERT ON case_applied_sets
  FOR EACH ROW EXECUTE FUNCTION case_applied_set_insert_guard();

-- The pin never changes. Only the one-way move out of 'active' (superseded or withdrawn), with who and when.
CREATE FUNCTION case_applied_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.element_set_id IS DISTINCT FROM OLD.element_set_id
     OR NEW.element_set_version_id IS DISTINCT FROM OLD.element_set_version_id OR NEW.applied_by IS DISTINCT FROM OLD.applied_by
     OR NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'an applied set pin is immutable';
  END IF;
  IF OLD.state <> 'active' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.state_by IS DISTINCT FROM OLD.state_by OR NEW.state_at IS DISTINCT FROM OLD.state_at) THEN
    RAISE EXCEPTION 'a % applied set cannot change again', OLD.state;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_applied_sets_guard BEFORE UPDATE ON case_applied_sets
  FOR EACH ROW EXECUTE FUNCTION case_applied_set_guard();

/* ---------- observations: append-only ---------- */
CREATE TABLE observations (
  id             bigserial PRIMARY KEY,
  case_id        integer NOT NULL REFERENCES clinical_cases(id),
  applied_set_id integer NOT NULL,
  field_key      text NOT NULL CHECK (field_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),   -- the field id inside the pinned version
  value_type     text NOT NULL CHECK (value_type IN ('text','number','integer','boolean','datetime','select','unknown')),
  value_json     jsonb,                                                                   -- NULL only when value_type = 'unknown' (explicitly unknown, never coerced)
  unit_code      text,                                                                    -- stays NULL until a server-side terminology verifier exists
  unit_display   text CHECK (unit_display IS NULL OR length(unit_display) BETWEEN 1 AND 40),
  effective_at   timestamptz NOT NULL,                                                    -- when it was true clinically
  recorded_at    timestamptz NOT NULL DEFAULT clock_timestamp(),                          -- when it was entered; set by the server
  source_type    text NOT NULL CHECK (source_type IN ('patient','clinician','imported','device','derived','ai_proposed')),
  source_ref     text CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 200),
  status         text NOT NULL CHECK (status IN ('preliminary','final','amended','entered_in_error')),
  recorded_by    integer NOT NULL REFERENCES users(id),                                   -- from the session, never from a body
  corrects_id    bigint REFERENCES observations(id),
  change_reason  text CHECK (change_reason IS NULL OR length(btrim(change_reason)) BETWEEN 1 AND 1000),
  error_by       integer REFERENCES users(id),
  error_at       timestamptz,
  error_reason   text CHECK (error_reason IS NULL OR length(btrim(error_reason)) BETWEEN 1 AND 1000),
  FOREIGN KEY (applied_set_id, case_id) REFERENCES case_applied_sets (id, case_id),
  CHECK ((value_type = 'unknown') = (value_json IS NULL)),
  CHECK (value_json IS NULL
         OR (value_type IN ('number','integer') AND jsonb_typeof(value_json) = 'number')
         OR (value_type IN ('text','select','datetime') AND jsonb_typeof(value_json) = 'string')
         OR (value_type = 'boolean' AND jsonb_typeof(value_json) = 'boolean')),
  CHECK (value_type <> 'integer' OR value_json IS NULL OR value_json::text ~ '^-?[0-9]+$'),
  CHECK (unit_display IS NULL OR value_type IN ('number','integer')),
  -- a correction is the only row with status 'amended' and the only row with a reason
  CHECK (status = 'entered_in_error' OR ((corrects_id IS NULL) = (status <> 'amended'))),
  CHECK ((corrects_id IS NULL) = (change_reason IS NULL)),
  -- an AI proposal is never a final clinical fact; a person records a new row (source clinician) to confirm it
  CHECK (source_type <> 'ai_proposed' OR status IN ('preliminary','entered_in_error')),
  CHECK ((status = 'entered_in_error' AND error_by IS NOT NULL AND error_at IS NOT NULL AND error_reason IS NOT NULL)
      OR (status <> 'entered_in_error' AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL))
);
-- A row is corrected at most once (the chain stays a line); this also settles two people correcting the same row at once.
CREATE UNIQUE INDEX observations_one_correction_uq ON observations (corrects_id) WHERE corrects_id IS NOT NULL;
CREATE INDEX observations_case_time_idx  ON observations (case_id, effective_at, id);
CREATE INDEX observations_field_idx      ON observations (applied_set_id, field_key, recorded_at);

CREATE FUNCTION observation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE astate text; aset integer; orig record; oset integer;
BEGIN
  IF NEW.status = 'entered_in_error' THEN RAISE EXCEPTION 'an observation is entered in error by marking an existing row, not by inserting one'; END IF;
  SELECT state, element_set_id INTO astate, aset FROM case_applied_sets WHERE id = NEW.applied_set_id;
  IF NEW.corrects_id IS NULL THEN
    IF astate IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'values can only be added under an active applied set'; END IF;
  ELSE
    SELECT o.case_id, o.field_key, o.status, a.element_set_id INTO orig
      FROM observations o JOIN case_applied_sets a ON a.id = o.applied_set_id WHERE o.id = NEW.corrects_id;
    IF NOT FOUND OR orig.case_id <> NEW.case_id OR orig.field_key <> NEW.field_key OR orig.element_set_id <> aset THEN
      RAISE EXCEPTION 'a correction must be for the same case, set and field as the row it corrects';
    END IF;
    IF orig.status = 'entered_in_error' THEN RAISE EXCEPTION 'a row entered in error cannot be corrected'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observations_insert_guard BEFORE INSERT ON observations
  FOR EACH ROW EXECUTE FUNCTION observation_insert_guard();

-- No UPDATE of any value, time, source or actor column. The one allowed change is the one-way move to entered_in_error (with who, when and why).
CREATE FUNCTION observation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'error_by' - 'error_at' - 'error_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'error_by' - 'error_at' - 'error_reason') THEN
    RAISE EXCEPTION 'observations are append-only: values, times, sources and actors cannot be changed (add a correction row instead)';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'an observation entered in error cannot change again'; END IF;
  IF NEW.status <> 'entered_in_error' THEN RAISE EXCEPTION 'the only status change allowed is to entered_in_error'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observations_guard BEFORE UPDATE ON observations
  FOR EACH ROW EXECUTE FUNCTION observation_guard();

/* ---------- clinical_events: the clinical timeline (append-only) ---------- */
CREATE TABLE clinical_events (
  id           bigserial PRIMARY KEY,
  case_id      integer NOT NULL REFERENCES clinical_cases(id),
  encounter_id integer,                                   -- the case's open linked encounter at that moment, if there was one
  event_type   text NOT NULL CHECK (event_type IN ('set_applied','set_upgraded','set_withdrawn','observation_recorded','observation_corrected','observation_entered_in_error')),
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id     integer NOT NULL REFERENCES users(id),     -- from the session
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),   -- ids and counts only, never values
  FOREIGN KEY (case_id, encounter_id) REFERENCES case_encounters (case_id, encounter_id)
);
CREATE INDEX clinical_events_case_idx ON clinical_events (case_id, id DESC);

/* ---------- no hard delete, no truncate, for anyone ---------- */
CREATE TRIGGER case_applied_sets_no_delete   BEFORE DELETE   ON case_applied_sets FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_applied_sets_no_truncate BEFORE TRUNCATE ON case_applied_sets FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER observations_no_delete        BEFORE DELETE   ON observations      FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER observations_no_truncate      BEFORE TRUNCATE ON observations      FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER clinical_events_no_change     BEFORE UPDATE OR DELETE ON clinical_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER clinical_events_no_truncate   BEFORE TRUNCATE ON clinical_events   FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

/* ---------- grants for emr_app: exactly what observations.js uses. No DELETE, no TRUNCATE. ---------- */
GRANT SELECT, INSERT ON case_applied_sets, observations, clinical_events TO emr_app;
GRANT UPDATE (state, state_by, state_at) ON case_applied_sets TO emr_app;
GRANT UPDATE (status, error_by, error_at, error_reason) ON observations TO emr_app;
GRANT USAGE ON SEQUENCE case_applied_sets_id_seq, observations_id_seq, clinical_events_id_seq TO emr_app;
