-- 010_code_bindings_multi.sql (Phase P, P2b): a field can carry one binding per code system (for example SNOMED CT and ICD on one field).
-- The key was (set_id, field_id); it becomes (set_id, field_id, system). Existing rows already satisfy the wider key.
ALTER TABLE code_bindings DROP CONSTRAINT code_bindings_pkey;
ALTER TABLE code_bindings ADD PRIMARY KEY (set_id, field_id, system);
