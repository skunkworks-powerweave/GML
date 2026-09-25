import "server-only";

// Producer side of the job queue.
//
// The web app only ever enqueues and reads depth -- exactly the two things
// BullMQ was used for across its five call sites. Consuming happens in
// apps/worker.
//
// REMOVING THE WORKER DEPENDENCY. apps/web declared `"@gml/worker":
// "workspace:*"` solely so these call sites could import `transcodeQueue`. That
// one line dragged BullMQ, ioredis and the whole worker tree into the web
// dependency graph and into the app container image. With the queue in @gml/db
// -- which apps/web already depends on -- the dependency goes away entirely.

import { sql } from "drizzle-orm";
import { db } from "@gml/db";
import { enqueue, queueDepth } from "@gml/db/queue";
import { ADMIN_ROLES, hasAnyRole, type RoleName } from "@gml/shared/auth/roles";

export type TranscodeJobInput = {
  videoSubmissionId: string;
  fileId: string;
  bucket: string;
  objectKey: string;
};

/**
 * Queue a transcode.
 *
 * The dedupe key is the submission id, scoped to live jobs by
 * jobs_dedupe_live_uq. Three producers call this -- the WhatsApp webhook, the
 * upload-completion route, and the operator Retry button -- and the first two
 * are both retried by systems outside our control (Meta re-delivers a webhook
 * it believes timed out; a browser re-POSTs a completion it lost). Without the
 * key those retries transcode the same video twice.
 *
 * Because the uniqueness is scoped to queued/running only, a deliberate retry
 * AFTER a job has finished is still allowed. That distinction is the whole
 * reason the index is partial.
 *
 * `database` lets a caller enqueue inside its own transaction (the DLQ Retry
 * does, so the status change and the job commit together or not at all).
 */
export async function enqueueTranscode(
  input: TranscodeJobInput,
  database: Parameters<typeof enqueue>[0] = db,
): Promise<void> {
  await enqueue(database, {
    queue: "transcode",
    name: "transcode",
    payload: input as unknown as Record<string, unknown>,
    dedupeKey: `submission:${input.videoSubmissionId}`,
  });
}

/**
 * Queue depth for the topbar chip, as `viewerRole` is shown it.
 *
 * Programme-wide numbers, so only the roles that can act on them see them --
 * everyone else gets zeros, which hide the chip, and costs no query. It used
 * to be loaded for every signed-in user, so after one bad upload every
 * teacher, mentor and observer carried an "N failed" chip for a month about
 * other people's videos, linking nowhere. The role is REQUIRED so that every
 * caller has to say who is looking.
 *
 * Returns zeros on failure rather than throwing. The chip is decoration; a
 * database hiccup must not take down every authenticated page's chrome. The
 * admin view distinguishes this from a real zero by rendering its own banner --
 * see loadDlqDepth there.
 */
export async function transcodeQueueDepth(viewerRole: RoleName): Promise<{
  queued: number;
  running: number;
  dead: number;
}> {
  if (!hasAnyRole(viewerRole, ADMIN_ROLES)) return { queued: 0, running: 0, dead: 0 };
  try {
    return await queueDepth(db, "transcode");
  } catch {
    return { queued: 0, running: 0, dead: 0 };
  }
}

export type DeadJob = {
  id: string;
  queue: string;
  name: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  completedAt: Date | null;
  /** For a transcode job, the video it was for. */
  videoSubmissionId: string | null;
};

/**
 * Jobs of EVERY queue that have exhausted their attempts: the ones that need a
 * human. For the admin DLQ view.
 *
 * That page listed only transcode_jobs, the per-attempt ledger, so a job that
 * died without a failed ledger row -- a transcode dead-lettered before its
 * handler wrote one, and every job on the retention queue, which has no ledger
 * at all -- was a number in the depth strip with nothing behind it, and
 * nothing anywhere read jobs.last_error.
 */
export async function deadJobs(limit = 50): Promise<DeadJob[]> {
  const res = await db.execute(sql`
    SELECT id, queue, name, attempts, max_attempts, last_error, completed_at,
           payload->>'videoSubmissionId' AS video_submission_id
      FROM jobs
     WHERE status = 'dead'
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT ${limit}
  `);
  return ((res as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((r) => ({
    id: String(r.id),
    queue: String(r.queue),
    name: String(r.name),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    lastError: (r.last_error as string | null) ?? null,
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
    videoSubmissionId: (r.video_submission_id as string | null) ?? null,
  }));
}

/** Same, but surfaces the failure so the admin view can say "unavailable". */
export async function transcodeQueueDepthOrNull(): Promise<{
  queued: number;
  running: number;
  dead: number;
} | null> {
  try {
    return await queueDepth(db, "transcode");
  } catch {
    return null;
  }
}
