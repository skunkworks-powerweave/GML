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

import { db } from "@gml/db";
import { enqueue, queueDepth } from "@gml/db/queue";

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
 */
export async function enqueueTranscode(input: TranscodeJobInput): Promise<void> {
  await enqueue(db, {
    queue: "transcode",
    name: "transcode",
    payload: input as unknown as Record<string, unknown>,
    dedupeKey: `submission:${input.videoSubmissionId}`,
  });
}

/**
 * Queue depth for the topbar chip and the admin DLQ view.
 *
 * Returns zeros on failure rather than throwing. The chip is decoration; a
 * database hiccup must not take down every authenticated page's chrome. The
 * admin view distinguishes this from a real zero by rendering its own banner --
 * see loadDlqDepth there.
 */
export async function transcodeQueueDepth(): Promise<{
  queued: number;
  running: number;
  dead: number;
}> {
  try {
    return await queueDepth(db, "transcode");
  } catch {
    return { queued: 0, running: 0, dead: 0 };
  }
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
