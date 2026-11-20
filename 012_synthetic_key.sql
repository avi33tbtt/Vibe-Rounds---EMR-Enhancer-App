-- Marks a patient as synthetic demo data. Set only by seed-demo.js (direct SQL), never by a route.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS synthetic_key text;
CREATE UNIQUE INDEX IF NOT EXISTS patients_synthetic_key_uq ON patients (synthetic_key) WHERE synthetic_key IS NOT NULL;
