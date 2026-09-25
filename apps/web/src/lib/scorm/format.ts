// How a SCORM record reads on a page: status words, chip colours, durations,
// sizes. Shared by the learner's subject page and the staff pages so the two
// never describe the same record differently.

import { FINISHED_STATUSES } from "./cmi";

const LABELS: Record<string, string> = {
  passed: "Passed",
  completed: "Completed",
  failed: "Failed",
  incomplete: "In progress",
  browsed: "Browsed",
  "not attempted": "Not started",
};

export const statusLabel = (status: string): string => LABELS[status] ?? status;

export const statusChip = (status: string): string =>
  status === "passed" || status === "completed" ? "chip chip-lichen" : status === "failed" ? "chip chip-rust" : "chip";

/** What the launch button says: a finished module is reopened to review it. */
export const launchLabel = (status: string): string =>
  FINISHED_STATUSES.has(status) ? "Review" : status === "not attempted" ? "Start" : "Resume";

/** Centiseconds as "1 h 05 min", "12 min" or "40 s". */
export function formatDuration(cs: number): string {
  const s = Math.floor(cs / 100);
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min`;
  return `${s} s`;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
