// Governance test for spec 151 — Worker hardening (Workflow Run 14
// audit-closure, MEDIUM tier). Three improvements consolidated:
//
//   1. apps/worker/src/queues.ts (EDITED)
//      — adds a shared `defaultJobOptions` const (attempts: 3,
//        exponential backoff with delay 5000, removeOnComplete with
//        age + count, removeOnFail with age); passes it to BOTH
//        transcodeQueue and retentionQueue Queue constructors so
//        every producer site inherits the retry policy.
//
//   2. apps/worker/src/index.ts — concurrency clamp (EDITED)
//      — replaces unbounded `parseInt` with a clamped expression:
//        Math.max(1, Math.min(parseInt(env ?? "2", 10) || 2, 16))
//        so a typo'd env can't disable the worker, crash it at
//        startup, or OOM-kill it.
//
//   3. apps/worker/src/index.ts — cron timezone documentation (EDITED)
//      — adds a comment block above the retentionQueue.add(...) call
//        explaining cron evaluates in server-local TZ, production
//        is UTC → 03:00 UTC = 08:30 IST, and TZ env can override.
//
// Plus the five spec-kit files under specs/151-worker-hardening/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const QUEUES_PATH = "apps/worker/src/queues.ts";
const INDEX_PATH = "apps/worker/src/index.ts";
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

// ---------- queues.ts — defaultJobOptions retry policy ----------

