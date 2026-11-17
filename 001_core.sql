-- 001_core.sql  (chunk 27)  PostgreSQL 13+ (gen_random_uuid is built in)
-- Every prototype localStorage item has a home here. See the mapping table at the end.
--
-- WHY case_rows IS SEPARATE FROM case_values
--   case_values holds ONE value per key (a scalar field, a reference range, a protocol echo):
--   last writer is detected with a version and a 409. A repeat group (vitals, fever, insulin
--   log, I/O) is a growing list written by several people. If the list lived inside one
--   value, two nurses adding a reading at the same moment would collide on the same record
--   and one would be rejected or overwritten. One row per reading means appends never touch
--   each other, each reading is edited and marked "entered in error" on its own, and who
--   entered it and when is recorded per reading.

-- ---------------------------------------------------------------- users (placeholder; auth in chunk 32)
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             text NOT NULL,
  name                 text NOT NULL,
  password_hash        text,                       -- NULL until chunk 32; never a plain password
  role                 text NOT NULL DEFAULT 'viewer'
                       CHECK (role IN ('admin','doctor','nurse','informatician','viewer')),
  active               boolean NOT NULL DEFAULT true,
  failed_logins        int NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until         timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));

-- ---------------------------------------------------------------- patients and encounters (minimal; full in chunk 34)
CREATE TABLE patients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn             text NOT NULL,                   -- server-generated in chunk 34
  name            text NOT NULL,
  sex             text CHECK (sex IN ('female','male','other','unknown')),
  date_of_birth   date,
  age_estimated   boolean NOT NULL DEFAULT false,
  phone           text,
  national_id     text,                            -- separate nullable column
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mrn)
);
CREATE TABLE encounters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  uuid NOT NULL REFERENCES patients(id),
  type        text NOT NULL CHECK (type IN ('admission','OPD','emergency')),
  start_at    timestamptz NOT NULL DEFAULT now(),
  end_at      timestamptz,
  ward        text,
  bed         text,
  attending   uuid REFERENCES users(id),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  CHECK (end_at IS NULL OR end_at >= start_at)
);
CREATE INDEX encounters_patient_ix ON encounters (patient_id);
CREATE INDEX encounters_ward_ix ON encounters (ward, status);

-- ---------------------------------------------------------------- cases
CREATE TABLE cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text,                              -- prototype case id, used for idempotent import (chunk 31)
  patient_id    uuid REFERENCES patients(id),      -- NULL only for Demo/import until chunk 34
  encounter_id  uuid REFERENCES encounters(id),
  demo_patient  jsonb,                             -- prototype case.patient {name,ageSex,bed,mrn}; replaced in chunk 34
  narrative     text NOT NULL DEFAULT '',          -- legacy bridge for FHIR; notes live in case_notes
  applied       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(applied) = 'array'),
  pathways      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(pathways) = 'array'),
  pinned        jsonb CHECK (pinned IS NULL OR jsonb_typeof(pinned) = 'array'),
  alert_log     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(alert_log) = 'array'),  -- moves to alert_acks in chunk 35
  version       int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (patient_id IS NOT NULL OR demo_patient IS NOT NULL OR legacy_id IS NOT NULL)
);
CREATE UNIQUE INDEX cases_legacy_uq ON cases (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX cases_patient_ix ON cases (patient_id);
CREATE INDEX cases_encounter_ix ON cases (encounter_id);

-- one value per key: 'setId/fieldId', 'setId/__ref', 'setId/__protocol'
CREATE TABLE case_values (
  case_id     uuid NOT NULL REFERENCES cases(id),
  key         text NOT NULL CHECK (key ~ '^[^/[:space:]]+/.+$' AND length(key) <= 200),
  value       jsonb NOT NULL,
  version     int NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, key)
);

