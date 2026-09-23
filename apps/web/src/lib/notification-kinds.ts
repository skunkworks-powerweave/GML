// The notification catalogue, and the ONE filter that reads it.
//
// Spec 168 wired the bell badge to `system_settings.notificationsEnabled`; the
// filter lived in chrome-counts.ts until it turned out /inbox never applied it.
// Both now read this module.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// The topbar bell and /inbox disagreed about what "unread" means.
//
//   the bell     filtered unread rows by `system_settings.notifications_enabled`
//   the inbox    applied no filter at all
//
// So the bell could read 0 while the page it links to showed unread items, or
// the reverse. Two surfaces, one question, two answers -- and nothing in the
// code connected them, so neither was obviously wrong when read on its own.
//
// The category list had the same shape of problem: it was written out THREE
// times (the settings page's labelled array, the API route's zod enum, and
// implicitly in whatever the bell filtered on), with two comments asking the
// next person to "keep in sync". That is how `helpdesk.ticket` -- the only kind
// the application actually writes -- came to be missing from the catalogue for
// its entire life, which made the bell permanently zero.
//
// One catalogue, one filter, imported by every consumer. Neither can drift now
// because there is only one of each.

import "server-only";
import { inArray, sql, type SQL } from "drizzle-orm";
import { notifications } from "@gml/db/schema";
import { getSystemSettings } from "./system-settings";

/**
 * Every notification kind an administrator can switch on or off.
 *
 * `key` is the literal written to `notifications.kind`; label and hint are the
 * settings-page UI. Adding a kind here is all that is needed -- the settings
 * form, the API's zod enum, the bell and the inbox all read this array.
 */
export const NOTIFICATION_CATEGORIES = [
  {
    key: "helpdesk.ticket",
    label: "Help request",
    hint: "Programme admin notified when a user submits the help form",
  },
  {
    key: "cycle.assigned",
    label: "Cycle assigned",
    hint: "Observer/mentor notified when a new cycle is created",
  },
  {
    key: "cycle.complete",
    label: "Cycle complete",
    hint: "All parties notified when a cycle closes",
  },
  {
    key: "video.transcoded",
    label: "Video transcoded",
    hint: "Uploader notified when ffmpeg pipeline finishes",
  },
  {
    key: "video.review_pending",
    label: "Video review pending",
    hint: "Programme admin alerted on quality flags",
  },
  {
    key: "meeting.scheduled",
    label: "Meeting scheduled",
    hint: "Mentor + teacher receive calendar entry",
  },
  {
    key: "meeting.cancelled",
    label: "Meeting cancelled",
    hint: "Both parties notified of cancellations",
  },
  {
    key: "digest.weekly",
    label: "Weekly digest",
    hint: "Friday roll-up across all activities",
  },
] as const satisfies ReadonlyArray<{ key: string; label: string; hint: string }>;

export type NotificationKind = (typeof NOTIFICATION_CATEGORIES)[number]["key"];

/** The keys alone, in a shape `z.enum()` accepts. */
export const NOTIFICATION_KEYS = NOTIFICATION_CATEGORIES.map((c) => c.key) as unknown as [
  NotificationKind,
  ...NotificationKind[],
];

/**
 * The kinds currently switched on, or `null` when we cannot know.
 *
 * `null` and `[]` mean genuinely different things and callers must not conflate
 * them: `null` is "the settings row is missing or the DB is unreachable", which
 * must NOT hide notifications -- a database blip should never silently empty
 * someone's inbox. `[]` is an administrator who has switched every category
 * off, which must show nothing.
 */
export async function loadEnabledNotificationKinds(): Promise<string[] | null> {
  const settings = await getSystemSettings();
  const kinds = settings?.notificationsEnabled;
  return Array.isArray(kinds) ? kinds.map(String) : null;
}

/**
 * The `where` fragment for the enabled kinds, to AND into any notifications
 * query. `undefined` means "add nothing" -- see the null/[] distinction above.
 */
export function enabledKindsCondition(enabled: string[] | null): SQL | undefined {
  if (enabled === null) return undefined;
  if (enabled.length === 0) return sql`false`;
  return inArray(notifications.kind, enabled);
}

/**
 * The two together, for the common case.
 *
 * Both the bell and the inbox call exactly this, which is the point: the count
 * in the topbar and the rows on the page are now derived from one predicate.
 */
export async function notificationKindFilter(): Promise<SQL | undefined> {
  return enabledKindsCondition(await loadEnabledNotificationKinds());
}
