// Postgres-backed job queue.
//
// WHY NOT BULLMQ. The queue it replaces was BullMQ on Redis, and Redis was one
// of eight services in a stack that had to run on a single EC2 box in Leh. Its
// throughput requirement is under 100 jobs/day. `SELECT ... FOR UPDATE SKIP
// LOCKED` over a partial index handles that with five orders of magnitude to
// spare, and removing Redis removes a whole service, its volume, its healthcheck
// and its failure modes.
//
// It also removes a specific, live defect: `getRedis()` set
// `maxRetriesPerRequest: null` with no `commandTimeout` and the default offline
// queue, so with Redis down commands QUEUED FOREVER rather than rejecting. The
// documented fail-closed `catch` in rate-limit.ts was unreachable, and every
// login request hung instead of failing.
//
// WHY NOT pgmq. pgmq is the right tool at thousands of messages per second and
// the wrong shape here: the existing DLQ page does a typed Drizzle join from
// jobs to video_submissions to files, which over pgmq means raw SQL against
// `pgmq.q_*` with JSONB extraction -- more code than the table it would replace.
// Max-attempts, backoff and dead-lettering are hand-built on `read_ct` either
// way.
//
// `transcode_jobs` KEEPS ITS SHAPE and its meaning. It is the per-attempt
// domain ledger that /admin/transcode-jobs renders; this table is the
// transport. Conflating them is what made `bull_job_id` a column that four
// files read and nothing ever wrote.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Logical queue name, e.g. "transcode" or "retention". */
    queue: varchar("queue", { length: 64 }).notNull(),

    /** Handler discriminator within the queue. */
    name: varchar("name", { length: 64 }).notNull(),

    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),

    /** queued | running | succeeded | failed | dead */
    status: varchar("status", { length: 16 }).notNull().default("queued"),

    /** Not before this moment. Drives both scheduling and retry backoff. */
    runAt: timestamp("run_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),

    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),

    /**
     * A claimed job's lease. Heartbeated by the worker while it runs.
     *
     * This is what BullMQ's stalled-job detection did, and it is not optional
     * here: a 40-minute ffmpeg run must not be reaped as abandoned, and a job
     * whose worker was hard-killed must not stay 'running' forever. The reaper
     * requeues anything whose lease has lapsed.
     */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),

    /** Which worker holds the lease. Diagnostic only. */
    lockedBy: varchar("locked_by", { length: 128 }),

    /**
     * Producer-side idempotency key.
     *
     * Unique among LIVE jobs only (see the partial index below), so the same
     * logical job can be enqueued again after a previous one finished -- which
     * is exactly what an operator "Retry" is. This is what lets the WhatsApp
     * webhook and the upload-complete route both fire twice safely: Meta
     * retries on timeout, and a browser retries a lost completion POST.
     */
    dedupeKey: varchar("dedupe_key", { length: 200 }),

    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    // THE claim index. The worker's hot query is
    //   WHERE queue = $1 AND status = 'queued' AND run_at <= now()
    //   ORDER BY run_at
    // and a partial index over exactly that predicate keeps it an index scan of
    // the runnable set rather than a scan of every job ever enqueued.
    index("jobs_claim_idx")
      .on(t.queue, t.runAt)
      .where(sql`status = 'queued'`),

    // Reaper lookup: running jobs whose lease has lapsed.
    index("jobs_lease_idx")
      .on(t.leaseExpiresAt)
      .where(sql`status = 'running'`),

    // Producer idempotency, scoped to live jobs.
    uniqueIndex("jobs_dedupe_live_uq")
      .on(t.queue, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND status IN ('queued', 'running')`),

    // Admin views and depth counts.
    index("jobs_status_idx").on(t.status, t.createdAt),

    // Created by migration 0024 and declared here so the snapshot describes
    // the database (F107): the schema is what drizzle-kit diffs against.
    check("jobs_status_check", sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'dead')`),
    check("jobs_attempts_check", sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1`),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
