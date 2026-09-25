-- One login is linked to at most one teacher record and one mentor record.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
--
-- Nothing enforced it. /admin/users "Link to" ran UPDATE ... SET user_id =
-- <new> WHERE id = <record> without checking the record was unlinked, so two
-- admins onboarding the same roster re-pointed a record linked moments
-- earlier; and a grid edit or a CSV import could link two teacher rows to one
-- login. lib/visibility.ts resolves a signed-in teacher with
-- `WHERE user_id = me LIMIT 1` and no ORDER BY, so which record -- whose
-- cycles, whose pairings -- that person saw was arbitrary.
--
-- ── EXISTING DUPLICATES ──────────────────────────────────────────────────────
--
-- A deployment may already hold some. The index cannot be built over them, and
-- refusing to migrate would stop `docker compose up`. So, per login, the
-- OLDEST record (created_at, then id) keeps the link and the others are
-- unlinked -- the same record a stable "first one" would have picked, and the
-- unlinked rows stay on the roster, visible under "Awaiting an account" to be
-- linked correctly. Each one is reported with RAISE NOTICE in the migrate log.
--
-- Partial (WHERE user_id IS NOT NULL): roster rows nobody has an account for
-- yet stay unlimited.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, user_id FROM (
      SELECT id, user_id, row_number() OVER (PARTITION BY user_id ORDER BY created_at, id) AS n
      FROM teachers WHERE user_id IS NOT NULL
    ) d WHERE n > 1
  LOOP
    RAISE NOTICE 'teachers %: unlinked from login % (another teacher record already holds it)', r.id, r.user_id;
    UPDATE teachers SET user_id = NULL WHERE id = r.id;
  END LOOP;
  FOR r IN
    SELECT id, user_id FROM (
      SELECT id, user_id, row_number() OVER (PARTITION BY user_id ORDER BY created_at, id) AS n
      FROM mentors WHERE user_id IS NOT NULL
    ) d WHERE n > 1
  LOOP
    RAISE NOTICE 'mentors %: unlinked from login % (another mentor record already holds it)', r.id, r.user_id;
    UPDATE mentors SET user_id = NULL WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teachers_user_id_uq" ON "teachers" USING btree ("user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mentors_user_id_uq" ON "mentors" USING btree ("user_id") WHERE "user_id" IS NOT NULL;
