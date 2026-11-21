-- 43b4: a review request can be 'withdrawn' (a newer version of the set was saved).
-- Adds 'withdrawn' to the existing status CHECK on review_requests without restating the other values.
DO $$
DECLARE c record; def text;
BEGIN
  FOR c IN SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
           WHERE conrelid = 'review_requests'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%submitted%'
  LOOP
    IF c.d LIKE '%withdrawn%' THEN CONTINUE; END IF;
    def := replace(c.d, '''submitted''::text', '''submitted''::text, ''withdrawn''::text');
    IF def = c.d THEN RAISE EXCEPTION 'review_requests status CHECK has an unexpected form: %', c.d; END IF;
    EXECUTE format('ALTER TABLE review_requests DROP CONSTRAINT %I', c.conname);
    EXECUTE format('ALTER TABLE review_requests ADD CONSTRAINT %I %s', c.conname, def);
  END LOOP;
END $$;
