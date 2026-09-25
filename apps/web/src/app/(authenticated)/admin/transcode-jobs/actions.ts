"use server";

// Spec 162 — DLQ admin server actions (Workflow Run 15 audit-closure MISS).
//
// Two operator verbs surfaced on /admin/transcode-jobs:
//
//   * retryTranscodeJobAction — re-enqueues a failed transcode_jobs row
//     onto the live transcode queue with the same payload the
//     webhook / direct-upload code paths use. The DB row is left in
//     'failed' (the worker writes a NEW transcode_jobs row when it
//     picks the job up, so the attempt history is preserved as N
//     rows). An audit row 'transcode.retry_requested' captures the
//     operator's decision.
//
//   * dropTranscodeJobAction — flips the row to status='dropped' (the
//     terminal-non-actionable status added by migration 0021). No
//     re-enqueue; the dead-letter queue entry, if any, is left alone — Redis
//     ages it out via the queues.ts removeOnFail policy (7 days).
//
// Both act only on a submission's LATEST attempt, while the submission itself
// is failed and nothing is queued or running for it -- see ./state.ts for why
// the attempt row's own status is not enough.
//
// Both actions share the same role gate as the page
// (programme_admin + super_admin), defence in depth against a
// hand-crafted POST from a non-admin session. The audit row carries
// the previous status + the job id so /admin/audit can chain
// back to the affected job without an extra round-trip.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { transcodeJobs, videoSubmissions, files } from "@gml/db/schema";
import { enqueueTranscode } from "@/lib/queue";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { cancelQueuedRetry, loadSubmissionStates, moveSubmission, refusalFor, verbsFor } from "./state";

const DLQ_PATH = "/admin/transcode-jobs";

/**
 * Retry a failed transcode_jobs row by re-enqueueing it on the queue.
 *
 * The payload mirrors api/webhooks/whatsapp/route.ts so the worker
 * processes it identically regardless of who triggered the retry.
 * We do NOT mutate the existing transcode_jobs row — the worker
 * INSERTs a fresh row when it picks up the job, so the original
 * 'failed' row stays as part of the attempt history. The audit
 * trail explains what happened on top of the row sequence.
 */
export async function retryTranscodeJobAction(formData: FormData): Promise<void> {
  await requireRole(["programme_admin", "super_admin"]);

  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) {
    redirect(`${DLQ_PATH}?error=missing_job_id`);
  }

  // Recover the file row (bucket + object_key) for the job payload,
  // alongside the job's previous status and video_submission_id for
  // the audit metadata. Single round-trip joining all three tables.
  const [row] = await db
    .select({
      jobId: transcodeJobs.id,
      jobStatus: transcodeJobs.status,
      videoSubmissionId: transcodeJobs.videoSubmissionId,
      source: videoSubmissions.source,
      fileId: videoSubmissions.fileId,
      bucket: files.bucket,
      objectKey: files.objectKey,
    })
    .from(transcodeJobs)
    .innerJoin(
      videoSubmissions,
      eq(transcodeJobs.videoSubmissionId, videoSubmissions.id),
    )
    .innerJoin(files, eq(videoSubmissions.fileId, files.id))
    .where(eq(transcodeJobs.id, jobId))
    .limit(1);

  if (!row) {
    redirect(`${DLQ_PATH}?error=job_not_found`);
  }

  // Eligibility is the SUBMISSION's, not this row's (see ./state.ts): only the
  // latest attempt of a submission that is failed now, with nothing queued or
  // running for it. Re-checked here under a lock on the submission row, then
  // written compare-and-set, because the page that rendered the button may be
  // minutes old -- and a Retry on a superseded failed row used to un-ready a
  // playable video and transcode it again.
  const refusal = await db.transaction(async (tx) => {
    const state = (await loadSubmissionStates(tx, [row.videoSubmissionId], { forUpdate: true })).get(
      row.videoSubmissionId,
    );
    const attempt = { jobId: row.jobId, status: row.jobStatus };
    if (!verbsFor(attempt, state).retry) return refusalFor(attempt, state);

    // Flip the parent submission back to 'queued' so the videos page and the
    // topbar queue indicator reflect the truth -- the worker will pick the job
    // up shortly and move it through 'transcoding' -> 'ready' as normal.
    if (!(await moveSubmission(tx, row.videoSubmissionId, ["failed"], "queued"))) {
      return "submission_not_failed";
    }

    // Re-enqueue with the same payload the webhook and direct-upload call sites
    // use. `source` is no longer carried: the worker used to branch on it to take
    // a `-c copy` shortcut for WhatsApp video, which failed outright on arbitrary
    // phone-camera output and, when it worked, preserved a multi-megabit stream
    // on the path that exists to serve low bandwidth. Every source is re-encoded.
    //
    // The dedupe key is scoped to LIVE jobs, so this deliberate retry is allowed
    // even though the submission has been enqueued before -- which is exactly the
    // distinction jobs_dedupe_live_uq's partial predicate exists to make.
    await enqueueTranscode(
      {
        videoSubmissionId: row.videoSubmissionId,
        fileId: row.fileId,
        bucket: row.bucket,
        objectKey: row.objectKey,
      },
      tx as unknown as Parameters<typeof enqueueTranscode>[1],
    );
    return null;
  });
  if (refusal) redirect(`${DLQ_PATH}?error=${refusal}`);

  void recordAudit({
    action: "transcode.retry_requested",
    entityType: "transcode_job",
    entityId: jobId,
    metadata: {
      previousStatus: row.jobStatus,
      videoSubmissionId: row.videoSubmissionId,
      bucket: row.bucket,
      objectKey: row.objectKey,
      source: row.source,
    },
  });

  revalidatePath(DLQ_PATH);
  redirect(DLQ_PATH);
}

