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

export type QueueName = "transcode" | "retention";

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
  },
): Promise<{ id: string; deduped: boolean }> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO jobs (queue, name, payload, dedupe_key, max_attempts, run_at)
    VALUES (
      ${opts.queue}, ${opts.name}, ${JSON.stringify(opts.payload)}::jsonb,
      ${opts.dedupeKey ?? null}, ${opts.maxAttempts ?? 3},
      ${opts.runAt ? opts.runAt.toISOString() : sql`now()`}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const inserted = (rows as unknown as { rows: { id: string }[] }).rows ?? [];
  if (inserted.length > 0) return { id: inserted[0]!.id, deduped: false };

  // The insert was absorbed by jobs_dedupe_live_uq. Hand back the live job so
  // the caller has an id to report.
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM jobs
     WHERE queue = ${opts.queue}
       AND dedupe_key = ${opts.dedupeKey ?? null}
       AND status IN ('queued', 'running')
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
 * Record a failure, and either schedule a retry or dead-letter it.
 *
 * Exponential backoff from 5s, matching what BullMQ was configured to do, so
 * the retry cadence does not silently change with the transport. A job that has
 * exhausted its attempts becomes 'dead' rather than 'failed' -- the two are
 * distinguished so the admin view can tell "will be retried" from "needs a
 * human", which the old DLQ page could not.
 */
export async function fail(
  db: NodePgDatabase<Record<string, unknown>>,
  jobId: string,
  error: string,
  attempts: number,
  maxAttempts: number,
): Promise<{ willRetry: boolean }> {
  const willRetry = attempts < maxAttempts;
  const backoffSeconds = Math.min(5 * 2 ** (attempts - 1), 3600);
  await db.execute(sql`
    UPDATE jobs
       SET status = ${willRetry ? "queued" : "dead"},
           last_error = ${error.slice(0, 4000)},
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
 * Requeue jobs whose worker stopped heartbeating.
 *
 * The case this exists for is a hard kill -- SIGKILL, OOM, the instance going
 * away -- where no catch block ran and nothing marked the job failed. Without
 * it those jobs sit 'running' forever and their videos never transcode.
 *
 * Reaped jobs keep their incremented attempt count, so a job that reliably
 * kills its worker dead-letters instead of looping forever.
 */
export async function reapExpiredLeases(
  db: NodePgDatabase<Record<string, unknown>>,
): Promise<number> {
  const res = await db.execute(sql`
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
           last_error = COALESCE(last_error, '') || ' [lease expired: worker stopped responding]',
           lease_expires_at = NULL,
           locked_by = NULL,
           updated_at = now()
     WHERE status = 'running' AND lease_expires_at < now()
     RETURNING id
  `);
  return ((res as unknown as { rows: unknown[] }).rows ?? []).length;
}

/** Depth by status, for the topbar chip and the admin DLQ view. */
export async function queueDepth(
  db: NodePgDatabase<Record<string, unknown>>,
  queue: QueueName,
): Promise<{ queued: number; running: number; dead: number }> {
  const res = await db.execute(sql`
    SELECT status, count(*)::int AS n
      FROM jobs
     WHERE queue = ${queue} AND status IN ('queued', 'running', 'dead')
     GROUP BY status
  `);
  const rows = ((res as unknown as { rows: { status: string; n: number }[] }).rows ?? []);
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { queued: get("queued"), running: get("running"), dead: get("dead") };
}

/**
 * Discard finished jobs.
 *
 * Mirrors BullMQ's removeOnComplete/removeOnFail so the table does not grow
 * without bound. Dead jobs are kept far longer than successes: a success is
 * noise once the video is playable, whereas a dead job is the only record that
 * something needs a human.
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
            AND completed_at < now() - make_interval(days => ${opts.deadOlderThanDays ?? 30}))
     RETURNING id
  `);
  return ((res as unknown as { rows: unknown[] }).rows ?? []).length;
}
