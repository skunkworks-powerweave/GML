# Spec 143 — Schema cleanup: FK + CHECK tightening + singleton bootstrap deduplication

(Workflow Run 13 audit-closure CRITICAL+HIGH)

## Why

The 7-agent codebase audit at the close of Workflow Run 12 surfaced
three independent schema-correctness findings that all sit at the
boundary between the Drizzle TypeScript declarations and the SQL
migration ledger. Each is small in isolation; each is a real
correctness bug whose fix is mechanical. Bundling them into a single
migration (0016_schema_cleanup) lets the schema invariants tighten
atomically and keeps the migration ledger short.

### Finding 1 (CRITICAL) — `observation_evidence.video_submission_id` had no FK

`packages/db/src/schema/observation.ts` (lines 53-63) declared
`videoSubmissionId: uuid("video_submission_id")` with a trailing
comment `// FK to video_submissions in spec 036`. The comment was
aspirational — no migration ever wrote `ALTER TABLE … ADD
CONSTRAINT … FOREIGN KEY`. The TS schema, the snapshots, and the
SQL all agreed there was NO referential constraint on this column.

Consequence: a programming bug in the upload pipeline (where the
worker writes `observation_evidence` rows referencing
`video_submissions` rows it just created) could insert a row whose
`video_submission_id` pointed to a row that didn't exist or had
been cascade-deleted. The cycle-detail page joined on that id and
returned `NULL` captions when it should have returned a "video
removed" sentinel. Silent orphans. The grep gate (spec 011) catches
some delete patterns but not this read-side mismatch.

### Finding 2 (HIGH) — `transcode_jobs.profile` CHECK allowed 720p

`packages/db/src/schema/videos.ts:129` AND
`packages/db/src/migrations/0012_videos_pipeline_schema.sql:29`
both declared:

```
CHECK ("transcode_jobs"."profile" IN ('480p','720p'))
```

Spec 041 (session-5 SM-4) dropped 720p when the anti-download
contract narrowed the rendition tier to a single low-bitrate stream
(480p only — see `apps/web/src/lib/video/ffmpeg-profile.ts` and
the BullMQ worker, which has only ever queued '480p' jobs). The
documentation in `packages/db/src/schema/videos.ts:117` even said
`// 480p (720p dropped)`. The CHECK was just never updated.

Consequence: a bug in the worker or a hand-rolled test fixture
could write `profile='720p'` and the DB would happily accept it,
contradicting the documented SM-4 invariant.

### Finding 3 (HIGH) — `system_settings` singleton bootstrap raced

Migration `0015_system_settings.sql` (spec 124) INSERTs the
well-known sentinel row `'00000000-0000-0000-0000-000000000001'`
with `ON CONFLICT DO NOTHING` at the end of the CREATE TABLE
statement.

`packages/db/src/scripts/seed.ts::bootstrapSystemSettings()` ALSO
INSERTs the same row with the same `onConflictDoNothing` clause,
called from `main()` after `bootstrapSuperAdmin()`.

