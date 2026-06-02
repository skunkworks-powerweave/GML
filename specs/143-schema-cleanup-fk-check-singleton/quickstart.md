# Quickstart 143 — Schema cleanup verification

Five-minute smoke test exercising the three audit closures.

## (0) Pre-flight

1. Drop and re-create the dev DB so the migration ledger is
   replayed from scratch:
   ```
   docker-compose down -v postgres
   docker-compose up -d postgres
   ```
2. From `packages/db`, run:
   ```
   pnpm migrate
   pnpm seed:all
   ```
3. Confirm all 17 migrations apply cleanly (0000 → 0017, with
   0016_schema_cleanup in the middle of the chain).

## (1) Observation evidence FK exists

4. Open a psql shell against the dev DB:
   ```
   docker-compose exec postgres psql -U gml gml_lms
   ```
5. Verify the FK exists by name:
   ```sql
   SELECT conname
   FROM pg_constraint
   WHERE conname =
     'observation_evidence_video_submission_id_video_submissions_id_fk';
   ```
   Expect one row. Empty result means the migration didn't apply.
6. Verify the ON DELETE behaviour:
   ```sql
   SELECT confdeltype
   FROM pg_constraint
   WHERE conname =
     'observation_evidence_video_submission_id_video_submissions_id_fk';
   ```
   Expect `n` (SET NULL). Other values (`a` = NO ACTION,
   `c` = CASCADE, `r` = RESTRICT) indicate a divergence from the
   spec.
7. Negative test — try to insert a row with a bogus FK:
   ```sql
   INSERT INTO observation_evidence (cycle_id, video_submission_id)
   VALUES ('00000000-0000-0000-0000-000000000000',
           '00000000-0000-0000-0000-000000000000');
   ```
   Expect `ERROR: insert or update on table "observation_evidence"
   violates foreign key constraint "…"`. If the insert succeeds
   the FK is missing.

## (2) Transcode jobs CHECK is tightened

8. From the same psql shell:
   ```sql
   SELECT pg_get_constraintdef(oid) AS def
   FROM pg_constraint
   WHERE conname = 'transcode_jobs_profile_check';
   ```
   Expect `CHECK ((profile)::text = '480p'::text)` (Postgres
   normalises `IN ('480p')` to an equality at storage time).
   Older shape `CHECK ((profile = ANY (ARRAY['480p', '720p'])))`
   indicates the migration didn't apply.
9. Negative test:
   ```sql
   INSERT INTO transcode_jobs (video_submission_id, profile)
   VALUES ('00000000-0000-0000-0000-000000000000', '720p');
   ```
   Expect `ERROR: new row for relation "transcode_jobs" violates
   check constraint "transcode_jobs_profile_check"`.

## (3) System settings singleton bootstrap is owned by migration 0015

10. From the same psql shell:
    ```sql
    SELECT COUNT(*) FROM system_settings;
    ```
    Expect `1`. The well-known sentinel row was inserted by
    migration 0015 alone (the seed-side helper was removed in
    spec 143).
11. Read the API logs:
    ```
    docker-compose logs --tail=50 web
    ```
    The previous "system_settings singleton already exists —
    skipping" log line from `bootstrapSystemSettings()` should
    NOT appear. Its absence confirms the seed-side helper was
    removed.
12. Inspect `packages/db/src/scripts/seed.ts`:
    ```
    grep bootstrapSystemSettings packages/db/src/scripts/seed.ts
    ```
    Expect zero matches in code lines. Comments may mention the
    name to explain why the function was removed.

## (4) Schema files agree with the snapshots

13. Run drizzle-kit's generate as a no-op probe:
    ```
    pnpm --filter @gml/db generate
    ```
    The output should NOT mention any change to
    `observation_evidence` or `transcode_jobs`. (One pre-existing
    cosmetic diff on the 0017 `whatsapp_message_id` index's WHERE
    clause is expected and documented in research.md — discard
    the resulting 0018 file and revert the journal entry.)

## (5) Run the spec-143 governance test

14. From the repo root:
    ```
    node --test tests/governance/test_143_schema_cleanup_fk_check_singleton.test.mjs
    ```
    All 8+ assertions should pass green.
15. Run the full suite to confirm no regression elsewhere:
    ```
    pnpm test
    ```
    Expect the pre-spec-143 total + the new spec-143 assertions,
    with zero failures. The spec-124 test was edited (positive
    assertion swapped for the inverse) but the suite-level
    pass/fail status is preserved.

## Rollback (if needed)

If the migration must be rolled back in a dev DB (production
rollbacks are out of scope — production never had 720p data and
the FK is a no-op for empty tables):

```sql
ALTER TABLE observation_evidence
  DROP CONSTRAINT
  observation_evidence_video_submission_id_video_submissions_id_fk;
ALTER TABLE transcode_jobs
  DROP CONSTRAINT transcode_jobs_profile_check;
ALTER TABLE transcode_jobs
  ADD CONSTRAINT transcode_jobs_profile_check
  CHECK (profile IN ('480p','720p'));
DELETE FROM drizzle.__drizzle_migrations
  WHERE hash LIKE '0016_schema_cleanup%';
```

Then revert the source-code changes via git.
