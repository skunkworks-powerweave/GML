"use server";

// Spec 126 — Resend transcode server action for the WhatsApp ingest log.
//
// One-shot action: operator clicks "Resend transcode" on a stuck row in
// /admin/whatsapp-log, this re-enqueues the transcode job for the
// same submission. Same payload shape as the webhook (spec 105) so the
// existing worker (apps/worker/src/index.ts) processes it identically.
//
// Role gate is the same as the page (programme_admin + super_admin). The
// audit row carries the previous status as metadata so a future operator
// can tell "why was this resent?" from the audit log alone.
//
// Retry fetch (retryWhatsAppFetchAction) is the other half: a row whose media
// was never downloaded -- a Graph error, a missing or expired access token --
// has nothing to transcode, so it gets its fetch queued again instead.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@gml/db";
import { enqueue } from "@gml/db/queue";
import { videoSubmissions, files } from "@gml/db/schema";
import {
  WHATSAPP_FETCH_JOB,
  WHATSAPP_FETCH_MAX_ATTEMPTS,
  WHATSAPP_QUEUE,
  whatsappFetchDedupeKey,
  type WhatsAppFetchPayload,
} from "@gml/shared/whatsapp/fetch-job";
import { enqueueTranscode } from "@/lib/queue";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";

const WHATSAPP_LOG_PATH = "/admin/whatsapp-log";

export async function resendTranscodeAction(formData: FormData): Promise<void> {
  await requireRole(["programme_admin", "super_admin"]);

  const submissionId = String(formData.get("submissionId") ?? "").trim();
  if (!submissionId) {
    redirect(`${WHATSAPP_LOG_PATH}?error=missing_submission_id`);
  }

  // Single round-trip to recover the file row (we need bucket + object_key
  // for the the job queue payload). The join is filtered to source='whatsapp' so
  // the action is a no-op for non-WhatsApp submissions even if a malformed
  // form submission targets one.
  const [row] = await db
    .select({
      submissionId: videoSubmissions.id,
      source: videoSubmissions.source,
      status: videoSubmissions.status,
      fileId: videoSubmissions.fileId,
      bucket: files.bucket,
      objectKey: files.objectKey,
      fileStatus: files.status,
    })
    .from(videoSubmissions)
    .innerJoin(files, eq(videoSubmissions.fileId, files.id))
    .where(eq(videoSubmissions.id, submissionId))
    .limit(1);

  if (!row) {
    redirect(`${WHATSAPP_LOG_PATH}?error=submission_not_found`);
  }

  if (row.source !== "whatsapp") {
    // The page only renders Resend buttons for source='whatsapp' rows,
    // but defend against a hand-crafted form submission targeting a
    // direct-upload or external-link submission.
    redirect(`${WHATSAPP_LOG_PATH}?error=not_whatsapp_source`);
  }

  // Flip the row back to 'queued' so the surface refreshes truthfully —
  // the worker will pick it up momentarily. We skip the flip on ready/reviewed
  // states; the page hides the button for those anyway, but defence in
  // depth keeps the action idempotent if an operator double-clicks.
  const previousStatus = row.status;
  if (
    previousStatus === "ready" ||
    previousStatus === "reviewed" ||
    previousStatus === "review_pending"
  ) {
    redirect(`${WHATSAPP_LOG_PATH}?error=cannot_resend_finalised`);
  }

  // A transcode of bytes that were never fetched can only fail. Since the
  // webhook records a submission BEFORE its media is downloaded, a row can be
  // 'received' or 'failed' with no object in Storage; that row needs Retry
  // fetch, which the page offers instead of this button.
  if (row.fileStatus !== "stored") {
    redirect(`${WHATSAPP_LOG_PATH}?error=media_not_fetched`);
  }

  await db
    .update(videoSubmissions)
    .set({ status: "queued" })
    .where(eq(videoSubmissions.id, submissionId));

  // Re-enqueue. Same payload as the webhook's own call.
  await enqueueTranscode({
    videoSubmissionId: submissionId,
    fileId: row.fileId,
    bucket: row.bucket,
    objectKey: row.objectKey,
  });

  void recordAudit({
    action: "whatsapp.transcode.resent",
    entityType: "video_submission",
    entityId: submissionId,
    metadata: {
      previousStatus,
      bucket: row.bucket,
      objectKey: row.objectKey,
    },
  });

  revalidatePath(WHATSAPP_LOG_PATH);
  redirect(WHATSAPP_LOG_PATH);
}