On simultaneous first-deploy runs (e.g. a docker-compose `up -d`
where `db:migrate` and `db:seed` start in parallel inside the API
container's entrypoint), the two writers raced on the unique PK.
`ON CONFLICT DO NOTHING` covers the read-only side of the race —
neither write FAILS — but it's a code-smell that two independent
paths are claiming ownership of the same well-known row. Single
source of truth.

## What we ship

### 1. `packages/db/src/migrations/0016_schema_cleanup.sql` (CREATED)

Hand-crafted migration with two DDL statements:

1. `ALTER TABLE observation_evidence ADD CONSTRAINT
   observation_evidence_video_submission_id_video_submissions_id_fk
   FOREIGN KEY (video_submission_id) REFERENCES
   public.video_submissions(id) ON DELETE set null ON UPDATE no
   action;` — the missing FK. The name matches drizzle-kit's
   auto-generated convention `{table}_{column}_{ref_table}_{ref_column}_fk`
   so future `drizzle-kit generate` runs see the schema as in-sync
   and don't emit a spurious rename. `ON DELETE SET NULL` mirrors
   the existing app-level contract: deleting a `video_submission`
   must not cascade and wipe the `observation_evidence` row (the
   row still carries the caption + cycle link and is a legitimate
   audit artefact even when the underlying video has been purged).
2. `ALTER TABLE transcode_jobs DROP CONSTRAINT
   transcode_jobs_profile_check; ALTER TABLE transcode_jobs ADD
   CONSTRAINT transcode_jobs_profile_check CHECK
   (transcode_jobs.profile IN ('480p'));` — tighten to 480p only.

No statement for finding (3) — it's a pure code-level fix in
`seed.ts` (no DDL needed; migration 0015 already owns the
singleton bootstrap).

### 2. `packages/db/src/migrations/meta/0016_snapshot.json` (CREATED)

Hand-edited copy of `0015_snapshot.json` with:

- `id` set to a new UUID (`5d8e4b1c-9a2f-4831-8e5d-7c6f2b3a4516`).
- `prevId` set to 0015's id (`3b8c2f9d-…`).
- `observation_evidence.foreignKeys` extended with the
  `observation_evidence_video_submission_id_video_submissions_id_fk`
  entry.
- `transcode_jobs.checkConstraints.transcode_jobs_profile_check.value`
  updated to `"transcode_jobs"."profile" IN ('480p')`.

### 3. `packages/db/src/migrations/meta/_journal.json` (EDITED)

- Inserted the `idx: 16, tag: "0016_schema_cleanup"` entry between
  the existing idx 15 and idx 17 entries (0017 was already present
  on disk for spec 144's whatsapp-dedup work, which sequenced
  ahead of this audit-closure run).

### 4. `packages/db/src/migrations/meta/0017_snapshot.json` (EDITED)

- `prevId` updated from 0015's id to 0016's new id so the
  migration chain is `0015 → 0016 → 0017`.
- `observation_evidence.foreignKeys` and
  `transcode_jobs.checkConstraints.transcode_jobs_profile_check.value`
  also updated (since the 0017 snapshot is "post-0016", it must
  carry forward the 0016 schema state).

### 5. `packages/db/src/schema/observation.ts` (EDITED)

- Added `import { videoSubmissions } from "./videos";`.
- Changed the column declaration from
  `uuid("video_submission_id")` (no reference) to
  `uuid("video_submission_id").references(() => videoSubmissions.id, { onDelete: "set null" })`.
- Updated the inline comment to point at spec 143 and explain the
  `ON DELETE SET NULL` rationale.

### 6. `packages/db/src/schema/videos.ts` (EDITED)

- Updated the `transcode_jobs_profile_check` declaration from
  `IN ('480p','720p')` to `IN ('480p')`.
- Added a comment block tying the change back to spec 041's SM-4
  Tier-0 contract and explaining why the constraint was permissive
  before.

### 7. `packages/db/src/scripts/seed.ts` (EDITED)

- Removed the `bootstrapSystemSettings()` helper function entirely.
- Removed the `await bootstrapSystemSettings(db)` call from
  `main()`.
- Replaced both with comment blocks pointing at spec 143 and
  explaining that migration 0015 owns the singleton bootstrap.

### 8. `tests/governance/test_124_system_settings_and_tweaks_admin.test.mjs` (EDITED)

- The original assertion ("seed.ts ships bootstrapSystemSettings
  and calls it from main()") was the inverse of the spec-143
  cleanup. Replaced it with a positive assertion that seed.ts must
  NOT declare or call `bootstrapSystemSettings`, AND that migration
  0015 must remain the idempotent singleton INSERT (single source
  of truth). The total assertion count is preserved (≥ 3
  assertions in that block).

### 9. `tests/governance/test_143_schema_cleanup_fk_check_singleton.test.mjs` (CREATED)

8+ assertions covering:

- `0016_schema_cleanup.sql` exists in the migrations directory.
- The migration contains the `ADD CONSTRAINT … FOREIGN KEY` for
  `observation_evidence.video_submission_id → video_submissions(id)`
  with `ON DELETE set null`.
- The migration `DROP CONSTRAINT transcode_jobs_profile_check`
  followed by an `ADD CONSTRAINT … CHECK … IN ('480p')` (NOT
  containing `'720p'`).
- The 0016 snapshot exists, chains off 0015's id, and declares
  both the new FK and the tightened CHECK.
- The `_journal.json` includes the `0016_schema_cleanup` entry at
  idx 16, sequenced after 0015 and before 0017.
- The 0017 snapshot's `prevId` was updated to chain off 0016's
  new id (not 0015's).
- `packages/db/src/schema/observation.ts` declares
  `.references(() => videoSubmissions.id, { onDelete: "set null" })`
  for `videoSubmissionId`.
- `packages/db/src/schema/videos.ts` declares the CHECK with
  `IN ('480p')` and does NOT contain `'480p','720p'`.
- `packages/db/src/scripts/seed.ts` no longer declares or invokes
  `bootstrapSystemSettings`.
- All five spec-kit files exist under
  `specs/143-schema-cleanup-fk-check-singleton/` and plan.md
  follows the CREATED/EDITED/MIGRATED contract.

## Acceptance criteria

- `pnpm --filter @gml/db generate` exits cleanly (i.e. no
  spurious new migration is generated because of FK/CHECK
  divergence between the schema files and the snapshots). The one
  exception is the pre-existing 0017 whatsapp_message_id WHERE-
  clause text difference, which is out of scope for this spec
  (and is documented in research.md).
- `node --test tests/governance/test_143_*.test.mjs` passes all
  ≥ 8 assertions.
- `node --test tests/governance/test_124_*.test.mjs` still
  passes after the assertion swap.
- The migration chain is `0015 → 0016 → 0017` (verified by the
  governance test's prevId chain assertion).

## Non-goals

- **No new dependencies.** No new drizzle plugins, no new
  pg modules. The change is entirely within the existing schema +
  migration ledger.
- **No backfill query.** The FK is added with no `NOT VALID`
  qualifier, which means Postgres validates existing rows against
  the constraint at ADD time. There are no
  `observation_evidence` rows in production (the table is empty
  at the time of this spec) so the validation is a no-op.
- **No 720p data migration.** Same reasoning — no `transcode_jobs`
  rows have ever been written with `profile='720p'` (the worker
  has always queued '480p' since spec 041 shipped). The CHECK
  tightening is a no-op for existing data.
- **No bootstrapSystemSettings replacement.** The migration 0015
  INSERT is the single source of truth. If a developer truncates
  the table they re-run `pnpm db:migrate`, not `pnpm db:seed`. The
  recovery hook is documented in `research.md`.
- **No fix for the 0017 whatsapp_message_id WHERE-clause text
  difference.** That's a pre-existing 0017 issue (the migration
  file's WHERE clause uses unqualified column names while the
  drizzle-kit re-render qualifies them). It produces a spurious
  diff on every `generate` run but doesn't affect runtime
  behaviour. Out of scope here — a future spec can fix the 0017
  WHERE clause without re-running the dedup setup.
