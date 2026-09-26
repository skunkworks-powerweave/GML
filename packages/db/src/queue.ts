// Job queue operations on Postgres.
//
// Lives in @gml/db because it is pure database work and both apps/web (the
// producer) and apps/worker (the consumer) need it. The surface it replaces is
// small -- BullMQ was reached through exactly two methods across five call
// sites, `.add()` and `.getJobCounts()`.
//
// ── THE CLAIM ────────────────────────────────────────────────────────────────
//
// `SELECT ... FOR UPDATE SKIP LOCKED` inside the UPDATE is what makes this a
// queue rather than a race. Two workers running the same statement cannot claim
// the same row: the second skips the row the first has locked instead of
// blocking on it, so throughput scales with workers and neither waits.
//
// ── THE LEASE ────────────────────────────────────────────────────────────────
//
// A claimed job carries `lease_expires_at`, heartbeated while it runs. This is
// the job BullMQ's stalled-job detection did, and it is not optional:
//
//   * without a lease, a worker killed mid-ffmpeg leaves a job 'running'
//     forever and the video never transcodes;
//   * with a naive timeout instead of a heartbeat, a legitimate 40-minute
//     ffmpeg run gets reaped and re-queued while it is still working, and the
//     queue transcodes the same video repeatedly until it gives up.
//
// So: long lease, heartbeated. The reaper only requeues jobs whose worker has
// genuinely stopped saying it is alive.

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// "whatsapp" carries the webhook's media fetches (apps/worker/src/whatsapp-fetch.ts).
// Its own queue, so a fetch is not stuck behind a 40-minute ffmpeg run on the
// single transcode slot while the teacher waits to hear the video arrived.
//
// A value as well as a type, so the worker can start a consumer for every
// member (apps/worker/src/index.ts, consumerSlots) and a test can check it.
export const QUEUE_NAMES = ["transcode", "retention", "whatsapp"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export type ClaimedJob = {
  id: string;
  queue: string;
  name: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
};

/** Default lease. Long enough for a slow transcode of a long video. */
export const LEASE_SECONDS = 15 * 60;

/** How often a running worker should extend its lease. */
export const HEARTBEAT_SECONDS = 60;

/**
 * Add a job.
 *
 * `dedupeKey` makes the producer idempotent against the partial unique index
 * over live jobs. This is what lets the WhatsApp webhook and the upload
 * completion route both fire twice safely -- Meta retries a webhook it thinks
 * timed out, and a browser retries a completion POST it lost. Returns the
 * existing job's id on a duplicate rather than erroring, so the caller cannot
 * tell the difference and does not need to.
 */
export async function enqueue(
  db: NodePgDatabase<Record<string, unknown>>,
  opts: {
    queue: QueueName;
    name: string;
    payload: Record<string, unknown>;
    dedupeKey?: string | null;
    maxAttempts?: number;
    runAt?: Date;
    /**
     * At most ONE job per dedupe key, whatever became of it -- not only while
     * one is live. For schedule keys such as `retention:<date>`: the partial
     * index covers queued/running only, so once the day's sweep had finished
     * the next hourly tick (and every restart) enqueued and ran it again.
     * NOT for transcodes, whose operator Retry depends on a finished job not
     * blocking a new one. Two replicas racing still meet the partial index.
     */
    once?: boolean;
  },
): Promise<{ id: string; deduped: boolean }> {
  const key = opts.dedupeKey ?? null;
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO jobs (queue, name, payload, dedupe_key, max_attempts, run_at)
    SELECT
      ${opts.queue}, ${opts.name}, ${JSON.stringify(opts.payload)}::jsonb,
      ${key}, ${opts.maxAttempts ?? 3},
      ${opts.runAt ? opts.runAt.toISOString() : sql`now()`}
    WHERE ${opts.once === true && key !== null
      ? sql`NOT EXISTS (SELECT 1 FROM jobs WHERE queue = ${opts.queue} AND dedupe_key = ${key})`
      : sql`true`}
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const inserted = (rows as unknown as { rows: { id: string }[] }).rows ?? [];
  if (inserted.length > 0) return { id: inserted[0]!.id, deduped: false };

  // The insert was absorbed: by jobs_dedupe_live_uq, or (with `once`) by a
  // job that already ran. Hand that job back so the caller has an id to report.
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM jobs
     WHERE queue = ${opts.queue}
       AND dedupe_key = ${key}
       ${opts.once === true ? sql`` : sql`AND status IN ('queued', 'running')`}
     ORDER BY created_at DESC
     LIMIT 1
  `);
  const found = (existing as unknown as { rows: { id: string }[] }).rows ?? [];
  return { id: found[0]?.id ?? "", deduped: true };
}

/**
 * Claim the next runnable job, atomically.
 *
 * One statement. The inner SELECT picks the oldest runnable row and locks it
 * with SKIP LOCKED; the outer UPDATE flips it to running and stamps the lease.
 * There is no window between choosing and claiming in which another worker
 * could take the same job.
 */
export async function claim(
  db: NodePgDatabase<Record<string, unknown>>,
  queue: QueueName,
  workerId: string,
  leaseSeconds = LEASE_SECONDS,
): Promise<ClaimedJob | null> {
  const res = await db.execute(sql`
    UPDATE jobs
       SET status           = 'running',
           attempts         = attempts + 1,
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           locked_by        = ${workerId},
           updated_at       = now()
     WHERE id = (
       SELECT id FROM jobs
        WHERE queue = ${queue}
          AND status = 'queued'
          AND run_at <= now()
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING id, queue, name, payload, attempts, max_attempts
  `);
  const rows = (res as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    queue: String(r.queue),
    name: String(r.name),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  };
}

/** Extend a running job's lease. Called on a timer while the handler works. */
export async function heartbeat(
  db: NodePgDatabase<Record<string, unknown>>,
  jobId: string,
  leaseSeconds = LEASE_SECONDS,
): Promise<void> {
  await db.execute(sql`
    UPDATE jobs
       SET lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           updated_at = now()
     WHERE id = ${jobId}::uuid AND status = 'running'
  `);
}

export async function succeed(
  db: NodePgDatabase<Record<string, unknown>>,
  jobId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE jobs
       SET status = 'succeeded', completed_at = now(), updated_at = now(),
           lease_expires_at = NULL, locked_by = NULL
     WHERE id = ${jobId}::uuid
  `);
}

/**
 * A failure no retry can fix -- a corrupt source, a file with no picture.
 * Thrown by a handler so that fail() dead-letters the job at once instead of
 * spending its remaining attempts (each one re-downloading the source over the
 * Leh uplink) on the same result.
 */
export class PermanentJobError extends Error {
  override name = "PermanentJobError";
}

/**
 * An error bounded to `max` characters, keeping its first line AND its end.
 *
 * Errors here put the verdict LAST -- ffmpeg's final lines, the reaper's
 * appended note -- and every column and log line used to keep the head, so a
 * long ffmpeg failure lost exactly the lines that said why, and a short one
 * kept 1800 characters of version banner.
 */
export function boundedError(error: string, max = 4000): string {
  if (error.length <= max) return error;
  const nl = error.indexOf("\n");
  const head = nl > 0 && nl < max / 4 ? error.slice(0, nl) : error.slice(0, Math.floor(max / 8));
  const gap = "\n…\n";
  return head + gap + error.slice(-(max - head.length - gap.length));
}

/**
 * Record a failure, and either schedule a retry or dead-letter it.
 *
 * Exponential backoff from ONE MINUTE: 1 min, 10 min, then an hour. It was
 * 5 s, 10 s -- carried over from the BullMQ config -- which spent a job's whole
 * budget of three attempts inside about fifteen seconds, so a one-minute
 * Storage or pooler blip dead-lettered every transcode that started during it
 * and an operator had to retry each by hand. A retry is re-downloading a
 * source over the Leh uplink; spacing them out is the point. A job that has
 * exhausted its attempts becomes 'dead' rather than 'failed' -- the two are
 * distinguished so the admin view can tell "will be retried" from "needs a
 * human", which the old DLQ page could not. `retryable: false` (a
 * PermanentJobError) dead-letters at once, whatever attempts remain.
 */
export async function fail(
  db: NodePgDatabase<Record<string, unknown>>,
  jobId: string,
  error: string,
  attempts: number,
  maxAttempts: number,
  opts: { retryable?: boolean } = {},
): Promise<{ willRetry: boolean }> {
  const willRetry = opts.retryable !== false && attempts < maxAttempts;
  const backoffSeconds = Math.min(60 * 10 ** (attempts - 1), 3600);
  await db.execute(sql`
    UPDATE jobs
       SET status = ${willRetry ? "queued" : "dead"},
           last_error = ${boundedError(error)},
           run_at = ${willRetry ? sql`now() + make_interval(secs => ${backoffSeconds})` : sql`run_at`},
           completed_at = ${willRetry ? null : sql`now()`},
           lease_expires_at = NULL,
           locked_by = NULL,
           updated_at = now()
     WHERE id = ${jobId}::uuid
  `);
  return { willRetry };
}

/**
 * Hand a claimed job straight back to the queue, as though it had never been
 * claimed: runnable now, lease cleared, and its attempt NOT counted.
 *
 * For a worker that is shutting down (a deploy, a restart, `docker compose
 * stop`). Without it the job sat 'running' behind its lease for up to fifteen
 * minutes and the next worker was charged one of its three attempts for an
 * operator's restart. Fenced on `locked_by`, so it can never touch a job that
 * has since been reaped and claimed by someone else. True when released.
 */
export async function release(
  db: NodePgDatabase<Record<string, unknown>>,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE jobs
       SET status = 'queued', attempts = GREATEST(attempts - 1, 0), run_at = now(),
           lease_expires_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = ${jobId}::uuid AND status = 'running' AND locked_by = ${workerId}
     RETURNING id
  `);
  return ((res as unknown as { rows: unknown[] }).rows ?? []).length > 0;
}

/** A job the reaper took back from a worker that stopped heartbeating. */
export type ReapedJob = {
  id: string;
  queue: string;
  name: string;
  payload: Record<string, unknown>;
  /** True when its attempts were exhausted, so it was dead-lettered, not requeued. */
  dead: boolean;
  /** Why `onReaped` failed for this job, if it did: its repair was rolled back, its reaping was not. */
  repairError?: string;
};

/** The transaction handle reapExpiredLeases() gives its `onReaped` callback. */
export type QueueTx = Parameters<
  Parameters<NodePgDatabase<Record<string, unknown>>["transaction"]>[0]
>[0];

/**
 * Requeue jobs whose worker stopped heartbeating.
 *
 * The case this exists for is a hard kill -- SIGKILL, OOM, the instance going
 * away -- where no catch block ran and nothing marked the job failed. Without
 * it those jobs sit 'running' forever and their videos never transcode.
 *
 * Reaped jobs keep their incremented attempt count, so a job that reliably
 * kills its worker dead-letters instead of looping forever. A dead-letter sets
 * completed_at exactly as fail() does: pruneFinished() keys on it, and without
 * it a reaper-dead job -- and the 'N failed' chip that counts it -- stayed
 * forever. The WhatsApp health count of fetches that gave up (dead, completed
 * in the last 24 hours) keys on it too, and never saw a reaper-dead fetch.
 *
 * `onReaped` runs in the SAME transaction, once per reaped job. This module
 * only knows the transport; the handler that was killed also left domain rows
 * behind (a transcode's ledger row 'running', its video 'transcoding'), and
 * nothing but this moment knows that its worker is gone. Repairing them here,
 * atomically, means a job is never requeued or dead-lettered while its domain
 * rows still claim it is running.
 *
 * Each job's repair runs in a SAVEPOINT of its own. They used to share the
 * batch's transaction, so one repair that threw -- a payload id that is not a
 * uuid fails its query with 22P02 -- rolled back the reaping of EVERY job in
 * the batch, on every queue, and did so again on every housekeeping tick: no
 * expired lease was ever reaped again. Now that job's repair is rolled back
 * and reported in `repairError`, and it is reaped regardless, like the rest.
 */
export async function reapExpiredLeases(
  db: NodePgDatabase<Record<string, unknown>>,
  onReaped?: (tx: QueueTx, job: ReapedJob) => Promise<void>,
): Promise<ReapedJob[]> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      UPDATE jobs
         SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
             completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
             last_error = COALESCE(last_error, '') || ' [lease expired: worker stopped responding]',
             lease_expires_at = NULL,
             locked_by = NULL,
             updated_at = now()
       WHERE status = 'running' AND lease_expires_at < now()
       RETURNING id, queue, name, payload, status
    `);
    const reaped: ReapedJob[] = ((res as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((r) => ({
      id: String(r.id),
      queue: String(r.queue),
      name: String(r.name),
      payload: (r.payload ?? {}) as Record<string, unknown>,
      dead: r.status === "dead",
    }));
    for (const job of onReaped ? reaped : []) {
      try {
        // A nested drizzle transaction is a SAVEPOINT, rolled back on a throw.
        await tx.transaction((sp) => onReaped!(sp, job));
      } catch (err) {
        job.repairError = String(err);
      }
    }
    return reaped;
  });
}

