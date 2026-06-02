-- Spec 143 — schema cleanup (Workflow Run 13 audit-closure CRITICAL+HIGH).
--
-- Closes three independent findings from the 7-agent codebase audit in one
-- migration so the schema invariants tighten atomically:
--
--   1. observation_evidence.video_submission_id was declared at the TS layer
--      (packages/db/src/schema/observation.ts) but the migration ledger never
--      wrote the FK. The column existed but the DB had no referential check,
--      so a programming error in the upload pipeline could insert a row whose
--      video_submission_id pointed to a row that didn't exist (or had been
--      cascade-deleted). Silent orphans broke the cycle-detail page's join
--      query — it returned NULL captions where it should have returned a
--      "video removed" sentinel. ON DELETE SET NULL preserves the evidence
--      row's audit value (the caption + cycle linkage) when the underlying
--      video is purged, mirroring how observation_cycles.observerId handles
--      the same race.
--
--   2. transcode_jobs.profile CHECK constraint accepted BOTH '480p' and
--      '720p', but spec 041 dropped 720p when the SM-4 anti-download
--      contract narrowed the rendition tier to a single low-bitrate stream.
--      The schema check was never updated, so a bug in the worker or a
--      hand-rolled test fixture could write '720p' and the DB would happily
--      store it — contradicting the SM-4 documented invariant. Drop and
--      re-add the constraint with the tightened CHECK '480p' ONLY.
--
--   3. system_settings singleton bootstrap was racing: migration 0015 INSERTs
--      the well-known sentinel row '00000000-…-001' with ON CONFLICT DO
--      NOTHING, AND packages/db/src/scripts/seed.ts also INSERTed it via
--      bootstrapSystemSettings(). On simultaneous first-deploy runs (e.g.
--      docker-compose `up -d` where migrate and seed start in parallel) the
--      two writers raced on the unique PK. Resolution: keep ONLY migration
--      0015's INSERT (single source of truth, runs once on bootstrap, is
--      idempotent on re-runs). The seed-side helper has been removed from
--      packages/db/src/scripts/seed.ts. No DDL change here for issue (3) —
--      the seed deletion is a code-level fix that needs no SQL.

-- ── (1) Add the missing FK on observation_evidence.video_submission_id ────────
-- Constraint name matches drizzle's auto-generated convention
-- ({table}_{column}_{ref_table}_{ref_column}_fk) so future `drizzle-kit generate`
-- runs see the schema as in-sync and don't emit a spurious rename.
ALTER TABLE "observation_evidence"
  ADD CONSTRAINT "observation_evidence_video_submission_id_video_submissions_id_fk"
  FOREIGN KEY ("video_submission_id")
  REFERENCES "public"."video_submissions"("id")
  ON DELETE set null
  ON UPDATE no action;--> statement-breakpoint

-- ── (2) Tighten the transcode_jobs.profile CHECK to '480p' only ───────────────
ALTER TABLE "transcode_jobs" DROP CONSTRAINT "transcode_jobs_profile_check";--> statement-breakpoint
ALTER TABLE "transcode_jobs"
  ADD CONSTRAINT "transcode_jobs_profile_check"
  CHECK ("transcode_jobs"."profile" IN ('480p'));