/**
 * Permanently drop a failed transcode_jobs row.
 *
 * Marks the row 'dropped' (status added in migration 0021) without
 * re-enqueueing. The dead-letter queue entry, if any, ages out via the
 * queues.ts removeOnFail age:7d policy — we don't try to delete it
 * from Redis here because the DB is the source of truth for the
 * audit story, and Redis aging is already configured.
 */
export async function dropTranscodeJobAction(formData: FormData): Promise<void> {
  await requireRole(["programme_admin", "super_admin"]);

  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) {
    redirect(`${DLQ_PATH}?error=missing_job_id`);
  }

  const [row] = await db
    .select({
      jobId: transcodeJobs.id,
      jobStatus: transcodeJobs.status,
      videoSubmissionId: transcodeJobs.videoSubmissionId,
    })
    .from(transcodeJobs)
    .where(eq(transcodeJobs.id, jobId))
    .limit(1);

  if (!row) {
    redirect(`${DLQ_PATH}?error=job_not_found`);
  }

  // Same rule as Retry (./state.ts), re-checked under a lock on the
  // submission. Drop used to accept any row whose own status was 'failed' and
  // then write status='failed' unconditionally -- so dropping the old failed
  // attempt of a video that a later attempt had made ready broke a playable
  // video, and for a direct upload nothing in the product could undo it.
  const refusal = await db.transaction(async (tx) => {
    const state = (await loadSubmissionStates(tx, [row.videoSubmissionId], { forUpdate: true })).get(
      row.videoSubmissionId,
    );
    if (!verbsFor({ jobId: row.jobId, status: row.jobStatus }, state).drop) {
      return refusalFor({ jobId: row.jobId, status: row.jobStatus }, state);
    }
    // A retry the queue is still holding goes with the drop. If a worker took
    // it between the read above and here, it is running now: refuse.
    if (state?.liveJob === "queued" && !(await cancelQueuedRetry(tx, row.videoSubmissionId))) {
      return "job_live";
    }

    await tx
      .update(transcodeJobs)
      .set({ status: "dropped", endedAt: new Date() })
      .where(eq(transcodeJobs.id, jobId));

    // The parent submission ends 'failed' (from 'queued' when a retry was
    // pending), so /videos surfaces tell the truth -- the operator decided this
    // submission won't get a playable HLS render. Compare-and-set, so it can
    // never be written over a result.
    await moveSubmission(tx, row.videoSubmissionId, ["failed", "queued"], "failed");
    return null;
  });
  if (refusal) redirect(`${DLQ_PATH}?error=${refusal}`);

  void recordAudit({
    action: "transcode.dropped",
    entityType: "transcode_job",
    entityId: jobId,
    metadata: {
      previousStatus: row.jobStatus,
      videoSubmissionId: row.videoSubmissionId,
    },
  });

  revalidatePath(DLQ_PATH);
  redirect(DLQ_PATH);
}