/**
 * A dead `jobs` row that still needs a human: nothing has replaced it. Retry,
 * Retry fetch and every later producer enqueue a NEW job under the same dedupe
 * key and leave the dead one behind as history; counting those kept the
 * "N failed" chip, the DLQ list and WhatsApp's "gave up" count on failures an
 * operator had already dealt with, for the 30 days pruneFinished keeps them.
 * The outer table must be `jobs`, unaliased.
 */
export const UNRESOLVED_DEAD_SQL = `status = 'dead' AND NOT EXISTS (
  SELECT 1 FROM jobs newer
   WHERE newer.queue = jobs.queue AND newer.dedupe_key = jobs.dedupe_key AND newer.created_at > jobs.created_at)`;

/** Depth by status, for the topbar chip and the admin DLQ view. */
export async function queueDepth(
  db: NodePgDatabase<Record<string, unknown>>,
  queue: QueueName,
): Promise<{ queued: number; running: number; dead: number }> {
  const res = await db.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
           count(*) FILTER (WHERE status = 'running')::int AS running,
           count(*) FILTER (WHERE ${sql.raw(UNRESOLVED_DEAD_SQL)})::int AS dead
      FROM jobs
     WHERE queue = ${queue} AND status IN ('queued', 'running', 'dead')
  `);
  const [row] = (res as unknown as { rows: { queued: number; running: number; dead: number }[] }).rows ?? [];
  return { queued: row?.queued ?? 0, running: row?.running ?? 0, dead: row?.dead ?? 0 };
}

/**
 * Discard finished jobs.
 *
 * Mirrors BullMQ's removeOnComplete/removeOnFail so the table does not grow
 * without bound. Dead jobs are kept far longer than successes: a success is
 * noise once the video is playable, whereas a dead job is the only record that
 * something needs a human.
 *
 * A dead job's age falls back to updated_at: the reaper dead-lettered jobs
 * without setting completed_at until it was fixed, and `completed_at < ...` is
 * never true of NULL, so every such row stayed -- in the 'N failed' chip and
 * the DLQ list -- for good. updated_at is when it was reaped (health.ts counts
 * those rows the same way).
 */
export async function pruneFinished(
  db: NodePgDatabase<Record<string, unknown>>,
  opts: { succeededOlderThanHours?: number; deadOlderThanDays?: number } = {},
): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM jobs
     WHERE (status = 'succeeded'
            AND completed_at < now() - make_interval(hours => ${opts.succeededOlderThanHours ?? 24}))
        OR (status = 'dead'
            AND COALESCE(completed_at, updated_at) < now() - make_interval(days => ${opts.deadOlderThanDays ?? 30}))
     RETURNING id
  `);
  return ((res as unknown as { rows: unknown[] }).rows ?? []).length;
}
