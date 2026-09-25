/**
 * The contract between the WhatsApp webhook (producer) and the worker's media
 * fetch (consumer), in the one place both can import.
 *
 * ── WHY THE FETCH IS A JOB ───────────────────────────────────────────────────
 *
 * The webhook used to answer Meta 200 and then do everything inside Next's
 * after(): the Graph lookup, the download, the Storage put and the
 * video_submissions insert. Meta redelivers only a webhook that did NOT get a
 * 2xx, so from the moment of that 200 the recording existed only in a closure.
 * A blank or expired WHATSAPP_ACCESS_TOKEN, a Graph 5xx, a Storage error or a
 * container restart during a deploy lost it for good, with no row to find and
 * no media id kept to fetch it again.
 *
 * Now the webhook writes the submission and this job in one transaction and
 * only then answers 200, and the worker does the network work, where the
 * queue's retries, backoff and dead-lettering apply.
 */

/** The Postgres queue the fetch runs on (packages/db/src/queue.ts). */
export const WHATSAPP_QUEUE = "whatsapp" as const;

/** Handler name within that queue (apps/worker/src/index.ts dispatches on it). */
export const WHATSAPP_FETCH_JOB = "whatsapp_fetch" as const;

/**
 * Attempts before the fetch is dead-lettered.
 *
 * The queue backs off exponentially from 5 s (5, 10, 20 ... capped at an hour),
 * so ten attempts keep retrying for about 42 minutes -- enough to ride out a
 * Graph or Storage outage, or an operator rotating an expired token. Three, the
 * queue default, gives up after 15 seconds. Meta keeps the media for about 30
 * days, and a dead fetch can be re-queued from /admin/whatsapp-log inside that
 * window, because the media id is kept on the submission.
 */
export const WHATSAPP_FETCH_MAX_ATTEMPTS = 10;

/** One live fetch per WhatsApp message (jobs_dedupe_live_uq). */
export function whatsappFetchDedupeKey(msgId: string): string {
  return `wa:${msgId}`;
}

export type WhatsAppFetchPayload = {
  /** Meta's wamid, which is also video_submissions.whatsapp_message_id. */
  msgId: string;
  videoSubmissionId: string;
  fileId: string;
  bucket: string;
  objectKey: string;
  /** Graph media id: GET /{mediaId} answers with a short-lived download URL. */
  mediaId: string;
  mimeType: string;
  /** Meta's checksum of the media, when the payload carried one. */
  sha256: string | null;
  /** The sender's number as Meta delivers it (E.164 digits, no "+"). */
  from: string;
};
