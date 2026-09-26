// Governance test for spec 107 — SM-8 notification retention sweep.
//
// PARTIALLY INVERTED. The SM-8 contract itself is untouched: notifications
// older than 90 days are still deleted, still by deleteOldNotifications(),
// still guarded so an import cannot auto-run the CLI. The five assertions that
// changed pinned BullMQ's *scheduler*, and BullMQ is gone.
//
// WHY THE SCHEDULER WENT WITH IT. The registration read
// `repeat: { cron: "0 3 * * *" }`. BullMQ 5 renamed that option to `pattern`,
// so `cron` was a TYPE ERROR -- one that survived in shipped code because this
// package runs under tsx, which strips types without checking them, while a
// back-compat shim quietly aliased the old name at runtime. The bug was
// invisible from both directions: the typechecker never saw the file, and the
// behaviour never broke. That is the specific hazard a plain `setInterval` in
// ordinary, typechecked code does not have.
//
// The replacement is: an hourly tick calls scheduleDailyWork(), which ENQUEUES
// a `deleteOldNotifications` job with `dedupeKey: "retention:<YYYY-MM-DD>"`.
// The partial unique index over live jobs absorbs the other twenty-three ticks,
// so the sweep runs once per calendar day no matter how many worker replicas
// are running or how often one restarts -- which is what `jobId:
// "retention:nightly"` was reaching for and could only achieve on a single
// Redis instance.
//
// NOTE FOR REVIEWERS: the wall-clock time moved. The old schedule fired at
// 03:00 server-local; the new one fires whenever the first hourly tick after
// the UTC date rollover lands, i.e. within the hour after 00:00 UTC. That is a
// real change in behaviour, not merely in transport, and the assertions below
// pin the dedupe-by-date property rather than a time, because a time is no
// longer what the implementation guarantees.

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

const WORKER_PATH = "apps/worker/src/index.ts";
const WORKER_QUEUES_PATH = "apps/worker/src/queues.ts";
const RETENTION_PATH = "packages/db/src/scripts/retention.ts";
const DB_BARREL_PATH = "packages/db/src/index.ts";
const SPEC_DIR = "specs/107-sm8-retention-cron";

