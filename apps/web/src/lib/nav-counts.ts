// The nav badge counts, as a function of an explicit database handle.
//
// lib/chrome-counts.ts is `server-only` and binds the module-level db, so
// nothing outside a Next render could execute what it counted -- which is how
// the observation badge shipped counting the whole programme for teachers and
// mentors. Its loadNavCounts() is now this function, cached per request and
// bound to the app's db; tests/behaviour/nav-counts.test.ts runs this one.
// No "server-only", for the same reason as lib/visibility.ts.

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { formDrafts, mentorPairings, mentors, observationCycles, videoSubmissions } from "@gml/db/schema";
import type { RoleName } from "@gml/shared/auth/roles";
import { activeGrant, observationAccess, type Db } from "./visibility";
import { pendingTeachBackReviewWhere } from "./video/pending-review";

/**
 * Per-role badge counts. Each role gets only the counts that map to nav
 * items it can see — the loader is cheap (≤4 statements) and short-circuits
 * when the role has no badge-bearing nav rows.
 */
export type NavCounts = {
  /**
   * mentor: active pairings owned by this mentor's mentor row. Undefined -- no
   * badge -- while the mentorship section is locked for him.
   */
  mentees?: number;
  /**
   * mentor + observer + teacher: open cycles THIS user can see. Undefined --
   * no badge -- while the observation section is locked for them.
   */
  cycles?: number;
  /** mentor + observer: teach-backs owed a review (the /rtt/teach-back queue) */
  pendingReview?: number;
  /** teacher: video_submissions submitted by this user in the last 30d */
  myUploads?: number;
  /** all roles: form_drafts owned by this user (autosave in flight) */
  pendingForms?: number;
};

// A cycle is OPEN until it is signed off. 'nominated' is included: it is the
// state in which a teacher owes her pre-form, and the badge used to leave it
// out. Same set as the dashboards' "in flight" / "leading (active)" counts.
const OPEN_CYCLE_STATUSES = ["nominated", "pre_submitted", "observed", "post_submitted"] as const;

/**
 * Open observation cycles the user may see, or undefined while the section is
 * locked for them.
 *
 * SCOPED, AND BEHIND THE GATE. The mentor and teacher badges counted
 * `status IN (...)` over the whole table: every teacher's "My observations"
 * and every mentor's "Observation cycles" showed the programme-wide total --
 * wrong for them, and programme activity disclosed outside the gate, which is
 * exactly what /observation's chips scope with cycleVisibility to avoid. This
 * uses the same decision the section uses: observationAccess (the grant, then
 * the visibility predicate). No grant, no query, no number.
 */
async function openCycles(db: Db, userId: string, role: RoleName): Promise<number | undefined> {
  const access = await observationAccess(db, { id: userId, role });
  if (!access.granted) return undefined;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(observationCycles)
    .where(and(access.where, inArray(observationCycles.status, [...OPEN_CYCLE_STATUSES])));
  return row?.c ?? 0;
}

/**
 * The mentor's active pairings, or undefined while the mentorship section is
 * locked for him. Pairings are mentorship rows: the same rule as openCycles(),
 * for the other gated section.
 */
async function menteeCount(db: Db, userId: string, mentorId: string | null): Promise<number | undefined> {
  if (!(await activeGrant(db, userId, "mentorship"))) return undefined;
  if (!mentorId) return 0;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(mentorPairings)
    .where(and(eq(mentorPairings.mentorId, mentorId), eq(mentorPairings.status, "active")));
  return row?.c ?? 0;
}

/**
 * Teach-backs owed a review, programme-wide: the one definition shared with
 * the dashboard card and /rtt/teach-back (lib/video/pending-review.ts), with
 * no time window. A 30-day window here dropped the clip that had waited
 * longest from the badge while the queue still listed it.
 */
async function pendingTeachBackCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(videoSubmissions)
    .where(pendingTeachBackReviewWhere());
  return row?.c ?? 0;
}

async function draftCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(formDrafts)
    .where(eq(formDrafts.userId, userId));
  return row?.c ?? 0;
}

export async function navCounts(db: Db, userId: string, role: RoleName): Promise<NavCounts> {
  if (role === "mentor") {
    // Resolve the mentor row so the pairings count targets the right
    // mentor_id. If no mentor row exists yet, the count stays 0.
    const [mentorRow] = await db
      .select({ id: mentors.id })
      .from(mentors)
      .where(eq(mentors.userId, userId))
      .limit(1);
    const mentorId = mentorRow?.id ?? null;

    const [mentees, cycles, pendingReview, pendingForms] = await Promise.all([
      menteeCount(db, userId, mentorId),
      openCycles(db, userId, role),
      pendingTeachBackCount(db),
      draftCount(db, userId),
    ]);
    return {
      mentees,
      cycles,
      pendingReview,
      pendingForms,
    };
  }

  if (role === "observer") {
    const [cycles, pendingReview, pendingForms] = await Promise.all([
      openCycles(db, userId, role),
      pendingTeachBackCount(db),
      draftCount(db, userId),
    ]);
    return { cycles, pendingReview, pendingForms };
  }

  if (role === "teacher") {
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [cycles, myUploads, pendingForms] = await Promise.all([
      openCycles(db, userId, role),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(videoSubmissions)
        .where(and(eq(videoSubmissions.submittedByUserId, userId), gte(videoSubmissions.createdAt, cutoff30d))),
      draftCount(db, userId),
    ]);
    return { cycles, myUploads: myUploads[0]?.c ?? 0, pendingForms };
  }

  // super_admin + programme_admin: chrome has no count-bearing nav rows in
  // NAV_BY_ROLE for these roles. We still load pendingForms so the badge
  // appears if/when these roles ever start drafting forms themselves.
  return { pendingForms: await draftCount(db, userId) };
}
