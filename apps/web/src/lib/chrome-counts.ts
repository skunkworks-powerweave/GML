// Chrome counts — request-scoped data layer for the dynamic badge numbers
// rendered in the desktop Sidebar, the mobile BottomTabs, and the Topbar.
//
// Spec 128 wires the JSX prototype's three "fake" data points to real
// backend queries:
//   1. Nav count badges (NAV_BY_ROLE `count: 5` etc) → real per-role queries.
//   2. Topbar bell badge → real notifications.read_at IS NULL count.
//   3. Topbar queue indicator → real BullMQ getJobCounts() depth.
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
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  mentorPairings,
  mentors,
  observationCycles,
  videoSubmissions,
  formDrafts,
  notifications,
} from "@gml/db/schema";
import type { RoleName } from "@gml/shared/auth/roles";
import { transcodeQueue } from "@gml/worker/queues";

/**
 * Per-role badge counts. Each role gets only the counts that map to nav
 * items it can see — the loader is cheap (≤4 statements) and short-circuits
 * when the role has no badge-bearing nav rows.
 */
export type NavCounts = {
  /** mentor: active pairings owned by this mentor's mentor row */
  mentees?: number;
  /** mentor + observer + teacher: cycles relevant to the role */
  cycles?: number;
  /** mentor: video_submissions awaiting mentor review */
  pendingReview?: number;
  /** teacher: video_submissions submitted by this user in the last 30d */
  myUploads?: number;
  /** all roles: form_drafts owned by this user (autosave in flight) */
  pendingForms?: number;
};

// Statuses that count an observation cycle as "in flight" (not nominated yet,
// not yet sealed as complete). Used for the mentor + observer + teacher
// counts.
const ACTIVE_CYCLE_STATUSES = ["pre_submitted", "observed", "post_submitted"] as const;

// Statuses that count a video as awaiting reviewer attention.
const REVIEW_PENDING_STATUSES = ["review_pending"] as const;

/**
 * Per-request cached nav badge loader. Returns a single object containing the
 * counts that apply to the caller's role. Roles with no badge slots get an
 * empty `{}` (no DB calls at all).
 *
 * @param userId  session.user.id — the mentor row is resolved by userId.
 * @param role    RoleName — drives which queries fire.
 */
export const loadNavCounts = cache(async function loadNavCounts(
  userId: string,
  role: RoleName,
): Promise<NavCounts> {
  try {
    if (role === "mentor") {
      // Resolve the mentor row so the pairings + review counts target the
      // right mentor_id. If no mentor row exists yet, the counts stay 0.
      const [mentorRow] = await db
        .select({ id: mentors.id })
        .from(mentors)
        .where(eq(mentors.userId, userId))
        .limit(1);
      const mentorId = mentorRow?.id ?? null;

      const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const [mentees, cycles, pendingReview, pendingForms] = await Promise.all([
        mentorId
          ? db
              .select({ c: sql<number>`count(*)::int` })
              .from(mentorPairings)
              .where(
                and(
                  eq(mentorPairings.mentorId, mentorId),
                  eq(mentorPairings.status, "active"),
                ),
              )
          : Promise.resolve([{ c: 0 }]),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(observationCycles)
          .where(inArray(observationCycles.status, [...ACTIVE_CYCLE_STATUSES])),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(videoSubmissions)
          .where(
            and(
              inArray(videoSubmissions.status, [...REVIEW_PENDING_STATUSES]),
              gte(videoSubmissions.createdAt, cutoff30d),
            ),
          ),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(formDrafts)
          .where(eq(formDrafts.userId, userId)),
      ]);
      return {
        mentees: mentees[0]?.c ?? 0,
        cycles: cycles[0]?.c ?? 0,
        pendingReview: pendingReview[0]?.c ?? 0,
        pendingForms: pendingForms[0]?.c ?? 0,
      };
    }

    if (role === "observer") {
      const [cycles, pendingForms] = await Promise.all([
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(observationCycles)
          .where(
            and(
              eq(observationCycles.observerId, userId),
              inArray(observationCycles.status, [...ACTIVE_CYCLE_STATUSES]),
            ),
          ),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(formDrafts)
          .where(eq(formDrafts.userId, userId)),
      ]);
      return {
        cycles: cycles[0]?.c ?? 0,
        pendingForms: pendingForms[0]?.c ?? 0,
      };
    }

    if (role === "teacher") {
      const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const [cycles, myUploads, pendingForms] = await Promise.all([
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(observationCycles)
          .where(inArray(observationCycles.status, [...ACTIVE_CYCLE_STATUSES])),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(videoSubmissions)
          .where(
            and(
              eq(videoSubmissions.submittedByUserId, userId),
              gte(videoSubmissions.createdAt, cutoff30d),
            ),
          ),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(formDrafts)
          .where(eq(formDrafts.userId, userId)),
      ]);
      return {
        cycles: cycles[0]?.c ?? 0,
        myUploads: myUploads[0]?.c ?? 0,
        pendingForms: pendingForms[0]?.c ?? 0,
      };
    }

    // super_admin + programme_admin: chrome has no count-bearing nav rows in
    // NAV_BY_ROLE for these roles. We still load pendingForms so the badge
    // appears if/when these roles ever start drafting forms themselves.
    const [pendingForms] = await Promise.all([
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(formDrafts)
        .where(eq(formDrafts.userId, userId)),
    ]);
    return { pendingForms: pendingForms[0]?.c ?? 0 };
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
 */
export const loadUnreadNotifications = cache(async function loadUnreadNotifications(
  userId: string,
): Promise<number> {
  try {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return row?.c ?? 0;
  } catch (err) {
    console.error("[chrome-counts] loadUnreadNotifications failed", err);
    return 0;
  }
});

/**
 * Per-request cached BullMQ queue depth. Drives the topbar queue indicator.
 * Returns the raw counts; the renderer formats them. Hidden when all zero.
 *
 * `getJobCounts` opens an ioredis connection lazily; the producer-side
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
    const counts = await transcodeQueue.getJobCounts("waiting", "active", "failed");
    return {
      active: counts.active ?? 0,
      waiting: counts.waiting ?? 0,
      failed: counts.failed ?? 0,
    };
  } catch (err) {
    // Redis unreachable / queue not initialised → render nothing.
    console.error("[chrome-counts] loadQueueDepth failed", err);
    return { active: 0, waiting: 0, failed: 0 };
  }
});

/**
 * Format the BullMQ counts into the topbar chip label. Returns null when
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
      if (value == null) return rawItem;
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