test("spec 107: all five spec-kit files present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 107: the BullMQ producer module is gone", () => {
  // INVERTED. This required `new Queue("retention", ...)` in
  // apps/worker/src/queues.ts. That file existed to let apps/web import a
  // producer without booting the consumer -- a split that only made sense while
  // the queue lived in a separate service. The queue is a Postgres table now,
  // so the producer is `enqueue()` in @gml/db and the file has no remaining
  // reason to exist.
  assert.ok(
    !exists(WORKER_QUEUES_PATH),
    `${WORKER_QUEUES_PATH} must not exist -- producers go through @gml/db/queue`,
  );
  const src = code(read(WORKER_PATH));
  assert.ok(
    !/new\s+Queue\s*[<(]/.test(src),
    "no BullMQ Queue may be constructed in the worker",
  );
});

test("spec 107: the worker claims retention work from Postgres, not from a BullMQ Worker", () => {
  // INVERTED. This required `new Worker("retention", ...)`. There is one
  // consumer loop now and it dispatches on the job's `name` column, so a
  // second queue would buy a second poller and nothing else.
  const src = code(read(WORKER_PATH));
  assert.ok(
    !/new\s+Worker\s*[<(]/.test(src),
    "no BullMQ Worker may be constructed -- the consumer is claim() over the jobs table",
  );
  assert.ok(
    !/from\s*["']bullmq["']/.test(src),
    "the worker must not import bullmq",
  );
  assert.match(
    read(WORKER_PATH),
    /import\s*\{[\s\S]*?\bclaim\b[\s\S]*?\}\s*from\s*["']@gml\/db\/queue["']/,
    "worker must import claim() from @gml/db/queue -- the SKIP LOCKED claim is the queue",
  );
  assert.match(
    read(WORKER_PATH),
    /case\s+["']deleteOldNotifications["']\s*:/,
    "the consumer's dispatch switch must still have a deleteOldNotifications arm, " +
      "or SM-8's sweep is enqueued and never run",
  );
});

test("spec 107: no cron expression survives anywhere in the worker", () => {
  // INVERTED. This required the literal cron string '0 3 * * *' inside
  // `repeat: { cron }`. BullMQ 5 renamed that key to `pattern`, so the option
  // as written was a type error that tsx never typechecked and a runtime shim
  // silently accepted. Pinning the ABSENCE of the whole vocabulary is the point:
  // a reintroduced `repeat:`/`cron:` here would be un-typechecked configuration
  // again, in a file whose scheduling is otherwise plain code.
  const src = code(read(WORKER_PATH));
  assert.ok(
    !/\brepeat\s*:/.test(src),
    "no `repeat:` option -- scheduling is a setInterval in typechecked code",
  );
  assert.ok(
    !/\bcron\s*:/.test(src) && !/["'][\d*/,\-\s]+\*\s+\*\s+\*["']/.test(src),
    "no cron expression may reappear in the worker",
  );
  assert.match(
    read(WORKER_PATH),
    /setInterval\(\s*\(\)\s*=>\s*void\s+scheduleDailyWork\(\)/,
    "the daily sweep must be driven by an ordinary interval calling scheduleDailyWork()",
  );
});

test("spec 107: the once-per-day guarantee is a dedupe key on the calendar date", () => {
  // INVERTED. This required `jobId: "retention:nightly"`, BullMQ's way of
  // making a repeatable job idempotent. A FIXED id is the wrong shape here: it
  // is unique forever, so the second day's sweep collides with the first day's
  // completed job. The date-scoped key plus the partial unique index over LIVE
  // jobs only gives the property that was actually wanted -- at most one sweep
  // pending per calendar day, and tomorrow's is not blocked by today's.
  const src = read(WORKER_PATH);
  assert.ok(
    !/jobId\s*:/.test(code(src)),
    "no BullMQ jobId -- identity is the dedupe_key column",
  );
  assert.match(
    src,
    /\.toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/,
    "the dedupe key must be derived from the calendar date (YYYY-MM-DD)",
  );

  // The HOUR is checked too, and that is not cosmetic. Enqueuing on the first
  // tick after date rollover would silently move the sweep from the 03:00 UTC
  // this spec committed to, to roughly midnight UTC -- 05:30 IST, inside the
  // morning window when Ladakh mentors are actually on their devices. Sitting
  // behind that window was the entire reason for choosing 03:00.
  assert.match(
    src,
    /getUTCHours\(\)\s*<\s*RETENTION_HOUR_UTC/,
    "the sweep must not fire before its committed hour",
  );
  assert.match(
    src,
    /dedupeKey\s*:\s*`retention:\$\{[A-Za-z_$][\w$]*\}`/,
    "the sweep must be enqueued with dedupeKey `retention:<YYYY-MM-DD>`",
  );
  // CORRECTED (F16). This message used to say the other hourly ticks were
  // "absorbed by jobs_dedupe_live_uq". They were not: that index covers only
  // queued and running jobs, so once the day's sweep had SUCCEEDED the next
  // tick enqueued and ran another, about 21 a day. The enqueue is `once` per
  // key, which counts the finished job too; tests/behaviour/
  // retention-schedule.test.ts executes the schedule with a clock.
  assert.match(
    src,
    /dedupeKey\s*:\s*`retention:\$\{[A-Za-z_$][\w$]*\}`[\s\S]{0,80}?once:\s*true/,
    "the sweep must be enqueued `once` per date key, or every hourly tick after 03:00 UTC re-runs it",
  );
});

test("spec 107: worker enqueues a 'deleteOldNotifications' job", () => {
  const src = read(WORKER_PATH);
  // Same guarantee as before, expressed against the new producer: the sweep is
  // ENQUEUED rather than run inline, so it inherits leases, retry/backoff and
  // the DLQ view instead of dying silently inside a timer callback.
  assert.match(
    src,
    /enqueue\(\s*db\s*,\s*\{[\s\S]{0,300}?name\s*:\s*["']deleteOldNotifications["']/,
    "apps/worker/src/index.ts must enqueue a job named 'deleteOldNotifications'",
  );
  assert.match(
    src,
    /maxAttempts\s*:\s*[1-9]/,
    "the sweep must be enqueued with a retry budget -- a transient DB blip must " +
      "not cost a day of retention",
  );
});

test("spec 107: worker imports deleteOldNotifications from @gml/db", () => {
  const src = read(WORKER_PATH);
  assert.match(
    src,
    /import\s*\{[^}]*\bdeleteOldNotifications\b[^}]*\}\s*from\s*["']@gml\/db(?:\/scripts\/retention)?["']/,
    "apps/worker/src/index.ts must import deleteOldNotifications from @gml/db (root or /scripts/retention subpath)",
  );
});

test("spec 107: retention.ts exports deleteOldNotifications", () => {
  const src = read(RETENTION_PATH);
  assert.match(
    src,
    /export\s+async\s+function\s+deleteOldNotifications\b/,
    "packages/db/src/scripts/retention.ts must export an async function 'deleteOldNotifications'",
  );
});

test("spec 107: retention.ts preserves the SM-8 90-day retention contract", () => {
  const src = read(RETENTION_PATH);
  assert.match(src, /RETAIN_DAYS\s*=\s*90/);
  assert.match(src, /db\.delete\(notifications\)/);
  assert.match(src, /lt\(notifications\.createdAt/);
});

test("spec 107: retention.ts CLI entry point is guarded so imports don't auto-run", () => {
  const src = read(RETENTION_PATH);
  assert.match(
    src,
    // Allow other node:url imports alongside (spec 163 added fileURLToPath
    // for the basename-fallback in isDirectInvocation).
    /import\s*\{[^}]*\bpathToFileURL\b[^}]*\}\s*from\s*["']node:url["']/,
    "retention.ts must import pathToFileURL from node:url (other named imports OK)",
  );
  assert.match(
    src,
    /import\.meta\.url\s*===\s*pathToFileURL\(/,
    "retention.ts must guard auto-run with import.meta.url === pathToFileURL(...)",
  );
});

test("spec 107: db barrel does NOT re-export retention (would drag CLI code into web bundles)", () => {
  // Reverted in the build-stability follow-up: re-exporting retention.ts from
  // the @gml/db barrel pulled the CLI (process.exit guard + node:url import)
  // into every web-side import path that touched @gml/db, breaking
  // `next build`. Worker now imports via the explicit subpath
  // `@gml/db/scripts/retention`.
  const src = read(DB_BARREL_PATH);
  assert.ok(
    !/export\s*\{[^}]*\bdeleteOldNotifications\b[^}]*\}/.test(src),
    "packages/db/src/index.ts must NOT re-export deleteOldNotifications (use subpath @gml/db/scripts/retention)",
  );
});

test("spec 107: retention.ts uses the correct schema import path (no '../src/schema' typo)", () => {
  const src = read(RETENTION_PATH);
  assert.ok(
    !/from\s*["']\.\.\/src\/schema\//.test(src),
    "retention.ts must not import from '../src/schema/...' (that resolves to packages/db/src/src/...)",
  );
  assert.match(
    src,
    /from\s*["']\.\.\/schema\/notifications["']/,
    "retention.ts must import notifications from '../schema/notifications'",
  );
});

test("spec 107: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
