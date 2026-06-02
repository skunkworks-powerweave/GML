"use server";

// Spec 162 — DLQ admin server actions (Workflow Run 15 audit-closure MISS).
//
// Two operator verbs surfaced on /admin/transcode-jobs:
//
//   * retryTranscodeJobAction — re-enqueues a failed transcode_jobs row
//     onto the live BullMQ transcodeQueue with the same payload the
//     webhook / direct-upload code paths use. The DB row is left in
//     'failed' (the worker writes a NEW transcode_jobs row when it
//     picks the job up, so the attempt history is preserved as N
//     rows). An audit row 'transcode.retry_requested' captures the
//     operator's decision.
//
//   * dropTranscodeJobAction — flips the row to status='dropped' (the
//     terminal-non-actionable status added by migration 0021). No
//     re-enqueue; the BullMQ DLQ entry, if any, is left alone — Redis
//     ages it out via the queues.ts removeOnFail policy (7 days).
//
// Both actions share the same role gate as the page
// (programme_admin + super_admin), defence in depth against a
// hand-crafted POST from a non-admin session. The audit row carries
// the previous status + the BullMQ job id so /admin/audit can chain
// back to the affected job without an extra round-trip.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { transcodeJobs, videoSubmissions, files } from "@gml/db/schema";
import { transcodeQueue } from "@gml/worker/queues";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";

const DLQ_PATH = "/admin/transcode-jobs";

/**
 * Retry a failed transcode_jobs row by re-enqueueing it on BullMQ.
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

  // Recover the file row (bucket + object_key) for the BullMQ payload,
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

  // Only failed rows are retry-eligible. The page hides the Retry
  // button for other statuses, but defence in depth catches a
  // hand-crafted POST that targets a running / queued / succeeded /
  // dropped row.
  if (row.jobStatus !== "failed") {
    redirect(`${DLQ_PATH}?error=not_retriable_status`);
  }

  // Flip the parent submission back to 'queued' so the videos page
  // and the topbar queue indicator reflect the truth — BullMQ will
  // pick the job up shortly and the worker will move it through
  // 'transcoding' → 'ready' as normal.
  await db
    .update(videoSubmissions)
    .set({ status: "queued" })
    .where(eq(videoSubmissions.id, row.videoSubmissionId));

  // Re-enqueue with the same payload shape the webhook + direct-upload
  // call sites use. The 'source' carries through so the worker can
  // take its source-specific branches (whatsapp skips full re-encode).
  await transcodeQueue.add("transcode", {
    videoSubmissionId: row.videoSubmissionId,
    fileId: row.fileId,
    bucket: row.bucket,
    objectKey: row.objectKey,
    source: row.source,
  });

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
 * re-enqueueing. The BullMQ DLQ entry, if any, ages out via the
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
      bullJobId: transcodeJobs.bullJobId,
    })
    .from(transcodeJobs)
    .where(eq(transcodeJobs.id, jobId))
    .limit(1);

  if (!row) {
    redirect(`${DLQ_PATH}?error=job_not_found`);
  }

  // Drop only applies to failed rows — running / queued / succeeded
  // jobs must NOT be marked dropped (the worker is the only writer
  // for those statuses, and 'dropped' implies the operator already
  // saw a failure they don't want to retry).
  if (row.jobStatus !== "failed") {
    redirect(`${DLQ_PATH}?error=not_droppable_status`);
  }

  await db
    .update(transcodeJobs)
    .set({ status: "dropped", endedAt: new Date() })
    .where(eq(transcodeJobs.id, jobId));

  // Flip the parent submission to 'failed' so /videos surfaces tell
  // the truth — the operator decided this submission won't get a
  // playable HLS render. Mentors looking at the videos library see
  // a stable failure state rather than a misleadingly 'queued' row.
  await db
    .update(videoSubmissions)
    .set({ status: "failed" })
    .where(eq(videoSubmissions.id, row.videoSubmissionId));

  void recordAudit({
    action: "transcode.dropped",
    entityType: "transcode_job",
    entityId: jobId,
    metadata: {
      previousStatus: row.jobStatus,
      videoSubmissionId: row.videoSubmissionId,
      bullJobId: row.bullJobId,
    },
  });

  revalidatePath(DLQ_PATH);
  redirect(DLQ_PATH);
}