-- repeat-group rows: appended and edited independently (see header)
CREATE TABLE case_rows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases(id),
  set_id        text NOT NULL,
  group_id      text NOT NULL,
  row           jsonb NOT NULL CHECK (jsonb_typeof(row) = 'object'),   -- {fieldId: value}, exactly as the app shapes it
  row_time      timestamptz,                       -- NULL when the typed timestamp is invalid; the row is still kept
  version       int NOT NULL DEFAULT 1 CHECK (version >= 1),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','entered_in_error')),
  error_reason  text,
  entered_by    uuid REFERENCES users(id),
  entered_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'active' OR length(btrim(coalesce(error_reason,''))) > 0)  -- a reason is required
);
CREATE INDEX case_rows_lookup_ix ON case_rows (case_id, set_id, group_id, row_time);

-- notes (chunk 25D): draft, signed, amended; never overwritten or deleted
CREATE TABLE case_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases(id),
  type        text NOT NULL CHECK (type IN ('narrative','template','disease')),
  set_id      text,
  text        text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  signed_by   uuid REFERENCES users(id),
  signed_at   timestamptz,
  amends_id   uuid REFERENCES case_notes(id),
  reason      text,
  version     int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR (signed_by IS NOT NULL AND signed_at IS NOT NULL)),
  CHECK (amends_id IS NULL OR length(btrim(coalesce(reason,''))) > 0)      -- an amendment needs a reason
);
CREATE INDEX case_notes_case_ix ON case_notes (case_id, created_at);

-- ---------------------------------------------------------------- element sets, pathways, packages
CREATE TABLE element_sets (
  set_id        text NOT NULL,
  version       int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  kind          text NOT NULL CHECK (kind IN ('care','template','disease','custom','pathway')),
  body          jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  source        text NOT NULL DEFAULT 'user' CHECK (source IN ('seed','user','marketplace')),
  read_only     boolean NOT NULL DEFAULT false,    -- true for marketplace content; API refuses PATCH/DELETE
  tier          text NOT NULL DEFAULT 'local-draft'
                CHECK (tier IN ('marketplace-verified','local-reviewed','local-draft')),
  content_hash  text,
  forked_from   jsonb,
  package       jsonb,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (set_id, version),
  CHECK (source <> 'marketplace' OR read_only)
);
CREATE VIEW element_sets_latest AS
  SELECT DISTINCT ON (set_id) * FROM element_sets ORDER BY set_id, version DESC;

-- Phase 6 tables, created now so no later migration is needed
CREATE TABLE installed_packages (
  package_id    text NOT NULL,
  version       text NOT NULL,
  content_hash  text NOT NULL,
  registry_url  text,
  signature_ok  boolean NOT NULL DEFAULT false,
  installed_by  uuid REFERENCES users(id),
  installed_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','withdrawn')),
  PRIMARY KEY (package_id, version)
);
CREATE TABLE review_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id       text NOT NULL,
  set_version  int NOT NULL,
  author_id    uuid NOT NULL REFERENCES users(id),
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','submitted','in_review','changes_requested','approved','rejected')),
  checklist    jsonb NOT NULL DEFAULT '{}',
  reviewer_id  uuid REFERENCES users(id),
  decided_at   timestamptz,
  comment      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (reviewer_id IS NULL OR reviewer_id <> author_id)    -- never review your own draft
);
CREATE TABLE review_events (                                  -- append-only
  id          bigserial PRIMARY KEY,
  request_id  uuid NOT NULL REFERENCES review_requests(id),
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users(id),
  event       text NOT NULL,
  detail      jsonb
);

