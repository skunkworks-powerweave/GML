// What a person reads for the video pipeline's stored values.
//
// A submission's status, its context type and its source are enum values in
// video_submissions, and the pages used to print them as stored ("teach back",
// "whatsapp", "review pending") -- in English whatever language the viewer had
// picked. The values stay data; these give the label from the page's
// translator (getTranslations("video")): video.status.*, video.contextType.*
// and video.sourceName. A value this code does not know is shown as stored.

/** A translator for the "video" namespace, as getTranslations("video") returns. */
export type VideoTranslate = (key: string, values?: Record<string, string | number>) => string;

const STATUSES: ReadonlySet<string> = new Set([
  "received",
  "queued",
  "transcoding",
  "ready",
  "failed",
  "review_pending",
  "reviewed",
]);

const CONTEXT_TYPES: ReadonlySet<string> = new Set([
  "observation_cycle",
  "teach_back",
  "mentor_meeting",
  "mentee_quarterly",
  "classroom_session",
  "generic",
]);

/** "ready", "review pending", ... in the viewer's language. */
export function statusLabel(t: VideoTranslate, status: string): string {
  return STATUSES.has(status) ? t(`status.${status}`) : status;
}

/** "observation cycle", "teach back", ... in the viewer's language. */
export function contextTypeLabel(t: VideoTranslate, contextType: string): string {
  return CONTEXT_TYPES.has(contextType) ? t(`contextType.${contextType}`) : contextType.replace("_", " ");
}

/** "whatsapp", "direct", ... in the viewer's language (WhatsApp stays a name). */
export function sourceLabel(t: VideoTranslate, source: string): string {
  return t("sourceName", { source });
}
