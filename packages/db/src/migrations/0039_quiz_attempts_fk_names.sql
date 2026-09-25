-- Give quiz_attempts' foreign keys the names the schema, and so drizzle-kit,
-- knows them by (F107).
--
-- 0026 was written by hand with inline REFERENCES, so Postgres named the three
-- keys quiz_attempts_<column>_fkey, while every other table carries drizzle's
-- quiz_attempts_<column>_<table>_id_fk -- which is also what the snapshot says.
-- The first generated migration to touch one of these keys (an ON DELETE
-- change, say) would `DROP CONSTRAINT` a name that does not exist and abort the
-- deploy at the migrate step.
--
-- Guarded, so a database that already has drizzle's names is left alone.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('quiz_attempts_quiz_id_fkey',       'quiz_attempts_quiz_id_quizzes_id_fk'),
      ('quiz_attempts_user_id_fkey',       'quiz_attempts_user_id_users_id_fk'),
      ('quiz_attempts_submission_id_fkey', 'quiz_attempts_submission_id_quiz_submissions_id_fk')
    ) AS v(old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.quiz_attempts'::regclass AND conname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conrelid = 'public.quiz_attempts'::regclass AND conname = r.new_name) THEN
      EXECUTE format('ALTER TABLE public.quiz_attempts RENAME CONSTRAINT %I TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END
$$;