/**
 * Queue the Graph fetch again for a WhatsApp video whose media never arrived.
 *
 * The fetch runs on the worker's queue with backoff, and dead-letters after
 * WHATSAPP_FETCH_MAX_ATTEMPTS -- a token that expired overnight exhausts them
 * long before anyone fixes it. Meta keeps the media for about 30 days, and the
 * media id is on the submission, so once the cause is fixed the operator can
 * fetch it again from here instead of asking the teacher to resend.
 *
 * A fetch still waiting on its backoff is moved to the front rather than
 * duplicated (the queue dedupes live jobs on the message id).
 */
export async function retryWhatsAppFetchAction(formData: FormData): Promise<void> {
  await requireRole(["programme_admin", "super_admin"]);

  const submissionId = String(formData.get("submissionId") ?? "").trim();
  if (!submissionId) redirect(`${WHATSAPP_LOG_PATH}?error=missing_submission_id`);

  const [row] = await db
    .select({
      source: videoSubmissions.source,
      status: videoSubmissions.status,
      msgId: videoSubmissions.whatsappMessageId,
      mediaId: videoSubmissions.whatsappMediaId,
      from: videoSubmissions.whatsappFrom,
      fileId: files.id,
      bucket: files.bucket,
      objectKey: files.objectKey,
      mimeType: files.mimeType,
      sha256: files.checksumSha256,
      fileStatus: files.status,
    })
    .from(videoSubmissions)
    .innerJoin(files, eq(videoSubmissions.fileId, files.id))
    .where(eq(videoSubmissions.id, submissionId))
    .limit(1);

  if (!row) redirect(`${WHATSAPP_LOG_PATH}?error=submission_not_found`);
  if (row.source !== "whatsapp") redirect(`${WHATSAPP_LOG_PATH}?error=not_whatsapp_source`);
  // Rows from before migration 0036 kept no media id; nothing can fetch them.
  if (!row.msgId || !row.mediaId) redirect(`${WHATSAPP_LOG_PATH}?error=no_media_id`);
  if (row.fileStatus === "stored") redirect(`${WHATSAPP_LOG_PATH}?error=already_fetched`);

  const payload: WhatsAppFetchPayload = {
    msgId: row.msgId,
    videoSubmissionId: submissionId,
    fileId: row.fileId,
    bucket: row.bucket,
    objectKey: row.objectKey,
    mediaId: row.mediaId,
    mimeType: row.mimeType,
    sha256: row.sha256,
    from: row.from ?? "",
  };
  const job = await db.transaction(async (tx) => {
    await tx.update(videoSubmissions).set({ status: "received" }).where(eq(videoSubmissions.id, submissionId));
    await tx.update(files).set({ status: "uploading" }).where(eq(files.id, row.fileId));
    const queued = await enqueue(tx as unknown as NodePgDatabase<Record<string, unknown>>, {
      queue: WHATSAPP_QUEUE,
      name: WHATSAPP_FETCH_JOB,
      payload: payload as unknown as Record<string, unknown>,
      dedupeKey: whatsappFetchDedupeKey(payload.msgId),
      maxAttempts: WHATSAPP_FETCH_MAX_ATTEMPTS,
    });
    if (queued.deduped && queued.id) {
      await tx.execute(sql`UPDATE jobs SET run_at = now(), updated_at = now() WHERE id = ${queued.id}::uuid AND status = 'queued'`);
    }
    return queued;
  });

  void recordAudit({
    action: "whatsapp.fetch.retried",
    entityType: "video_submission",
    entityId: submissionId,
    metadata: { previousStatus: row.status, msgId: row.msgId, mediaId: row.mediaId, jobId: job.id, deduped: job.deduped },
  });

  revalidatePath(WHATSAPP_LOG_PATH);
  redirect(WHATSAPP_LOG_PATH);
}
