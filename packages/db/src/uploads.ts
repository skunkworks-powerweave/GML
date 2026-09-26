// Finishing a direct upload: the one place that turns "the bytes are in
// Storage" into a queued transcode.
//
// Two callers reach this point. The browser's completion call
// (apps/web/src/lib/video/upload.ts, completeUpload) is the normal path; the
// worker's reconciler (apps/worker/src/reconcile-uploads.ts) is the backstop
// for a completion call that never arrived -- a tab closed after the last
// chunk, a phone that lost coverage on the way home. They used to carry
// separate copies of this transition, and the reconciler's copy never wrote the
// observation_evidence row. So a lesson video whose completion call was lost
// transcoded and played, and never appeared on the cycle page -- the one place
// the observer looks for it.
//
// The transition is one transaction that first CLAIMS the submission with a
// conditional UPDATE. The browser and the reconciler can therefore race
// without double-inserting evidence or queueing two transcodes: whichever
// commits first moves the row on, and the other claims nothing.
//
// Linking a verified video to what it is FOR (linkSubmissionToContext, below)
// is shared with the WhatsApp path too: the worker's fetch
// (apps/worker/src/whatsapp-fetch.ts) is where a WhatsApp video's bytes are
// verified, and it runs the same function inside its own claim. The webhook
// used to carry its own copy of "record a submission and queue its transcode"
// with no link step at all, so a WhatsApp lesson video captioned with its cycle
// code never reached the cycle's Evidence card -- the same drift this file
// already describes for the reconciler.

import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditLog, files, mentorMeetings, observationCycles, observationEvidence, videoSubmissions } from "./schema";
import { enqueue } from "./queue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = NodePgDatabase<any>;

/**
 * How long a reservation whose bytes are complete waits for the browser's own
 * completion call before the reconciler finishes it instead. The browser's call
 * carries the uploader's caption, which the reconciler cannot know.
 */
export const UPLOAD_COMPLETE_GRACE_MINUTES = 10;

/**
 * How long a reservation stays open for its bytes.
 *
 * This used to be 30 minutes, after which the reconciler failed any upload
 * whose object was not yet in Storage. A resumable object only appears when the
 * LAST byte lands, so every upload that took longer than 30 minutes was failed
 * while it was still transferring. The programme's default cap is 500 MB, and
 * at the ~20 KB/s a 2G link sustains that is about seven hours. A day covers it
 * with room for a teacher who picks the file again the next morning:
 * beginUpload hands the same reservation back for the same file inside this
 * window, and tus carries on from where it stopped.
 *
 * The cost of waiting is only that an abandoned reservation reads "uploading"
 * for up to a day before it is marked failed.
 */
export const UPLOAD_ABANDON_AFTER_HOURS = 24;

/**
 * More bytes in Storage than the browser declared.
 *
 * The declared size is the one beginUpload checked against the programme's
 * configured cap, so the cap only holds if the stored size is bounded by it.
 * There used to be no upper bound at all: a modified client could declare 1 MB
 * and send up to the bucket's 2 GB limit, and the transcode the cap protects
 * (one EC2 host's ffmpeg and disk) was queued. A browser declares file.size,
 * which is exactly what tus sends, so a genuine upload is never over.
 */
export function isOversize(storedBytes: number, expectedBytes: number | null): boolean {
  return expectedBytes != null && storedBytes > expectedBytes;
}

/** Storage reports what it holds; allow 1% below what the browser declared, and nothing above it. */
export function isCompleteSize(storedBytes: number, expectedBytes: number | null): boolean {
  if (isOversize(storedBytes, expectedBytes)) return false;
  return expectedBytes == null || storedBytes >= Math.floor(expectedBytes * 0.99);
}

export type ReconcileDecision = "complete" | "fail" | "wait";

/**
 * What the reconciler should do with a reservation that is still waiting.
 *
 * `storedBytes` is null when Storage has no object at the key. An upload in
 * flight looks exactly like an abandoned one until the abandonment window has
 * passed, so the absence of bytes is never, on its own, a reason to fail.
 */
export function reconcileDecision(input: {
  ageSeconds: number;
  storedBytes: number | null;
  expectedBytes: number | null;
}): ReconcileDecision {
  // An oversized object is final: a resumable object appears only once its
  // last byte lands, so waiting cannot make it the size that was declared. And
  // it must not be finished here, or skipping the completion call would be a
  // way round the cap.
  if (input.storedBytes !== null && isOversize(input.storedBytes, input.expectedBytes)) return "fail";
  if (input.storedBytes !== null && isCompleteSize(input.storedBytes, input.expectedBytes)) {
    return input.ageSeconds >= UPLOAD_COMPLETE_GRACE_MINUTES * 60 ? "complete" : "wait";
  }
  return input.ageSeconds >= UPLOAD_ABANDON_AFTER_HOURS * 3600 ? "fail" : "wait";
}