-- ---------------------------------------------------------------- per-user, reference data, rules, protocols
CREATE TABLE set_usage (
  user_id    uuid NOT NULL REFERENCES users(id),
  set_id     text NOT NULL,
  count      int  NOT NULL DEFAULT 0 CHECK (count >= 0),
  last_used  timestamptz,
  with_dx    jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, set_id)
);
CREATE TABLE user_prefs (
  user_id  uuid NOT NULL REFERENCES users(id),
  key      text NOT NULL CHECK (length(key) <= 100),
  value    jsonb NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE verified_codes (
  system    text NOT NULL,
  code      text NOT NULL,
  display   text NOT NULL,
  verified_live jsonb,                              -- result of the 'Verify live' lookup, if run
  added_by  uuid REFERENCES users(id),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system, code)
);
CREATE TABLE code_bindings (
  set_id    text NOT NULL,
  field_id  text NOT NULL,
  system    text NOT NULL,
  code      text NOT NULL,
  display   text NOT NULL,
  PRIMARY KEY (set_id, field_id)
);

CREATE TABLE cds_rules (
  owner_set_id      text NOT NULL,
  rule_id           text NOT NULL,
  body              jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  enabled           boolean NOT NULL DEFAULT false,
  verified_by_user  uuid REFERENCES users(id),
  verified_at       timestamptz,
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai-drafted','package')),
  version           int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_set_id, rule_id),
  -- safety: a rule can only be enabled when an approver and time are recorded
  CHECK (NOT enabled OR (verified_by_user IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE TABLE protocols (                            -- sliding-scale bands; ships EMPTY, typed by clinicians
  set_id            text PRIMARY KEY,
  body              jsonb NOT NULL DEFAULT '{}',
  verified_by_user  uuid REFERENCES users(id),
  verified_at       timestamptz,
  version           int NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE alert_acks (                           -- written from chunk 35
  id        bigserial PRIMARY KEY,
  case_id   uuid NOT NULL REFERENCES cases(id),
  rule_id   text NOT NULL,
  set_id    text NOT NULL,
  sig       text NOT NULL,                          -- changes when the rule is edited, so old acks stop counting
  user_id   uuid NOT NULL REFERENCES users(id),
  acked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_acks_case_ix ON alert_acks (case_id, rule_id, set_id);

-- ---------------------------------------------------------------- audit and imports
CREATE TABLE audit_log (                            -- append-only (written from chunk 33)
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,                                 -- no FK: the log must outlive any user change; NULL for failed logins
  role        text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  patient_id  uuid,
  before      jsonb,
  after       jsonb,
  reason      text,
  ip          text
);
CREATE INDEX audit_log_at_ix ON audit_log (at);
CREATE INDEX audit_log_patient_ix ON audit_log (patient_id, at);
CREATE INDEX audit_log_user_ix ON audit_log (user_id, at);

CREATE TABLE imports (                              -- written from chunk 31
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  source      text NOT NULL DEFAULT 'browser',
  status      text NOT NULL CHECK (status IN ('dry_run','committed','failed')),
  counts      jsonb NOT NULL DEFAULT '{}',
  report      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- append-only guard for the tables that must never change after insert.
-- (Chunk 33 additionally revokes UPDATE/DELETE from the app database role.)
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501'; END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER review_events_append_only BEFORE UPDATE OR DELETE ON review_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- localStorage key -> destination
--  cases                        -> cases + case_values + case_rows + case_notes (imported in chunk 31)
--  sets                         -> element_sets (source 'user'; saving again = new version)
--  setUsage                     -> set_usage (per user)
--  pinned                       -> cases.pinned (per case) and user_prefs 'pinned' (default)
--  codes                        -> verified_codes
--  binds                        -> code_bindings
--  protocols                    -> protocols
--  rules                        -> cds_rules (imported disabled, approval cleared)
--  mypts                        -> user_prefs 'mypts'
--  emrDensity                   -> user_prefs 'density' (may also stay in the browser)
--  cases_backup_v1..v5          -> not migrated; read once by the importer, then 'Clear browser copy'
--  cases_corrupt                -> not migrated; stays in browser until the person clears it
--  chk                          -> stays in browser (UI checklist state)
--  set                          -> API key removed (server env, chunk 36); Demo-mode flag stays in browser
--  proxy                        -> removed (AI proxy is the server, chunk 36)
-- ---------------------------------------------------------------------------
