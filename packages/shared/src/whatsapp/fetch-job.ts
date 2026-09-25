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
 * The queue's fail() (packages/db/src/queue.ts) waits 1 min, 10 min, then an
 * hour before each retry, so four attempts keep retrying for about 71 minutes
 * -- enough to ride out a Graph or Storage outage, or an operator rotating an
 * expired token -- and the sender, who hears only when the last attempt fails,
 * hears within about an hour. Three, the queue default, gives up after 11
 * minutes. This was 10, chosen when the backoff started at 5 s and doubled
 * ("about 42 minutes"); against the current one that was about 7.2 hours.
 * Meta keeps the media for about 30 days, and a dead fetch can be re-queued
 * from /admin/whatsapp-log inside that window, because the media id is kept
 * on the submission. tests/behaviour/whatsapp-ingest.test.ts measures the
 * window on the real queue.
 */
export const WHATSAPP_FETCH_MAX_ATTEMPTS = 4;

/**
 * A reply to a message that needs no fetch -- one that is not a video. Queued
 * rather than sent from the webhook so the request stays database-only and the
 * reply survives a restart. Replies about a video are sent by the fetch itself,
 * once the outcome is known.
 */
export const WHATSAPP_REPLY_JOB = "whatsapp_reply" as const;

export type WhatsAppReplyPayload = { msgId: string; to: string; body: string };

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
