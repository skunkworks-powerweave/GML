-- Spec 162 — Transcode DLQ admin view (Workflow Run 15 audit-closure MISS).
--
-- Adds the 'dropped' terminal status to transcode_jobs.status so the new
-- /admin/transcode-jobs surface has a real DB-backed verb for "operator
-- saw this permanently failed job and decided not to retry it" — distinct
-- from 'failed' (BullMQ ran out of retries) and 'cancelled' (programmatic
-- abort by the worker).
--
-- Pre-fix the audit-closure plan for the MISS "no admin UI to inspect or
-- retry failed transcode jobs" had two viable shapes:
--
--   1. Reuse 'cancelled' for both worker-abort and operator-drop. Lossy;
--      the audit trail can't tell whether a job was killed by the worker
--      or buried by an operator without joining the audit_log row that
--      records the action.
--   2. Add a NEW 'dropped' status that's reserved for the operator-drop
--      verb. Reads cleanly, joins to the audit row cleanly, and lets
--      future retry queries exclude 'dropped' jobs naturally.
--
-- We chose (2) so the DLQ-admin surface and the BullMQ DLQ stay
-- semantically distinct from the worker's own status tracking. The TS
-- schema (packages/db/src/schema/videos.ts) ships the matching CHECK
-- update so drizzle-kit sees the source as in-sync.
--
-- Migration index sequencing (workflow-coordinated):
--   * 0019 — spec 159 (reserved)
--   * 0020 — spec 161 (reserved)
--   * 0021 — spec 162 (this migration)
--
-- Non-blocking: ALTER ... DROP CONSTRAINT + ADD CONSTRAINT runs in a
-- single transaction on a small table (transcode_jobs is at the
-- per-video-submission granularity, ~hundreds of rows at current scale).
-- No data migration needed — existing rows carry one of the legacy
-- statuses, all of which remain valid under the widened CHECK.
ALTER TABLE "transcode_jobs" DROP CONSTRAINT "transcode_jobs_status_check";--> statement-breakpoint
ALTER TABLE "transcode_jobs"
  ADD CONSTRAINT "transcode_jobs_status_check"
  CHECK ("transcode_jobs"."status" IN ('queued','running','succeeded','failed','cancelled','dropped'));
