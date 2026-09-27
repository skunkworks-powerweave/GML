// How a SCORM record reads on a page: status words, chip colours, durations,
// sizes. Shared by the learner's subject page and the staff pages so the two
// never describe the same record differently.
//
// The words are the "rtt" namespace's (rtt.scorm.*): pass the page's
// translator, `await getTranslations("rtt")`, and they come in the viewer's
// language. Without one they are the English of the same bundle, so a page
// not yet handing its translator in still reads as before.

import { FINISHED_STATUSES } from "./cmi";
import { englishRtt as english, type RttTranslate } from "./messages";

export type { RttTranslate };

/** lesson_status values (lib/scorm/cmi.ts) -> their key under rtt.scorm.status. */
const STATUS_KEYS: Record<string, string> = {
  passed: "passed",
  completed: "completed",
  failed: "failed",
  incomplete: "incomplete",
  browsed: "browsed",
  "not attempted": "notAttempted",
};

export const statusLabel = (status: string, t: RttTranslate = english): string =>
  STATUS_KEYS[status] ? t(`scorm.status.${STATUS_KEYS[status]}`) : status;

export const statusChip = (status: string): string =>
  status === "passed" || status === "completed" ? "chip chip-lichen" : status === "failed" ? "chip chip-rust" : "chip";

/** What the launch button says: a finished module is reopened to review it. */
export const launchLabel = (status: string, t: RttTranslate = english): string =>
  t(FINISHED_STATUSES.has(status) ? "scorm.launch.review" : status === "not attempted" ? "scorm.launch.start" : "scorm.launch.resume");

/** Centiseconds as "1 h 05 min", "12 min" or "40 s". */
export function formatDuration(cs: number, t: RttTranslate = english): string {
  const s = Math.floor(cs / 100);
  if (s >= 3600) {
    return t("scorm.duration.hours", { hours: Math.floor(s / 3600), minutes: String(Math.floor((s % 3600) / 60)).padStart(2, "0") });
  }
  if (s >= 60) return t("scorm.duration.minutes", { minutes: Math.floor(s / 60) });
  return t("scorm.duration.seconds", { seconds: s });
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
