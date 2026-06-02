# Tasks 151

- [x] T1 → write the governance test (red) covering:
  - `queues.ts` declares a `defaultJobOptions` object/const,
  - the const contains `attempts: 3`, `backoff: { type:
    "exponential", delay: 5000 }`, `removeOnComplete` with `age`
    and `count`, and `removeOnFail` with `age`,
  - BOTH `transcodeQueue` and `retentionQueue` constructors pass
    `defaultJobOptions` in their options object,
  - `index.ts` declares `CONCURRENCY` as a `Math.max(1, Math.min(...,
    16))` expression with a `|| 2` fallback,
  - `index.ts` contains a comment block above the
    `retentionQueue.add(...)` call mentioning the timezone (UTC),
    the IST conversion (08:30), and the `TZ` env escape hatch.
  Run suite → red.
- [x] T2 → edit `apps/worker/src/queues.ts`: add the
  `defaultJobOptions` const with the four required fields and pass
  it to BOTH Queue constructors. Inline comment block above the
  const explains the rationale (Ladakh 3G transient failures,
  Redis footprint bounds, failed-job inspection window). Run
  scoped governance test → retry-policy assertions green.
- [x] T3 → edit `apps/worker/src/index.ts`: replace the unbounded
  `parseInt` with the clamped expression and add the inline
  comment block above the `retentionQueue.add(...)` call. Run
  scoped governance test → concurrency-clamp and cron-tz
  assertions green.
- [x] T4 → author all five spec-kit files under
  `specs/151-worker-hardening/`.
- [x] T5 → run the full governance suite. Confirm no regression —
  the only contract surface changes are the worker's job-options
  defaults (no caller breaks; per-job overrides still win) and
  the env-clamp (no caller breaks; the env contract is unchanged,
  just defended).
- [ ] T6 (future, out of scope) → wire job-level alerting (Slack /
  email) when a job exhausts attempts. Today operators have to
  read worker logs or Redis directly. Spec 154+ candidate.
- [ ] T7 (future, out of scope) → consider a `removeOnFail: { count:
  500 }` per-job cap to bound the failed-set size on a bad day.
  The current age-only TTL is fine for normal operation but a
  burst of failures (e.g. MinIO outage for hours) could grow the
  failed set to thousands of entries.
- [ ] T8 (future, out of scope) → unify the retention cron timezone
  with an explicit `tz` config (would need cron-parser as a dep
  or a BullMQ version bump). The comment-block fix here is
  surgical; the dep-bump is a separate effort.
- [ ] T9 (future, out of scope) → add a runtime smoke test under
  `tests/smoke/` that boots a real Redis + worker, enqueues a
  failing job, and asserts on 3 retry attempts. Out of scope here
  because the smoke suite is heavyweight and the source-shape
  governance test pins the contract just as effectively.
