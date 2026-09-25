// @gml/worker — Postgres queue consumer.
//
// Polls `jobs` for runnable work, runs it, heartbeats a lease while it does,
// and requeues anything a dead worker left behind. Also runs the two scheduled
// sweeps (retention, upload reconciliation) on a plain interval.
//
// ── WHY NOT BULLMQ / REDIS ───────────────────────────────────────────────────
//
// Redis was one of eight services expected to run on a single box in Leh, for a
// workload under 100 jobs/day. Removing it removes a service, a volume, a
// healthcheck, a dependency in two package manifests and — via
// `"@gml/worker": "workspace:*"` in apps/web — the reason the entire worker
// tree was being pulled into the web application's container image.
//
// It also removes the failure mode described at length in lib/rate-limit.ts:
// the shared ioredis client queued commands indefinitely when Redis was down
// instead of rejecting, so the documented fail-closed path was unreachable and
// login requests hung.
//
// ── WHAT REPLACED WHAT ───────────────────────────────────────────────────────
//
//   BullMQ Worker            -> claim() with FOR UPDATE SKIP LOCKED
//   stalled-job detection    -> lease + heartbeat + reapExpiredLeases()
//   attempts/backoff         -> fail() (exponential from one minute, not 5 s)
//   removeOnComplete/Fail    -> pruneFinished()
//   repeat: { pattern }      -> a setInterval in this file
//
// That last one is worth a word. The cron registration was `repeat: { cron }`
// until the job queue 5 renamed the option to `pattern`; the old name was a TYPE ERROR
// that survived undetected because this package ran through tsx, which strips
// types without checking them, and a back-compat shim aliased it at runtime.
// The bug was invisible in both directions. An interval in ordinary code that
// the typechecker reads has no equivalent hiding place.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { db } from "@gml/db";
import {
  boundedError,
  claim,
  enqueue,
  fail,
  PermanentJobError,
  heartbeat,
  pruneFinished,
  reapExpiredLeases,
  release,
  succeed,
  HEARTBEAT_SECONDS,
  LEASE_SECONDS,
  type ClaimedJob,
} from "@gml/db/queue";
import { deleteOldNotifications, pruneRateLimits } from "@gml/db/scripts/retention";
import { repairReapedTranscodes, sweepStaleScratch, transcode480p } from "./transcode.js";
import { reconcileStalledUploads } from "./reconcile-uploads.js";
import { log } from "./log.js";

export type TranscodeJobInput = {
  videoSubmissionId: string;
  fileId: string;
  bucket: string;
  objectKey: string;
};

// Clamp WORKER_CONCURRENCY into [1, 16].
//
// Unbounded, this had three distinct failure modes: 0 disabled the worker
// entirely so jobs piled up with no consumer, a non-numeric value parsed to NaN
// and the worker refused to start, and a large value spawned that many
// concurrent ffmpeg processes and OOM-killed the container.
//
// The DEPLOYED value should be 1, not the 2 the docs used to suggest: one
// ffmpeg at `-preset veryfast` saturates both vCPUs of the target instance, and
// a second starves the web tier it shares the box with. Queue depth absorbs
// bursts — that is what a queue is for.
const CONCURRENCY = Math.max(
  1,
  Math.min(Number.parseInt(process.env.WORKER_CONCURRENCY ?? "1", 10) || 1, 16),
);

/** Idle sleep between empty polls. */
const POLL_IDLE_MS = 2000;

const WORKER_ID = `${process.env.HOSTNAME ?? "worker"}-${randomUUID().slice(0, 8)}`;

/**
 * Aborted when shutdown begins. It stops the consumer loops, cuts their idle
 * sleeps short, and interrupts every job in flight (see runJob).
 */
const stopping = new AbortController();
const shuttingDown = () => stopping.signal.aborted;

/** Ids of the jobs being worked on right now, for the shutdown log line. */
const inFlight = new Set<string>();

/**
 * How long a shutdown may take before the process gives up and exits. MUST
 * stay below the worker's `stop_grace_period` in docker-compose.yml (30 s),
 * after which Docker sends SIGKILL and nothing below gets to run.
 */
const DRAIN_DEADLINE_MS = 20_000;

