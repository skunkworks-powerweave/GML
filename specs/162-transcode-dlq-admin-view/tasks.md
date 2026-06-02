# Tasks 162

- [x] T1 → author the governance test (red) covering:
  - All five spec-kit files exist under `specs/162-transcode-dlq-admin-view/`.
  - plan.md follows the CREATED/EDITED/MIGRATED contract and calls
    out the page, the actions file, and the 0021 migration.
  - `apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx`
    is a server component (no `'use client'`), opt-out of caching via
    `export const dynamic = "force-dynamic"`.
  - Page calls `requireRole(["programme_admin","super_admin"])`.
  - Page queries `transcode_jobs` joined to `video_submissions`.
  - Page calls `transcodeQueue.getJobCounts` for the live depth.
  - Page renders the five filter pills and the action buttons.
  - `actions.ts` declares `"use server"`, exports both
    `retryTranscodeJobAction` + `dropTranscodeJobAction`, both gated
    on `programme_admin + super_admin`, both record their respective
    `transcode.retry_requested` / `transcode.dropped` audit rows.
  - Retry action calls `transcodeQueue.add` with the five-field
    payload.
  - Drop action updates `transcode_jobs.status='dropped'`.
  - Schema declares `'dropped'` in the CHECK constraint.
  - Migration 0021 file exists with the DROP + ADD CONSTRAINT
    sequence.
  - Admin index page links to `/admin/transcode-jobs`.
  Run suite → red.
- [x] T2 → edit `packages/db/src/schema/videos.ts`: widen the
  `transcode_jobs_status_check` CHECK constraint to include
  `'dropped'`. Inline spec-162 comment explains the operator-verb
  semantics distinct from `cancelled`.
  Run scoped governance test → schema assertion green.
- [x] T3 → create `packages/db/src/migrations/0021_transcode_jobs_dropped_status.sql`:
  DROP + ADD `transcode_jobs_status_check`. Header comment links to
  the spec and explains the workflow-coordinated index sequencing
  (0019 / 0020 reserved, 0021 mine).
  Run scoped governance test → migration assertion green.
- [x] T4 → create `apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx`:
  server component, role gate, surface-view audit, getJobCounts
  top strip with try/catch for Redis-down, URL-driven filter pills,
  table joining transcode_jobs ⨝ video_submissions with attempts
  count, Retry + Drop forms on failed rows only.
  Run scoped governance test → page assertions green.
- [x] T5 → create `apps/web/src/app/(authenticated)/admin/transcode-jobs/actions.ts`:
  `"use server"`, retryTranscodeJobAction + dropTranscodeJobAction
  both gated, both validate `status='failed'`, retry re-enqueues
  with the five-field payload + records audit, drop sets
  `status='dropped'` + flips parent submission to `failed` +
  records audit.
  Run scoped governance test → actions assertions green.
- [x] T6 → edit `apps/web/src/app/(authenticated)/admin/page.tsx`:
  add the System-section link to `/admin/transcode-jobs`.
  Run scoped governance test → admin-index assertion green.
- [x] T7 → author all five spec-kit files
  (`spec.md`, `plan.md`, `research.md`, `quickstart.md`,
  `tasks.md`) under `specs/162-transcode-dlq-admin-view/`.
- [x] T8 → run the full governance suite. Confirm no regression —
  the migration is non-destructive and the new route is opt-in
  (no other page reaches into the modified files).
- [ ] T9 (future, out of scope) → Bulk-action support
  ("retry all failed in the last 24h"). At current scale (~tens
  of failures per quarter) the per-row UX is enough; revisit if
  operators report toil.
- [ ] T10 (future, out of scope) → DLQ entry deletion from Redis.
  The current `removeOnFail age:7d` policy ages out Redis entries
  naturally; a manual "purge from Redis" button would be a tighter
  feedback loop but adds an ioredis-DEL call site we don't need
  today.
- [ ] T11 (future, out of scope) → Replace the read-side with Bull
  Board if programme staff need raw queue introspection (job
  history, BullMQ-side retries, manifest). Out of scope here
  because Bull Board needs its own auth and route mount, and the
  DB row + audit story is enough for the operator decisions we
  ship today.
