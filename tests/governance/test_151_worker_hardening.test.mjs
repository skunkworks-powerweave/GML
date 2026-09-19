// Governance test for spec 151 — Worker hardening (Workflow Run 14
// audit-closure, MEDIUM tier). Spec 151 consolidated three improvements:
//
//   1. apps/worker/src/queues.ts — a shared BullMQ `defaultJobOptions`
//      (attempts: 3, exponential backoff from 5000ms, removeOnComplete /
//      removeOnFail TTLs) applied to both Queue constructors.
//   2. apps/worker/src/index.ts — a clamp on WORKER_CONCURRENCY.
//   3. apps/worker/src/index.ts — a comment documenting the retention cron's
//      timezone.
//
// MOSTLY INVERTED, because BullMQ and Redis are gone. queues.ts no longer
// exists, and index.ts was rewritten around a Postgres-backed queue.
//
// THE POLICY SURVIVED THE TRANSPORT. That is the thing to hold on to while
// reading the rewritten assertions below: every guarantee spec 151 bought is
// still enforced, just somewhere else. `attempts: 3` is the `max_attempts`
// column default in packages/db/src/schema/jobs.ts and migration 0024.
// Exponential-from-5s is arithmetic inside `fail()` in packages/db/src/queue.ts.
// removeOnComplete / removeOnFail are `pruneFinished()`, called from the
// worker's housekeeping tick. So the tests move to those surfaces rather than
// being deleted -- a retry policy that quietly reverted to "one attempt, no
// backoff" would lose a video to a single 3G blip in Leh exactly as before, and
// nothing about the change of transport makes that less true.
//
// Point 3 is the one with no successor. There is no cron any more: the daily
// sweep is an hourly tick deduped on the calendar date (see test_107 for why
// the cron had to go -- the option name was a type error tsx never checked).
// Its assertion is replaced by one pinning the absence of the whole cron
// vocabulary, because re-adding `repeat: { cron }` would re-add the hazard.
//
// One assertion is not inverted at all: "index.ts no longer parses
// WORKER_CONCURRENCY without bounds". It was always about arithmetic, the
// arithmetic is still there, and it still passes untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const exists = (p) => existsSync(resolve(root, p));

