// Chrome counts — request-scoped data layer for the dynamic badge numbers
// rendered in the desktop Sidebar, the mobile BottomTabs, and the Topbar.
//
// Spec 128 wires the JSX prototype's three "fake" data points to real
// backend queries:
//   1. Nav count badges (NAV_BY_ROLE `count: 5` etc) → real per-role queries.
//   2. Topbar bell badge → real notifications.read_at IS NULL count.
//   3. Topbar queue indicator → real the job queue getJobCounts() depth.
//
// Each loader is wrapped in `React.cache(...)` so a single layout render that
// passes the counts into both the Sidebar and the BottomTabs (mobile) or any
// child server component re-rendering during the same RSC pass shares a single
// database round-trip per loader. The cache key is the userId (or role) so
// distinct sessions never collide.
//
// All loaders fail closed: any thrown error returns the zero shape so the
// chrome stays readable even when the DB / Redis is down. The error is logged
// via console.error so the platform team can see it.

import "server-only";
import { cache } from "react";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { notifications } from "@gml/db/schema";
import type { RoleName } from "@gml/shared/auth/roles";
import { transcodeQueueDepth } from "@/lib/queue";
import { notificationKindFilter } from "./notification-kinds";
import { navCounts, type NavCounts as NavCountsShape } from "./nav-counts";

export type NavCounts = NavCountsShape;

// "Awaiting reviewer attention" is now derived, not a status value.
//
// This used to be `["review_pending"]`, a status NOTHING in the codebase ever
// wrote -- the worker writes ready/failed, the WhatsApp webhook writes received
// -- so this badge counted rows that could not exist and was permanently zero
// while the teach-back queue filled up. A clip needs review when it is a
// playable teach-back that nobody has reviewed yet. See migration 0022.

/**
 * Per-request cached nav badge loader. Returns a single object containing the
 * counts that apply to the caller's role.
 *
 * The queries are lib/nav-counts.ts, which takes the database as a parameter
 * so tests/behaviour can execute them; this binds them to the app's db. The
 * observation badge there is scoped to what the caller may see and is
 * withheld while their section gate is locked -- it used to count the whole
 * programme for every teacher and mentor.
 *
 * @param userId  session.user.id — the mentor row is resolved by userId.
 * @param role    RoleName — drives which queries fire.
 */
export const loadNavCounts = cache(async function loadNavCounts(
  userId: string,
  role: RoleName,
): Promise<NavCounts> {
  try {
    return await navCounts(db, userId, role);
  } catch (err) {
    // Fail-closed: keep the chrome readable when the DB is unavailable.
    console.error("[chrome-counts] loadNavCounts failed", err);
    return {};
  }
});

/**
 * Per-request cached unread notifications count. Drives the topbar bell
 * badge. Capped at 100 by the renderer (which renders "99+" past that)
 * but we return the raw number so callers can decide their own ceiling.
 *
 * Spec 168 — the count is filtered by the enabled notification kinds. That filter used to
 * be written out here, and the comment claimed it made "the badge match the
 * inbox content" -- which it did not, because /inbox applied no filter at all.
 * The two surfaces could and did answer the same question differently. Both
 * now call `notificationKindFilter()`; see lib/notification-kinds.ts.
 *
 * A missing settings row or an unreachable DB yields `undefined` and so counts
 * every unread row, rather than going dark on a database blip.
 */
export const loadUnreadNotifications = cache(async function loadUnreadNotifications(
  userId: string,
): Promise<number> {
  try {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          await notificationKindFilter(),
        ),
      );
    return row?.c ?? 0;
  } catch (err) {
    console.error("[chrome-counts] loadUnreadNotifications failed", err);
    return 0;
  }
});

/**
 * Per-request cached transcode queue depth. Drives the topbar queue indicator.
 * Returns the raw counts; the renderer formats them. Hidden when all zero.
 *
 * `getJobCounts` opens an the queue client connection lazily; the producer-side
 * connection in apps/worker/src/queues.ts is `lazyConnect: true` so this is
 * safe to call from a server component on every request.
 */
export type QueueDepth = {
  active: number;
  waiting: number;
  failed: number;
};

export const loadQueueDepth = cache(async function loadQueueDepth(): Promise<QueueDepth> {
  try {
    const counts = await transcodeQueueDepth();
    return { active: counts.running, waiting: counts.queued, failed: counts.dead };
  } catch (err) {
    // Render nothing rather than a wrong number. The chip is decoration; the
    // admin DLQ view is where an operator goes for the real state, and it
    // distinguishes "unavailable" from zero.
    console.error("[chrome-counts] loadQueueDepth failed", err);
    return { active: 0, waiting: 0, failed: 0 };
  }
});

/**
 * Format the the job queue counts into the topbar chip label. Returns null when
 * every count is zero — the renderer hides the chip in that case.
 */
export function formatQueueLabel(counts: QueueDepth): string | null {
  const { active, waiting, failed } = counts;
  if (active === 0 && waiting === 0 && failed === 0) return null;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} processing`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/**
 * Format the unread bell badge value. Returns "99+" when over 99, the raw
 * number as a string otherwise, or null when the count is zero (renderer
 * hides the chip).
 */
export function formatBellBadge(count: number): string | null {
  if (count <= 0) return null;
  if (count > 99) return "99+";
  return String(count);
}

/**
 * Merge live counts from `loadNavCounts` into the static `NAV_BY_ROLE`
 * configuration. The id → count key mapping below is the contract the chrome
 * relies on; adding a new badge means adding a row here AND in nav.ts.
 */
export function applyNavCounts<TSection extends { section: string; items: readonly unknown[] }>(
  sections: ReadonlyArray<TSection>,
  counts: NavCounts,
): TSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.map((rawItem) => {
      const item = rawItem as { id: string; count?: number };
      const next = NAV_BADGE_MAP[item.id];
      if (!next) return rawItem;
      const value = next(counts);
      // NO FALLBACK TO A STATIC COUNT.
      //
      // loadNavCounts() returns {} on a database error, so every resolver then
      // returned undefined and this line handed back `rawItem` -- carrying the
      // hardcoded literals that used to sit in nav.ts. During an outage a
      // mentor's sidebar confidently reported "5 mentees / 6 observation
      // cycles / 3 pending review": numbers that were never real, presented
      // identically to ones that were.
      //
      // A badge is a count of something. If we do not know the count, there is
      // no honest badge to render, so the item renders without one.
      if (value == null) {
        const { count: _dropped, ...withoutCount } = item;
        return withoutCount;
      }
      return { ...item, count: value };
    }),
  })) as TSection[];
}

/**
 * id → resolver. Each nav item that wants a real badge declares its lookup
 * here. Items not in the map render their static count from nav.ts (or no
 * badge at all).
 */
const NAV_BADGE_MAP: Record<string, (c: NavCounts) => number | undefined> = {
  mentorship: (c) => c.mentees,
  observation: (c) => c.cycles,
  videos: (c) => c.pendingReview,
  uploads: (c) => c.myUploads,
  forms: (c) => c.pendingForms,
};
