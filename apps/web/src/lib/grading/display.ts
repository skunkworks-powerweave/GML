// Display helpers for the marks pages: a record's approval state as a chip
// class, and an assessment date in the viewer's language. No words here --
// the labels are grading.status.* in the bundles.

import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";

/** The chip class for an approval state. */
export function statusChip(state: string): string {
  switch (state) {
    case "approved":
      return "chip chip-lichen";
    case "pending":
      return "chip chip-saffron";
    case "changes_requested":
    case "rejected":
      return "chip chip-rust";
    default:
      return "chip";
  }
}

export const APPROVAL_STATES = ["draft", "pending", "approved", "changes_requested", "rejected"] as const;

/** The status key for a stored state, "draft" for anything unknown. */
export function statusKey(state: string): (typeof APPROVAL_STATES)[number] {
  return (APPROVAL_STATES as readonly string[]).includes(state) ? (state as (typeof APPROVAL_STATES)[number]) : "draft";
}

/** "2026-09-28" as "28 Sept 2026" (or its Hindi / Bhoti form). A date-only value has no time zone. */
export function formatDay(day: string | null, locale: string): string | null {
  if (!day) return null;
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(INTL_LOCALE[normalizeLocale(locale)], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
