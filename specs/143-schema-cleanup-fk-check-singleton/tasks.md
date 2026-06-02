# Tasks 143

- [x] T1 → write the governance test (red) covering: the 0016
  migration file exists; the FK ADD CONSTRAINT statement is
  present with the correct ON DELETE SET NULL; the CHECK
  tightening DROPs then re-ADDs with ('480p') only; the 0016
  snapshot exists, chains off 0015's id, and declares both the
  new FK and the tightened CHECK; the _journal entry at idx 16
  with tag "0016_schema_cleanup" exists between 15 and 17; the
  0017 snapshot's prevId points at 0016's id; the schema TS
  files reflect the FK (.references with onDelete: "set null")
  and the tightened CHECK; seed.ts no longer declares or invokes
  bootstrapSystemSettings; all five spec-kit files exist. Run
  suite → red.
- [x] T2 → edit `packages/db/src/schema/observation.ts`: add
  `import { videoSubmissions } from "./videos";` and update the
  `videoSubmissionId` column declaration to call
  `.references(() => videoSubmissions.id, { onDelete: "set null" })`.
- [x] T3 → edit `packages/db/src/schema/videos.ts`: update the
  `transcode_jobs_profile_check` CHECK from `IN ('480p','720p')`
  to `IN ('480p')` and add a comment block tying the change back
  to spec 041's SM-4 Tier-0 contract.
- [x] T4 → edit `packages/db/src/scripts/seed.ts`: remove the
  `bootstrapSystemSettings` helper function and its `await
  bootstrapSystemSettings(db)` call from `main()`. Replace both
  with comment blocks explaining the migration 0015 single-
  source-of-truth contract.
- [x] T5 → run `pnpm --filter @gml/db generate` to see drizzle-
  kit's natural ALTER statements for the schema changes. Use the
  auto-generated SQL as a reference but write the migration by
  hand at the correct slot (0016, not the next sequential slot).
- [x] T6 → create `packages/db/src/migrations/0016_schema_cleanup.sql`
  with two ALTER statements: (1) ADD CONSTRAINT FOREIGN KEY using
  drizzle-kit's natural naming convention
  `observation_evidence_video_submission_id_video_submissions_id_fk`,
  (2) DROP and re-ADD the `transcode_jobs_profile_check` CHECK
  with `IN ('480p')`. Add a header comment block documenting all
  three audit findings.
- [x] T7 → create
  `packages/db/src/migrations/meta/0016_snapshot.json` as a hand-
  edited copy of 0015 with: new id, prevId chaining off 0015's
  id, FK entry added under `observation_evidence.foreignKeys`,
  CHECK value updated under
  `transcode_jobs.checkConstraints.transcode_jobs_profile_check.value`.
- [x] T8 → edit
  `packages/db/src/migrations/meta/_journal.json` to insert the
  idx 16 entry between the existing 15 and 17 entries so the
  chain is 0015 → 0016 → 0017.
- [x] T9 → edit
  `packages/db/src/migrations/meta/0017_snapshot.json` to update
  `prevId` to 0016's new id and roll forward the FK + CHECK
  changes so the post-0017 snapshot is consistent with the
  post-0016 state.
- [x] T10 → edit
  `tests/governance/test_124_system_settings_and_tweaks_admin.test.mjs`
  to swap the positive assertion ("seed.ts ships
  bootstrapSystemSettings and calls it from main()") for the
  inverse — the bootstrap was removed in spec 143; migration
  0015's INSERT is now the single source of truth. Keep ≥ 3
  assertions in the test block.
- [x] T11 → author all five spec-kit files under
  `specs/143-schema-cleanup-fk-check-singleton/`.
- [x] T12 → run the scoped governance suite
  (`node --test tests/governance/test_143_*.test.mjs`) → green.
  Run the full suite to confirm no regression — the 0017 spurious
  WHERE-clause diff from drizzle-kit is pre-existing and out of
  scope (documented in research.md).
- [ ] T13 (future) → fix the pre-existing 0017
  `whatsapp_message_id` WHERE-clause text mismatch so
  `pnpm db:generate` returns a clean "nothing to do" verdict.
  Out of scope here — would need its own migration (0018) to
  rename the index, more churn than this audit-closure can
  afford.
- [ ] T14 (future) → add a runtime regression test that exercises
  the SET NULL behaviour: insert an observation_evidence row,
  delete the underlying video_submission, assert the evidence
  row's video_submission_id is now NULL (not the row deleted, not
  the FK violated). The spec-143 governance test exercises only
  the schema-level invariants; a runtime test would close the
  loop end-to-end.
- [ ] T15 (future) → consider promoting the migration ledger
  invariants (sequential idx, prevId chain, no spurious diffs)
  into a meta-governance test that runs across all migrations.
  Out of scope here.