/** Comments stripped, so prose explaining a removal cannot fail an absence check. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const QUEUES_PATH = "apps/worker/src/queues.ts";
const INDEX_PATH = "apps/worker/src/index.ts";
// Where the retry policy lives now: the queue operations and the table that
// carries the per-job budget.
const QUEUE_LIB_PATH = "packages/db/src/queue.ts";
const JOBS_SCHEMA_PATH = "packages/db/src/schema/jobs.ts";
const JOBS_MIGRATION_PATH = "packages/db/src/migrations/0024_jobs_and_rate_limits.sql";
const SPEC_DIR = "specs/151-worker-hardening";

// ---------- Spec-kit + plan.md contract ----------

test("spec 151 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the worker-hardening spec`,
    );
  }
});

test("spec 151 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /queues\.ts/,
    "plan.md must call out the queues.ts edit",
  );
  assert.match(
    src,
    /index\.ts/,
    "plan.md must call out the index.ts edit",
  );
});

// ---------- the retry policy, now a column and an arithmetic expression ----------

test("spec 151 — the attempts: 3 budget survives as the jobs.max_attempts default", () => {
  // INVERTED. This required `const defaultJobOptions = { attempts: 3 }` in
  // apps/worker/src/queues.ts, a file that no longer exists.
  //
  // The finding that produced it has not changed at all: BullMQ's default was
  // `attempts: 0`, so a single transient failure -- and on a Leh 3G uplink a
  // single transient failure is a Tuesday -- lost the job permanently. What
  // changed is where a per-job attempt budget can live. It is a column now,
  // with a default in the schema AND in the migration, so a producer that does
  // not think about retries still gets three attempts.
  assert.ok(
    !exists(QUEUES_PATH),
    `${QUEUES_PATH} must not exist -- BullMQ's producer module went with Redis`,
  );
  assert.match(
    read(JOBS_SCHEMA_PATH),
    /maxAttempts:\s*integer\("max_attempts"\)[\s\S]{0,60}?\.default\(3\)/,
    "jobs.max_attempts must default to 3 in the Drizzle schema",
  );
  assert.match(
    read(JOBS_MIGRATION_PATH),
    /"max_attempts"\s+integer\s+DEFAULT 3 NOT NULL/,
    "jobs.max_attempts must default to 3 in the migration too -- the schema file is " +
      "documentation, the migration is what the database actually does",
  );
  // A budget of at least 1 is enforced by a CHECK rather than trusted: a
  // max_attempts of 0 would make the job unrunnable and invisible, which is the
  // silent-loss failure mode this whole assertion exists to prevent.
  assert.match(
    read(JOBS_MIGRATION_PATH),
    /CHECK\s*\(\s*"attempts"\s*>=\s*0\s+AND\s+"max_attempts"\s*>=\s*1\s*\)/,
    "the jobs table must CHECK that every job has at least one attempt available",
  );
});

test("spec 151 — exponential-from-5s backoff survives as arithmetic in fail()", () => {
  // INVERTED. This required `backoff: { type: "exponential", delay: 5000 }`.
  // The reasoning in the original is still exactly right -- linear retries
  // hammer a failing backend in lockstep, exponential spaces them 5s/10s/20s --
  // so the same schedule is computed explicitly when a job fails.
  //
  // Being arithmetic rather than configuration is a small improvement in its
  // own right: it is typechecked, and it is capped. An unbounded exponential
  // reaches days of delay after a dozen attempts, which is indistinguishable
  // from the job having been dropped.
  const src = read(QUEUE_LIB_PATH);
  assert.match(
    src,
    /Math\.min\(\s*5\s*\*\s*2\s*\*\*\s*\(\s*attempts\s*-\s*1\s*\)\s*,\s*\d+\s*\)/,
    "fail() must compute an exponential backoff starting at 5 seconds, with a ceiling",
  );
  // The retry decision must be driven by the job's own budget, not a constant,
  // so a producer can widen or narrow it per job (the retention sweep uses 2).
  assert.match(
    src,
    /const\s+willRetry\s*=\s*attempts\s*<\s*maxAttempts/,
    "fail() must compare attempts against the job's own maxAttempts",
  );
  // Exhausted != errored. BullMQ collapsed both into 'failed', which is why the
  // old DLQ page could not tell "will be retried" from "needs a human".
  assert.match(
    src,
    /status\s*=\s*\$\{willRetry\s*\?\s*"queued"\s*:\s*"dead"\}/,
    "a job that exhausts its attempts must become 'dead', distinct from a retryable failure",
  );
});

test("spec 151 — the removeOnComplete / removeOnFail TTLs survive as pruneFinished()", () => {
  // INVERTED. This required BullMQ's `removeOnComplete: { age: 24 * 3600,
  // count: 100 }` and `removeOnFail: { age: 7 * 24 * 3600 }`. Both existed to
  // stop the queue growing without bound while keeping a debugging window, and
  // both are now a DELETE the worker runs on its housekeeping tick.
  //
  // The asymmetry the original test spelled out is preserved and widened: a
  // succeeded job is noise once the video plays, whereas a dead job is the only
  // record that something needs a person. Successes age out in a day; dead jobs
  // are kept for thirty (the old seven was a Redis-memory compromise, and
  // Postgres rows are not the same constraint).
  const src = read(QUEUE_LIB_PATH);
  assert.match(
    src,
    /export\s+async\s+function\s+pruneFinished\b/,
    "packages/db/src/queue.ts must export pruneFinished()",
  );
  assert.match(
    src,
    /succeededOlderThanHours\s*\?\?\s*24/,
    "succeeded jobs must be pruned after 24 hours -- the same debugging window removeOnComplete gave",
  );
  assert.match(
    src,
    /deadOlderThanDays\s*\?\?\s*(?:[1-9]\d*)/,
    "dead jobs must be retained for a bounded number of days, longer than successes",
  );
  // A prune that nothing calls is the same as no prune at all.
  assert.match(
    read(INDEX_PATH),
    /await\s+pruneFinished\(db\)/,
    "the worker's housekeeping tick must actually call pruneFinished",
  );
});

test("spec 151 — every enqueue inherits the retry policy without restating it", () => {
  // INVERTED. This required BOTH `new Queue(...)` constructors to be handed
  // `defaultJobOptions`, because in BullMQ the policy was per-queue
  // configuration and a producer that forgot it silently got attempts: 0.
  //
  // The equivalent property now is that `enqueue()` supplies the default
  // itself, so it is impossible for a call site to opt out by omission -- which
  // is a stronger guarantee than "remember to pass the const to every
  // constructor", and is why there is one assertion here instead of two.
  const src = read(QUEUE_LIB_PATH);
  assert.match(
    src,
    /\$\{opts\.maxAttempts\s*\?\?\s*3\}/,
    "enqueue() must default maxAttempts to 3 so a producer cannot forget the retry budget",
  );
  // And the DEAD-LETTER path must be reachable by the admin view: a job the
  // worker gave up on has to be countable, or the DLQ page shows an empty table
  // during an outage.
  assert.match(
    src,
    /export\s+async\s+function\s+queueDepth\b[\s\S]*?'dead'/,
    "queueDepth() must count dead jobs -- the operator-facing half of the retry policy",
  );
});

// ---------- index.ts — WORKER_CONCURRENCY clamp ----------

test("spec 151 — index.ts clamps WORKER_CONCURRENCY into [1, 16] with a NaN/0 fallback", () => {
  const src = read(INDEX_PATH);
  // The clamp expression is the literal contract — pinning it as a
  // regex catches:
  //   - Math.max(1, ...) — floor at 1 (excludes 0 which would silently
  //     disable the worker),
  //   - Math.min(..., 16) — cap at 16 (defends against OOM from
  //     typo'd large values like 999),
  //   - `|| 1` — fallback when parseInt returns NaN or 0.
  // The regex tolerates whitespace and newlines between the operators
  // so a future reformat doesn't break the contract.
  //
  // THE DEFAULT CHANGED FROM 2 TO 1, and it is the only part of this assertion
  // that moved. Two was never measured; it was the shape of "a bit of
  // parallelism". One ffmpeg at `-preset veryfast` already saturates both vCPUs
  // of the target instance, so a second process does not transcode two videos
  // at once -- it makes both slower and starves the web tier sharing the box,
  // which on a single-EC2 deployment in Leh is the thing users are actually
  // looking at. Queue depth is the right place to absorb a burst, and now that
  // the queue is a table with leases and retries, depth is cheap and visible.
  // The clamp itself is unchanged: the three failure modes it guards (0
  // disables the worker, NaN refuses to start, 999 OOM-kills the container) are
  // properties of reading an integer out of the environment, not of BullMQ.
  assert.match(
    src,
    /const\s+CONCURRENCY\s*=\s*Math\.max\(\s*1\s*,\s*Math\.min\(\s*(?:Number\.)?parseInt\(\s*process\.env\.WORKER_CONCURRENCY\s*\?\?\s*"1"\s*,\s*10\s*\)\s*\|\|\s*1\s*,\s*16\s*\)\s*,?\s*\)/,
    "index.ts must declare CONCURRENCY as Math.max(1, Math.min(parseInt(process.env.WORKER_CONCURRENCY ?? \"1\", 10) || 1, 16)) so a 0/NaN/999 env value is silently clamped to a sane range",
  );
  // The clamped value must reach the consumer loops, or it is decoration.
  assert.match(
    src,
    /Array\.from\(\s*\{\s*length:\s*CONCURRENCY\s*\}/,
    "CONCURRENCY must determine how many consumer loops are started",
  );
});

test("spec 151 — index.ts no longer parses WORKER_CONCURRENCY without bounds", () => {
  const src = read(INDEX_PATH);
  // The pre-fix shape was:
  //   const CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);
  // We pin its ABSENCE — specifically, no `Number.parseInt` (the old
  // shape) appears as a direct assignment to CONCURRENCY. The `Math.max`
  // assertion above pins the new shape; this assertion forbids
  // regressing to the old one.
  assert.ok(
    !/const\s+CONCURRENCY\s*=\s*Number\.parseInt\(/.test(src),
    "index.ts must not use `Number.parseInt` directly for CONCURRENCY — spec 151 replaced it with a Math.max(1, Math.min(..., 16)) clamp",
  );
});

// ---------- index.ts — the cron, and its timezone footgun, are gone ----------

test("spec 151 — there is no retention cron left to document a timezone for", () => {
  // INVERTED, and this one has no successor assertion because it has no
  // successor behaviour.
  //
  // Spec 151's third improvement was a COMMENT explaining that
  // `repeat: { cron: "0 3 * * *" }` evaluates in server-local time, that
  // production runs UTC, that 03:00 UTC is 08:30 IST, and that TZ= can
  // override it. That comment was worth writing precisely because the
  // scheduling was opaque configuration handed to a library -- an operator
  // could not read the surrounding code and work out when the job would run.
  //
  // The scheduling is not opaque any more. An hourly `setInterval` enqueues a
  // job keyed on the calendar date; there is no expression to parse, no
  // library's interpretation of local time, and nothing to document about a
  // timezone except which date rollover it follows. (And the key really is
  // date-based, not time-based: see test_107, which pins that property and
  // notes the wall-clock time moved as a result.)
  //
  // What replaces the documentation assertion is an ABSENCE assertion, because
  // the underlying hazard was never the timezone. It was that `cron` had been
  // renamed to `pattern` in BullMQ 5, making the option a type error that
  // survived only because this package runs under tsx -- which strips types
  // without checking them -- while a runtime shim aliased the old name. A
  // reintroduced `repeat:`/`cron:` here would restore un-typechecked scheduling
  // configuration to a file where everything else is ordinary code.
  const src = code(read(INDEX_PATH));
  assert.ok(
    !/retentionQueue/.test(src),
    "no retentionQueue remains -- the sweep is a row in the jobs table",
  );
  assert.ok(
    !/\brepeat\s*:/.test(src),
    "no `repeat:` scheduling option may return to the worker",
  );
  assert.ok(
    !/\b(?:cron|pattern)\s*:/.test(src),
    "neither `cron:` nor its BullMQ 5 rename `pattern:` may return -- the type error " +
      "that survived that rename is the reason this scheduling moved into plain code",
  );
  // The positive half: scheduling is a named function on an interval, in code
  // the typechecker reads.
  assert.match(
    read(INDEX_PATH),
    /async function scheduleDailyWork\(\)/,
    "the daily sweep must be scheduled by an ordinary, typechecked function",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 151 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  // Same check, retargeted: QUEUES_PATH is gone, and the files that now carry
  // the policy it held are the ones worth sweeping.
  for (const path of [INDEX_PATH, QUEUE_LIB_PATH, JOBS_SCHEMA_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 151 — no new dependencies were introduced (no cron-parser, no @bull-board)", () => {
  // The fix is pure BullMQ option-passing and JS arithmetic. No
  // cron timezone library, no Bull dashboard, no AbortController
  // polyfill should have crept into apps/worker/package.json.
  const pkg = read("apps/worker/package.json");
  assert.ok(
    !/"cron-parser"/.test(pkg),
    "apps/worker must not depend on cron-parser — the timezone fix is a documentation comment, not a runtime cron rewrite",
  );
  assert.ok(
    !/"@bull-board\//.test(pkg),
    "apps/worker must not depend on @bull-board/* — alerting on retry exhaustion is out of scope for spec 151",
  );
});

test("spec 151 — the fix is documented inline so future contributors don't quietly revert it", () => {
  // INVERTED IN FORM, NOT IN INTENT. The original pinned the literal string
  // "Spec 151" in both files, on the LMS convention that a fix should tell a
  // future reader where to look before undoing it.
  //
  // A spec number is a poor anchor across a rewrite. queues.ts, which carried
  // one of the two references, no longer exists; index.ts was rewritten around
  // a different transport, and a surviving "Spec 151" marker there would now
  // point at a document describing BullMQ options that are not in the file. A
  // stale pointer is worse than none: it costs a reader the trip to the spec
  // folder and hands them a description of a system that is gone.
  //
  // So this pins the REASONING instead of the citation -- the three failure
  // modes the clamp exists for, and the retry semantics the policy exists for,
  // stated at the point of the code that implements them. That is what stops a
  // quiet revert, and unlike a spec number it cannot go stale without the code
  // going stale with it.
  const indexSrc = read(INDEX_PATH);
  const clampComment = indexSrc.split(/const\s+CONCURRENCY\s*=/)[0];
  assert.match(
    clampComment,
    /WORKER_CONCURRENCY/,
    "the clamp must be introduced by a comment naming the variable it guards",
  );
  for (const [pattern, why] of [
    [/\b0\b/, "that 0 disables the worker entirely, leaving jobs with no consumer"],
    [/NaN/, "that a non-numeric value parses to NaN and refuses to start"],
    [/OOM|out of memory/i, "that a large value spawns that many ffmpeg processes and OOM-kills the container"],
  ]) {
    assert.match(
      clampComment,
      pattern,
      `the clamp comment must explain ${why} -- all three are why the bounds are not arbitrary`,
    );
  }

  const queueSrc = read(QUEUE_LIB_PATH);
  assert.match(
    queueSrc,
    /exponential/i,
    "queue.ts must say in prose that the retry cadence is exponential, beside the arithmetic that makes it so",
  );
  assert.match(
    queueSrc,
    /\bdead\b/,
    "queue.ts must explain the dead-letter state -- the distinction between " +
      "'will be retried' and 'needs a human' is the part a refactor is most likely to flatten",
  );
});