export type FinalizeUploadInput = {
  submissionId: string;
  fileId: string;
  bucket: string;
  objectKey: string;
  /** What Storage actually holds, not what the browser claimed. */
  storedBytes: number;
  /** As the caller read them. What is linked is the claimed row's own context. */
  contextType: string;
  contextId: string | null;
  /** The uploader's note, when the browser sent one: kept on the submission and on a cycle's evidence row. */
  caption?: string | null;
};

export type ContextLink = {
  submissionId: string;
  contextType: string;
  contextId: string | null;
  /** The uploader's note, or the WhatsApp caption, for the evidence row. */
  caption?: string | null;
};

/**
 * Link a submission whose bytes are verified to the thing it is for. Run
 * inside the caller's claim, so it happens once per submission, and in the
 * same transaction as the transcode it queues.
 *
 *   observation_cycle  an observation_evidence row: the cycle page's Evidence
 *                      card reads only that table. Not for a cycle that has
 *                      been signed off (the locking transition) in the
 *                      meantime -- the video is kept, the closed record is not
 *                      reopened, and the video is made 'generic' again
 *                      (audited video.context.unlinked). Left claiming the
 *                      cycle, it was on no Evidence card, read "Linked to
 *                      OBS-..." on its uploader's /uploads, and could not be
 *                      attached anywhere else, since only a generic video can.
 *   mentor_meeting     the meeting's recording_video_id, which nothing used to
 *                      write, when it is empty: the first recording. A later
 *                      one (the next part of a long meeting, a replacement)
 *                      does not swap it; the pairing page lists every
 *                      'mentor_meeting' submission stored for the meeting.
 *   mentee_quarterly   nothing to write. The submission itself is the
 *                      pairing's quarterly video (context_id = the pairing,
 *                      context_quarter = 1 or 4).
 *
 * A parent that no longer exists links nothing rather than failing: context_id
 * carries no foreign key, and a failure here would roll back the claim -- on
 * the WhatsApp path, after the bytes were already stored.
 */
export async function linkSubmissionToContext(tx: AnyDb, link: ContextLink): Promise<void> {
  if (!link.contextId) return;
  if (link.contextType === "observation_cycle") {
    const caption = link.caption?.trim() ? link.caption.trim().slice(0, 500) : null;
    await tx.execute(sql`
      INSERT INTO ${observationEvidence} (cycle_id, video_submission_id, caption)
      SELECT ${observationCycles.id}, ${link.submissionId}::uuid, ${caption}
        FROM ${observationCycles}
       WHERE ${observationCycles.id} = ${link.contextId}::uuid
         AND ${observationCycles.status} <> 'complete'
         AND NOT EXISTS (SELECT 1 FROM ${observationEvidence} WHERE ${observationEvidence.videoSubmissionId} = ${link.submissionId}::uuid)`);
    // Signed off while the video was on its way: hand it back to its uploader.
    const unlinked = await tx
      .update(videoSubmissions)
      .set({ contextType: "generic", contextId: null, contextQuarter: null })
      .where(
        and(
          eq(videoSubmissions.id, link.submissionId),
          sql`EXISTS (SELECT 1 FROM ${observationCycles} WHERE ${observationCycles.id} = ${link.contextId}::uuid AND ${observationCycles.status} = 'complete')`,
          sql`NOT EXISTS (SELECT 1 FROM ${observationEvidence} WHERE ${observationEvidence.videoSubmissionId} = ${link.submissionId}::uuid)`,
        ),
      )
      .returning({ id: videoSubmissions.id });
    if (unlinked.length > 0) {
      await tx.insert(auditLog).values({
        action: "video.context.unlinked",
        entityType: "video_submission",
        entityId: link.submissionId,
        metadata: { contextType: link.contextType, contextId: link.contextId, reason: "observation_cycle.signed_off" },
      });
    }
    return;
  }
  if (link.contextType === "mentor_meeting") {
    await tx
      .update(mentorMeetings)
      .set({ recordingVideoId: link.submissionId })
      .where(and(eq(mentorMeetings.id, link.contextId), isNull(mentorMeetings.recordingVideoId)));
  }
}

/**
 * Give one of the uploader's own 'generic' submissions a context, and link it
 * if its bytes are already stored. The caller has authorised the target (the
 * web's assertContextAllowed); this only moves a row that is still generic and
 * still the uploader's, so it cannot take a video off the evidence it is on or
 * move someone else's. A submission whose bytes have not arrived yet is linked
 * by its own finalize, which reads the context from the row. A failed one is
 * not moved: its bytes never came, or it will not play, and a cycle's Evidence
 * or a meeting is no place for either.
 *
 * Returns false when there was nothing to move.
 */