test("spec 151 — queues.ts declares a defaultJobOptions const with attempts: 3", () => {
  const src = read(QUEUES_PATH);
  // The const declaration must exist — pin its NAME so a future
  // contributor can't quietly rename it and lose the audit trail.
  assert.match(
    src,
    /const\s+defaultJobOptions\s*=\s*\{/,
    "queues.ts must declare `const defaultJobOptions = { ... }` for the shared BullMQ retry policy",
  );
  // attempts: 3 is the contract. The audit found `attempts: 0` (BullMQ
  // default) loses jobs on a single Ladakh-3G blip; this asserts the fix.
  assert.match(
    src,
    /attempts:\s*3/,
    "queues.ts defaultJobOptions must set `attempts: 3` so transient ffmpeg / MinIO failures get retried twice before the job is marked failed",
  );
});

test("spec 151 — queues.ts defaultJobOptions uses exponential backoff with 5000ms delay", () => {
  const src = read(QUEUES_PATH);
  // Backoff must be exponential (linear would hammer the failing
  // backend on each retry; exponential spaces 5s/10s/20s).
  assert.match(
    src,
    /backoff:\s*\{\s*type:\s*"exponential"(?:\s+as\s+const)?\s*,\s*delay:\s*5000\s*\}/,
    "queues.ts defaultJobOptions must set `backoff: { type: \"exponential\", delay: 5000 }` so retries space 5s/10s/20s instead of hammering the failing backend in lockstep",
  );
});

test("spec 151 — queues.ts defaultJobOptions sets removeOnComplete and removeOnFail TTLs", () => {
  const src = read(QUEUES_PATH);
  // removeOnComplete must bound the Redis footprint with BOTH age and
  // count. age=24h gives operators a debugging window; count=100 caps
  // the worst case if jobs land in quick succession.
  assert.match(
    src,
    /removeOnComplete:\s*\{\s*age:\s*24\s*\*\s*3600\s*,\s*count:\s*100\s*\}/,
    "queues.ts defaultJobOptions must set `removeOnComplete: { age: 24 * 3600, count: 100 }` to bound Redis memory while keeping a debugging window",
  );
  // removeOnFail keeps failed jobs for a week so an on-call can inspect
  // what failed over the weekend. Just age, no count cap (we want to
  // see them all).
  assert.match(
    src,
    /removeOnFail:\s*\{\s*age:\s*7\s*\*\s*24\s*\*\s*3600\s*\}/,
    "queues.ts defaultJobOptions must set `removeOnFail: { age: 7 * 24 * 3600 }` so failed jobs survive a week for on-call inspection",
  );
});

test("spec 151 — BOTH transcodeQueue and retentionQueue constructors pass defaultJobOptions", () => {
  const src = read(QUEUES_PATH);
  // The transcode queue must receive the defaults — this is the
  // user-facing queue (every video upload) and the primary target of
  // the audit finding.
  assert.match(
    src,
    /new\s+Queue<TranscodeJobInput>\(\s*"transcode"\s*,\s*\{[\s\S]{0,200}defaultJobOptions[\s\S]{0,200}\}\s*\)/,
    "queues.ts must pass `defaultJobOptions` to the transcodeQueue constructor",
  );
  // The retention queue must receive the same defaults so a transient
  // DB blip during the nightly purge doesn't silently lose a day's
  // retention work.
  assert.match(
    src,
    /new\s+Queue\(\s*"retention"\s*,\s*\{[\s\S]{0,200}defaultJobOptions[\s\S]{0,200}\}\s*\)/,
    "queues.ts must pass `defaultJobOptions` to the retentionQueue constructor",
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
  //   - `|| 2` — fallback when parseInt returns NaN or 0.
  // The regex tolerates whitespace and newlines between the operators
  // so a future reformat doesn't break the contract.
  assert.match(
    src,
    /const\s+CONCURRENCY\s*=\s*Math\.max\(\s*1\s*,\s*Math\.min\(\s*parseInt\(\s*process\.env\.WORKER_CONCURRENCY\s*\?\?\s*"2"\s*,\s*10\s*\)\s*\|\|\s*2\s*,\s*16\s*\)\s*,?\s*\)/,
    "index.ts must declare CONCURRENCY as Math.max(1, Math.min(parseInt(process.env.WORKER_CONCURRENCY ?? \"2\", 10) || 2, 16)) so a 0/NaN/999 env value is silently clamped to a sane range",
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

// ---------- index.ts — retention cron timezone documentation ----------

test("spec 151 — index.ts documents the retention cron timezone above the retentionQueue.add call", () => {
  const src = read(INDEX_PATH);
  // The comment block must mention the cron's three relevant facts:
  // (a) it evaluates in server-local TZ, (b) production is UTC, (c)
  // 03:00 UTC = 08:30 IST, and (d) TZ env override is available.
  //
  // We pin the comment as appearing somewhere ABOVE the
  // `retentionQueue.add(` call. Splitting the assertions so a future
  // partial revert (e.g. someone removes the IST line) still fails
  // loudly.
  const beforeAdd = src.split(/retentionQueue\s*\n?\s*\.add\(/)[0];
  assert.ok(
    beforeAdd.length > 0,
    "index.ts must contain a retentionQueue.add(...) call for the comment to live above it",
  );
  // Must mention "server-local" or "server local" to explain the
  // implicit dependency.
  assert.match(
    beforeAdd,
    /server[- ]local/i,
    "index.ts must document that the retention cron evaluates in server-local TZ",
  );
  // Must mention UTC as the production TZ.
  assert.match(
    beforeAdd,
    /UTC/,
    "index.ts must document that production servers run in UTC",
  );
  // Must mention IST so the operator understands the wall-clock impact.
  assert.match(
    beforeAdd,
    /IST/,
    "index.ts must document the IST conversion (08:30 IST) so the wall-clock impact is explicit",
  );
  // Must mention the TZ env escape hatch so an operator can override.
  assert.match(
    beforeAdd,
    /TZ/,
    "index.ts must document the TZ env override (e.g. TZ=Asia/Kolkata) so non-UTC hosts can pin the cron timezone",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 151 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [QUEUES_PATH, INDEX_PATH]) {
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
  // The inline comments in both files reference Spec 151 by number so
  // a future refactor reading the file knows to consult the spec
  // before reverting the defaults, the clamp, or the TZ comment.
  // This is the LMS pattern across all the previous audit-closure
  // fixes.
  const queuesSrc = read(QUEUES_PATH);
  assert.match(
    queuesSrc,
    /Spec 151/,
    "queues.ts must carry an inline `Spec 151` reference so the defaultJobOptions fix is self-documenting",
  );
  const indexSrc = read(INDEX_PATH);
  assert.match(
    indexSrc,
    /Spec 151/,
    "index.ts must carry an inline `Spec 151` reference so the concurrency clamp + TZ doc are self-documenting",
  );
});
