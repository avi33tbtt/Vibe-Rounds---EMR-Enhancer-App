-- Server-side AI (chunk 04b). One settings row; AI is OFF until an admin switches it on.
-- The provider key is NOT stored here: it comes from the server environment (AI_API_KEY).
-- Every change is also written to the append-only audit_log (action 'ai.settings').
CREATE TABLE ai_settings (
  id                    integer PRIMARY KEY CHECK (id = 1),
  enabled               boolean NOT NULL DEFAULT false,
  model                 text,
  hourly_limit_per_user integer NOT NULL DEFAULT 20  CHECK (hourly_limit_per_user BETWEEN 1 AND 500),
  daily_limit_total     integer NOT NULL DEFAULT 200 CHECK (daily_limit_total BETWEEN 1 AND 5000),
  updated_by            integer REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_settings(id) VALUES (1);