export async function attachSubmissionToContext(
  db: AnyDb,
  a: { submissionId: string; userId: string; contextType: string; contextId: string; quarter: number | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [moved] = await tx
      .update(videoSubmissions)
      .set({ contextType: a.contextType, contextId: a.contextId, contextQuarter: a.quarter })
      .where(
        and(
          eq(videoSubmissions.id, a.submissionId),
          eq(videoSubmissions.submittedByUserId, a.userId),
          eq(videoSubmissions.contextType, "generic"),
          ne(videoSubmissions.status, "failed"),
        ),
      )
      .returning({ id: videoSubmissions.id, fileId: videoSubmissions.fileId, captionRaw: videoSubmissions.captionRaw });
    if (!moved) return false;
    const [file] = await tx.select({ status: files.status }).from(files).where(eq(files.id, moved.fileId)).limit(1);
    if (file?.status === "stored") {
      await linkSubmissionToContext(tx as unknown as AnyDb, {
        submissionId: moved.id,
        contextType: a.contextType,
        contextId: a.contextId,
        caption: moved.captionRaw,
      });
    }
    return true;
  });
}

/**
 * Move a verified upload to 'queued', link it to what it is for, and queue the
 * transcode -- atomically.
 *
 * Claims only a submission that is still waiting for its bytes ('received'),
 * or one the reconciler gave up on ('failed' with its FILE also 'failed', which
 * only the reconciler writes). A submission the transcoder failed keeps its
 * file 'stored', so it is not revived by a late completion call.
 *
 * Returns `finalized: false` when there was nothing to claim, i.e. another
 * caller finished it first.
 */
export async function finalizeUpload(db: AnyDb, u: FinalizeUploadInput): Promise<{ finalized: boolean }> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(videoSubmissions)
      .set({
        status: "queued",
        processingLog: sql`CASE WHEN ${videoSubmissions.status} = 'failed'
          THEN 'upload arrived after it was reconciled as abandoned; resumed ' || now()::text
          ELSE ${videoSubmissions.processingLog} END`,
      })
      .where(
        and(
          eq(videoSubmissions.id, u.submissionId),
          or(
            eq(videoSubmissions.status, "received"),
            and(
              eq(videoSubmissions.status, "failed"),
              sql`EXISTS (SELECT 1 FROM ${files} WHERE ${files.id} = ${videoSubmissions.fileId} AND ${files.status} = 'failed')`,
            ),
          ),
        ),
      )
      .returning({ id: videoSubmissions.id, contextType: videoSubmissions.contextType, contextId: videoSubmissions.contextId });
    const sub = claimed[0];
    if (!sub) return { finalized: false };

    await tx.update(files).set({ status: "stored", sizeBytes: u.storedBytes }).where(eq(files.id, u.fileId));

    // The uploader's note, on the submission itself, whatever the video is
    // for. It used to be written only onto a cycle's evidence row, so the
    // caption the phone flow asks for ("so your mentor knows what this is")
    // was discarded for a meeting recording, a quarterly video or anything
    // else; /videos/[id] shows this column.
    const note = u.caption?.trim() ? u.caption.trim().slice(0, 500) : null;
    if (note) {
      await tx
        .update(videoSubmissions)
        .set({ captionRaw: note })
        .where(and(eq(videoSubmissions.id, u.submissionId), isNull(videoSubmissions.captionRaw)));
    }

    // LINK THE VIDEO TO WHAT IT IS FOR. Written here, when the bytes are known
    // to exist, so an abandoned upload never leaves a row promising evidence
    // that was never delivered. The claim above is what keeps this from
    // double-inserting. The context is the claimed row's own, read under its
    // lock: an upload attached to a cycle while its bytes were still arriving
    // (attachSubmissionToContext) is linked to that cycle, not to what the
    // caller read before.
    await linkSubmissionToContext(tx as unknown as AnyDb, {
      submissionId: u.submissionId,
      contextType: sub.contextType,
      contextId: sub.contextId,
      caption: u.caption,
    });

    // Same dedupe key as every other producer (apps/web/src/lib/queue.ts), so
    // a completion that also reaches the webhook or Retry paths cannot queue a
    // second live job for this submission.
    await enqueue(tx as unknown as AnyDb, {
      queue: "transcode",
      name: "transcode",
      payload: {
        videoSubmissionId: u.submissionId,
        fileId: u.fileId,
        bucket: u.bucket,
        objectKey: u.objectKey,
      },
      dedupeKey: `submission:${u.submissionId}`,
    });
    return { finalized: true };
  });
}