/** A sleep that ends early when shutdown begins, so a drain is not held up by it. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      stopping.signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    stopping.signal.addEventListener("abort", done);
    if (stopping.signal.aborted) done();
  });
}

/** Dispatch a claimed job to its handler. Throws whatever the handler throws. */
async function handle(job: ClaimedJob): Promise<void> {
  switch (job.name) {
    case "transcode":
      // The same test fail() uses to decide between a retry and the DLQ.
      await transcode480p(job.payload as unknown as TranscodeJobInput, {
        finalAttempt: job.attempts >= job.maxAttempts,
        signal: stopping.signal,
      });
      break;
    // The nightly retention sweep. The name predates the second table; it is
    // kept because scheduleDailyWork() enqueues it and its dedupe key is what
    // makes the sweep once-per-day.
    case "deleteOldNotifications": {
      const n = await deleteOldNotifications();
      log.info("retention: notifications purged", { count: n });
      // rate_limits keys carry client IPs. Nothing pruned them before this
      // line: the old reaper lived in apps/web behind `server-only`, where
      // this process cannot reach it. Both deletes are idempotent, so a retry
      // after a failure here re-running the first is harmless.
      const r = await pruneRateLimits(undefined, db);
      log.info("retention: expired rate-limit counters purged", { count: r });
      break;
    }
    default:
      throw new Error(`unknown job name: ${job.name}`);
  }
}

/** Tries at writing a job's outcome before leaving the job to the lease reaper. */
const OUTCOME_WRITE_ATTEMPTS = 3;

/**
 * Run one claimed job, holding its lease open for as long as it takes.
 *
 * NEVER REJECTS, and the consumer loop depends on that. It used to await the
 * outcome writes -- succeed(), and fail() inside the catch -- unguarded, so
 * when Postgres refused that one write (read-only mode under disk pressure, a
 * statement error on a live connection, a pooler reset) the rejection escaped
 * the consumer's `while` and ended it. With WORKER_CONCURRENCY=1 that was the
 * only transcode consumer. The retention loop kept the process alive and the
 * healthcheck green, so restart policy never fired and no video was transcoded
 * again until someone restarted the container by hand.
 *
 * The handler's outcome is decided first and recorded second, so a transcode
 * that worked is never recorded as failed because only succeed() hit the blip.
 * If the write still fails after a few tries the job is left 'running' with
 * its heartbeat stopped: its lease lapses and reapExpiredLeases() requeues or
 * dead-letters it, the recovery path a hard-killed worker already takes.
 *
 * A job that failed BECAUSE shutdown interrupted it has no outcome: it is
 * handed back to the queue with release(), its attempt uncounted, rather than
 * recorded as a failure.
 */
async function runJob(job: ClaimedJob, lockedBy: string): Promise<void> {
  const hb = setInterval(() => {
    void heartbeat(db, job.id, LEASE_SECONDS).catch((err) =>
      log.warn("heartbeat failed", { job: job.id, err: String(err) }),
    );
  }, HEARTBEAT_SECONDS * 1000);
  // Do not hold the event loop open just for the heartbeat.
  hb.unref?.();

  let failure: { err: unknown } | null = null;
  try {
    await handle(job);
  } catch (err) {
    failure = { err };
  } finally {
    clearInterval(hb);
  }
  const interrupted = failure !== null && shuttingDown();

  for (let attempt = 1; ; attempt += 1) {
    try {
      if (interrupted) {
        const released = await release(db, job.id, lockedBy);
        log.warn("job interrupted by shutdown; handed back to the queue", { id: job.id, name: job.name, released });
      } else if (failure === null) {
        await succeed(db, job.id);
        log.info("job succeeded", { id: job.id, name: job.name, attempt: job.attempts });
      } else {
        // A PermanentJobError (a corrupt source, no picture) is not retried:
        // every attempt would re-download it and fail identically.
        const { willRetry } = await fail(db, job.id, String(failure.err), job.attempts, job.maxAttempts, {
          retryable: !(failure.err instanceof PermanentJobError),
        });
        log.error("job failed", {
          id: job.id,
          name: job.name,
          attempt: job.attempts,
          willRetry,
          err: boundedError(String(failure.err), 500),
        });
      }
      return;
    } catch (err) {
      if (attempt >= OUTCOME_WRITE_ATTEMPTS) {
        log.error("could not record job outcome; the lease reaper will requeue it", {
          id: job.id,
          name: job.name,
          outcome: interrupted ? "released" : failure === null ? "succeeded" : "failed",
          handlerErr: failure === null ? undefined : String(failure.err).slice(0, 500),
          err: String(err).slice(0, 500),
        });
        return;
      }
      await sleep(POLL_IDLE_MS * attempt);
    }
  }
}

