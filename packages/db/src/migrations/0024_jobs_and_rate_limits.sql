-- Postgres-backed job queue and rate limiting. Removes the last reason to run
-- Redis.
--
-- Written by hand rather than generated. drizzle-kit cannot express the three
-- things that make this table a queue instead of a log: the partial indexes
-- that keep the claim query scanning only runnable rows, and the partial
-- UNIQUE that scopes producer idempotency to LIVE jobs so an operator can
-- legitimately re-enqueue a job that has already finished.

CREATE TABLE IF NOT EXISTS "jobs" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "queue"             varchar(64)  NOT NULL,
  "name"              varchar(64)  NOT NULL,
  "payload"           jsonb        DEFAULT '{}'::jsonb NOT NULL,
  "status"            varchar(16)  DEFAULT 'queued' NOT NULL,
  "run_at"            timestamp with time zone DEFAULT now() NOT NULL,
  "attempts"          integer      DEFAULT 0 NOT NULL,
  "max_attempts"      integer      DEFAULT 3 NOT NULL,
  "lease_expires_at"  timestamp with time zone,
  "locked_by"         varchar(128),
  "dedupe_key"        varchar(200),
  "last_error"        text,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"        timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at"      timestamp with time zone,
  CONSTRAINT "jobs_status_check"
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  CONSTRAINT "jobs_attempts_check"
    CHECK ("attempts" >= 0 AND "max_attempts" >= 1)
);--> statement-breakpoint

-- THE claim index. The worker's hot query filters on
--   queue = $1 AND status = 'queued' AND run_at <= now()
-- ordered by run_at. A partial index over that exact predicate means the claim
-- touches only the runnable set, not every job ever enqueued -- which matters
-- because completed rows are retained for the admin DLQ view.
CREATE INDEX IF NOT EXISTS "jobs_claim_idx"
  ON "jobs" ("queue", "run_at") WHERE "status" = 'queued';--> statement-breakpoint

-- Reaper lookup: running jobs whose lease has lapsed.
CREATE INDEX IF NOT EXISTS "jobs_lease_idx"
  ON "jobs" ("lease_expires_at") WHERE "status" = 'running';--> statement-breakpoint

-- Producer idempotency, scoped to LIVE jobs.
--
-- The `status IN ('queued','running')` predicate is the whole point. A plain
-- unique index on (queue, dedupe_key) would make an operator "Retry" impossible
-- forever after the first attempt, which is the same class of mistake as the
-- plain INSERT against files_bucket_objectkey_uq that made transcode retries
-- structurally impossible. Scoped this way, a duplicate enqueue while a job is
-- pending is absorbed, and a deliberate re-run after it finishes is allowed.
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_dedupe_live_uq"
  ON "jobs" ("queue", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "status" IN ('queued', 'running');--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rate_limits" (
  "key"          varchar(256) PRIMARY KEY NOT NULL,
  "window_start" timestamp with time zone DEFAULT now() NOT NULL,
  "count"        integer DEFAULT 0 NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rate_limits_window_idx" ON "rate_limits" ("window_start");--> statement-breakpoint

-- ── Missing indexes on hot FK / filter columns ───────────────────────────────
--
-- Swept together because they share a cause: migration 0018 fixed exactly one
-- such column (mentor_pairings.teacher_id) and the pattern was never applied to
-- the rest. Each of these is a column the application filters or joins on in a
-- request path.
--
-- mentors.user_id / teachers.user_id  -- resolved on every page that maps a
--   signed-in user to their programme record, and now on /admin/users too.
--   `mentors` had no index array at all.
-- observation_cycles.observer_id      -- lib/authz.ts checks it on every cycle
--   access, so it is now on the authorization path for the whole module.
-- video_submissions.file_id           -- NOT NULL FK joined by the DLQ view and
--   by upload completion.
-- resource_subjects.subject_id        -- the composite PK leads with
--   resource_id, so "resources for subject X" could not use it.
-- section_gate_grants.gate_slug       -- the composite index leads with
--   user_id, so gate rotation's delete-by-slug could not use it.
CREATE INDEX IF NOT EXISTS "mentors_user_idx" ON "mentors" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teachers_user_idx" ON "teachers" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observation_cycles_observer_idx" ON "observation_cycles" ("observer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_submissions_file_idx" ON "video_submissions" ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_subjects_subject_idx" ON "resource_subjects" ("subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "section_gate_grants_slug_idx" ON "section_gate_grants" ("gate_slug");
