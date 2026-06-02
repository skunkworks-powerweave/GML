# Spec 151 — Worker hardening (Workflow Run 14 audit-closure, MEDIUM tier)

## Why

The 7-agent code audit at the close of Workflow Run 13 surfaced three
MEDIUM-severity gaps in the BullMQ worker. Each one is the kind of
issue that holds in development but bites production:

1. **BullMQ queues have no retry policy.** `apps/worker/src/queues.ts`
   constructs both `transcodeQueue` and `retentionQueue` with no
   `defaultJobOptions`. BullMQ's default for `attempts` is **0** — i.e.
   a single failure is permanent. On the Ladakh 3G uplink where the
   worker downloads originals from MinIO and runs ffmpeg, a transient
   network blip would lose the user's upload with no retry. The
   transcode job dies, `video_submissions` stays at `status='pending'`
   forever, and the teacher sees their video stuck on "Processing…"
   indefinitely. This is not theoretical — Workflow Run 11 saw exactly
   this pattern when a test MinIO container ran out of disk.

2. **`WORKER_CONCURRENCY` is parsed without bounds.** `apps/worker/src/index.ts:25`
   reads `process.env.WORKER_CONCURRENCY` with a raw `parseInt` and a
   fallback of `"2"`. Three pathological inputs:
   - `WORKER_CONCURRENCY=0` → BullMQ accepts concurrency=0 but the
     worker never picks up a job. Jobs pile up in Redis with no
     consumer. Silent failure.
   - `WORKER_CONCURRENCY=foo` (non-numeric) → parseInt returns NaN.
     BullMQ rejects with a type error AT STARTUP, the worker
     container crash-loops. Loud failure.
   - `WORKER_CONCURRENCY=999` (operator typo for 9 or 99) → 999
     concurrent ffmpeg processes spawn. Each ffmpeg holds ~150 MB
     resident. The worker OOM-kills within seconds. Very loud
     failure, but the symptom (kernel oom-killer) is hard to trace
     back to a typo in an env file.

3. **The retention cron is undocumented in timezone.** `apps/worker/src/index.ts:86`
   registers `cron: "0 3 * * *"` with no comment explaining which
   timezone the host evaluates that in. A maintainer reading the file
   sees "03:00" and assumes it's 03:00 IST because that's the
   project's user-base timezone — but the production VPS runs in UTC,
   so the job actually fires at 03:00 UTC = 08:30 IST. That's
   slightly counterintuitive (early morning IST instead of dead-of-night
   IST) but actually fine for our use case; the issue is that nothing
   in the source file SAYS so. A future maintainer who runs the
   docker-compose stack on a non-UTC host will be confused when the
   nightly purge fires at a different wall-clock time.

## What we ship

### `apps/worker/src/queues.ts` (EDITED)

- Introduce a shared `defaultJobOptions` constant:
  ```ts
  const defaultJobOptions = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
    removeOnComplete: { age: 24 * 3600, count: 100 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };
  ```
- Pass it to BOTH `new Queue(...)` constructors so every producer
  call site inherits the retry policy automatically. Callers can
  still override per-job via the third arg to `.add(...)` — this
  is the standard BullMQ pattern, no API change.
- Inline comment block above the constant explains the rationale
  (attempts=3 with exponential backoff handles transient ffmpeg /
  MinIO failures; removeOnComplete bounds the Redis memory footprint
  to ~100 newest jobs per queue; removeOnFail keeps failed jobs for
  a week so an on-call can inspect them).

### `apps/worker/src/index.ts` (EDITED)

Two changes, both surgical:

1. **Concurrency clamp.** Replace
   ```ts
   const CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);
   ```
   with
   ```ts
   const CONCURRENCY = Math.max(
     1,
     Math.min(parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10) || 2, 16),
   );
   ```
   Reading left-to-right:
   - `parseInt(... ?? "2", 10)` — parse the env, default "2".
   - `|| 2` — fall back to 2 if the parse returned 0 or NaN (the
     `||` operator catches both falsy values, which is what we want
     here — a config value of 0 is a deployment bug, not an opt-out).
   - `Math.min(..., 16)` — cap at 16 to prevent OOM from typo'd
     large values.
   - `Math.max(1, ...)` — floor at 1 so we always have at least one
     consumer.
   The inline comment explains the three failure modes the clamp
   defends against.

2. **Cron timezone documentation.** Add a comment block above the
   `retentionQueue.add(...)` call:
   ```
   Cron evaluates in the server-local TZ. Production servers (the
   Ladakh VPS plus the dev compose stack) use UTC, so 03:00 UTC =
   08:30 IST. Set TZ env on the worker container (e.g.
   TZ=Asia/Kolkata) to override if needed.
   ```
   Pure documentation — no behaviour change. The implicit
   dependency on the host TZ is now explicit in source.

## Acceptance criteria

- `queues.ts` declares a `defaultJobOptions` literal (or const)
  containing `attempts: 3`, an exponential `backoff` with
  `delay: 5000`, a `removeOnComplete` object with `age` and
  `count`, and a `removeOnFail` object with `age`.
- Both the `transcodeQueue` and `retentionQueue` constructors
  receive a `defaultJobOptions` field in their options object.
- `index.ts` declares `CONCURRENCY` as a `Math.max(1, Math.min(...,
  16))` expression with a `|| 2` fallback for NaN / 0.
- `index.ts` contains an inline comment block above the
  `retentionQueue.add(...)` call mentioning the timezone (UTC),
  the conversion to IST, and the `TZ` env escape hatch.
- All five spec-kit files exist under `specs/151-worker-hardening/`.
- `tests/governance/test_151_worker_hardening.test.mjs` passes
  with at least six assertions covering the above.

## Non-goals

- **No schema change.** Worker behaviour change only — no DB columns,
  no migrations. The next migration idx (0018) is reserved for
  spec 153 and is not touched here.
- **No new dependencies.** Pure BullMQ option-passing and JS arithmetic.
- **No retry-policy tuning per queue.** Both queues get the same
  defaults because both queues face the same Redis / network /
  filesystem failure modes. Per-queue overrides can be added later
  if the retention purge needs a softer policy.
- **No alert-on-retry plumbing.** Job-level monitoring (Slack alert
  when a job exhausts attempts) is a separate concern (BullMQ
  Insights / Bull Board / custom). This spec only adds the policy.
- **No actual timezone change.** The cron stays at `"0 3 * * *"`.
  The comment block documents what that means; it does not change
  when the job fires.
- **No automated test for retry semantics at runtime.** BullMQ
  retries are integration-level behaviour that needs a real Redis;
  the governance test pins the source shape (the literal
  `defaultJobOptions`, the clamp expression, the comment), which is
  the contract that closes the audit finding.