/**
 * One consumer loop.
 *
 * `queue` is a parameter because the QueueName union has always had two members
 * and only one had a consumer -- anything enqueued onto "retention" would have
 * sat there forever with nothing claiming it. A type that invites you to write
 * a job nobody will run is worse than no type.
 */
async function consumer(queue: "transcode" | "retention", slot: number): Promise<void> {
  const lockedBy = `${WORKER_ID}#${queue}#${slot}`;
  while (!shuttingDown()) {
    let job: ClaimedJob | null = null;
    try {
      job = await claim(db, queue, lockedBy);
    } catch (err) {
      log.error("claim failed", { err: String(err) });
      await sleep(POLL_IDLE_MS * 5);
      continue;
    }
    if (!job) {
      await sleep(POLL_IDLE_MS);
      continue;
    }
    // A claim that was already on its way when shutdown began: hand it
    // straight back rather than start work that is about to be interrupted.
    if (shuttingDown()) {
      await release(db, job.id, lockedBy).catch((err) =>
        log.warn("could not hand back a job claimed during shutdown", { id: job.id, err: String(err) }),
      );
      break;
    }
    inFlight.add(job.id);
    try {
      await runJob(job, lockedBy);
    } catch (err) {
      // runJob does not reject by construction. Should that ever stop being
      // true, this loop must still outlive the job: a consumer that ends
      // quietly is the one failure nothing else here can see.
      log.error("job runner threw; consumer continuing", { job: job.id, err: String(err).slice(0, 500) });
      await sleep(POLL_IDLE_MS * 5);
    } finally {
      inFlight.delete(job.id);
    }
  }
}

/**
 * Periodic housekeeping.
 *
 * The reaper is the important one: it is what turns a hard-killed worker from
 * "these videos never transcode" into "these videos transcode a bit later".
 */
async function housekeeping(): Promise<void> {
  try {
    // The transcode handler's own rows are repaired in the reaper's transaction
    // (see repairReapedTranscodes).
    const reaped = await reapExpiredLeases(db, repairReapedTranscodes);
    const requeued = reaped.filter((r) => !r.dead);
    const dead = reaped.filter((r) => r.dead);
    if (requeued.length > 0) log.warn("requeued jobs with expired leases", { count: requeued.length });
    // Said separately: this used to be logged as "requeued" too, for jobs that
    // will never run again and need a human.
    if (dead.length > 0) {
      log.error("dead-lettered jobs with expired leases (attempts exhausted)", {
        count: dead.length,
        jobs: dead.map((r) => `${r.name}:${r.id}`),
      });
    }
    const pruned = await pruneFinished(db);
    if (pruned > 0) log.info("pruned finished jobs", { count: pruned });
    // Backstop for direct uploads whose completion call never arrived.
    await reconcileStalledUploads();
  } catch (err) {
    log.error("housekeeping failed", { err: String(err) });
  }
}

/** Hour (UTC) the nightly retention sweep should run. */
const RETENTION_HOUR_UTC = 3;

/**
 * The nightly retention sweep, enqueued rather than run inline.
 *
 * Going through the queue means it inherits leases, retries and the DLQ view,
 * and -- because the dedupe key is the calendar date -- every worker replica
 * can run this check without the job running more than once per day. (A fixed
 * jobId, which is what the job queue used, is unique FOREVER, so day two would collide
 * with day one; scoping to the date is what makes "once per day" actually hold.)
 *
 * THE HOUR IS CHECKED, not just the date. Enqueuing on the first tick after
 * date rollover would silently move the sweep from the 03:00 UTC that spec 107
 * committed to, to roughly midnight UTC -- which is 05:30 IST, inside the
 * morning window when Ladakh mentors are actually checking their devices. The
 * whole point of 03:00 UTC (08:30 IST) was to sit behind that.
 */
