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

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions, files } from "@gml/db/schema";
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