async function scheduleDailyWork(): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() < RETENTION_HOUR_UTC) return;

  const today = now.toISOString().slice(0, 10);
  try {
    await enqueue(db, {
      queue: "retention",
      name: "deleteOldNotifications",
      payload: {},
      dedupeKey: `retention:${today}`,
      maxAttempts: 2,
    });
  } catch (err) {
    log.error("could not schedule retention", { err: String(err) });
  }
}

async function main(): Promise<void> {
  log.info("online", {
    worker: WORKER_ID,
    concurrency: CONCURRENCY,
    transport: "postgres",
  });

  const timers = [
    setInterval(() => void housekeeping(), 60_000),
    // Checked hourly; the dedupe key makes it idempotent, so the exact tick
    // does not matter and a restart cannot double-run it.
    setInterval(() => void scheduleDailyWork(), 60 * 60_000),
  ];
  for (const t of timers) t.unref?.();

  void housekeeping();
  void scheduleDailyWork();

  // Scratch a hard-killed attempt left on the persistent worker_scratch volume.
  // Past the lease, the reaper has taken that attempt's job back already.
  void sweepStaleScratch(LEASE_SECONDS * 1000)
    .then((n) => n > 0 && log.warn("removed scratch left by killed transcodes", { count: n }))
    .catch((err) => log.warn("scratch sweep failed", { err: String(err) }));

  // SIGTERM handling -- a deploy, a rollback, `docker compose stop`.
  //
  // It used to WAIT up to 30 s for in-flight work. A transcode takes minutes,
  // and Docker SIGKILLs after the service's stop grace (10 s by default, and
  // none was set), so every deploy during a transcode hard-killed ffmpeg: the
  // job stayed 'running' for up to its fifteen-minute lease, the next worker
  // was charged one of its three attempts, the ledger row was orphaned and
  // the scratch directory leaked. Now shutdown INTERRUPTS: ffmpeg is killed,
  // the attempt is recorded 'cancelled' and its scratch removed, and the job
  // goes straight back to the queue uncounted (runJob, release()) -- all in
  // seconds, well inside the 30 s stop_grace_period compose now sets.
  const shutdown = (signal: string) => {
    if (shuttingDown()) return;
    log.info("shutting down", { signal, inFlight: inFlight.size });
    for (const t of timers) clearInterval(t);
    stopping.abort();
    const deadline = setTimeout(() => {
      log.warn("drain timed out; exiting anyway");
      process.exit(1);
    }, DRAIN_DEADLINE_MS);
    deadline.unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // An unhandled rejection used to take the process down with no log line, so a
  // crash-looping worker looked identical to one that had never started. It is
  // logged -- and then it is still fatal. Logging it and carrying on is what
  // turned a dead consumer loop into a process that stayed up, passed its
  // healthcheck and never claimed again: `restart: unless-stopped` is the only
  // supervisor this worker has, and it acts on an exit, nothing else.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { reason: String(reason).slice(0, 500) });
    process.exit(1);
  });

  await Promise.all([
    // Transcode gets the configured concurrency; retention is housekeeping and
    // needs exactly one runner.
    ...Array.from({ length: CONCURRENCY }, (_, i) => consumer("transcode", i)),
    consumer("retention", 0),
  ]);
  // A consumer only returns once shutdown has begun, after handing back
  // whatever it was running -- so when they have all returned, the drain is
  // done. Anything else is a loop that ended, and must end the process too.
  if (!shuttingDown()) {
    log.error("a consumer loop exited without a shutdown; exiting so the container restarts");
    process.exit(1);
  }
  log.info("drained");
  process.exit(0);
}

// Only start when this file IS the process entrypoint. apps/web no longer
// imports @gml/worker, but the package still exports this module, and a
// top-level `void main()` meant any future import would silently boot a polling
// worker inside the importing process -- including inside a Next.js server.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // A rejected main() is a consumer that died; see the end of main().
  main().catch((err) => {
    log.error("worker main loop failed; exiting so the container restarts", {
      err: String(err).slice(0, 500),
    });
    process.exit(1);
  });
}
