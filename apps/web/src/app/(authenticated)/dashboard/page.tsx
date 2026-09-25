// Role-aware dashboard — 1:1 ports `LMS GML Frontend/dashboard.jsx`.
//
// Spec 125 — the time-of-day greeting and the two right-column card headings
// (What's next / Today, Confidentiality) are now translated via next-intl.
// The rest of the page body stays English per the prototype's intentional
// "chrome translates, content doesn't" line.
//
// Spec 127 — every stat-card value is a real DB count, scoped by role.
//   • teacher:         my uploads (7d), my cycles pending pre-form, my
//                      cycles awaiting video, open quizzes.
//   • observer:        cycles I am leading (active), pending observer forms
//                      I owe, my cycles awaiting the mentor's sign-off.
//   • mentor:          my active mentees, my pending video reviews (teach_back
//                      videos that are ready and unreviewed, on my pairings --
//                      lib/video/pending-review.ts), my scheduled meetings
//                      this week, Q-progress forms due (a meeting has been
//                      held since the pairing's last mentor form).
//   • programme_admin: active pairings, cycles in flight, recent uploads
//                      (24h), pending observer forms (programme-wide).
//   • super_admin:     same as programme_admin + total users + audit events
//                      (24h). Storage-used is a documented deviation: MinIO
//                      stats live behind credentials we don't carry on this
//                      page boundary, so the card shows the SUM(files.sizeBytes)
//                      proxy in MB instead.
//
// SECTION GATES. Counts and to-dos drawn from observation cycles or mentorship
// pairings are the gated sections' rows, re-served outside them, so they follow
// lib/visibility.ts's rule exactly as the nav badges do: without the viewer's
// grant the query does not run, the card reads "— · <Section> locked", and the
// to-do list offers the unlock instead of claiming "Nothing pending". It used
// to show them, cycle codes included, to anyone signed in.
//
// All counts run as a single Promise.all per variant so the page is a one-shot
// round-trip. The helper is wrapped in React.cache so the variant-builder and
// the TodayChecklist row builder share one materialisation per request.

import type { Metadata } from "next";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@gml/db";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import {
  mentorPairings,
  mentorMeetings,
  observationCycles,
  videoSubmissions,
  files,
  teachers,
  schools,
  zones,
  districts,
  mentors,
  feedbackForms,
  feedbackResponses,
  users,
  auditLog,
  phases,
} from "@gml/db/schema";
import { redirect } from "next/navigation";
import Link from "next/link";
import { recordAudit } from "@/lib/audit";
import { getActiveGrant } from "@/lib/gates";
import { countOpenAssessments } from "@/lib/rtt/assessments";
import { pendingTeachBackReviewWhere } from "@/lib/video/pending-review";
import { greetingKey, PROGRAMME_TIME_ZONE } from "./greeting";
import { FieldMapSection } from "./FieldMap";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Dashboard" };

type Stat = { label: string; value: string | number; hint?: string };

// ── section gates ────────────────────────────────────────────────────────────
type GatedSection = "observation" | "mentorship";
const SECTION_NAME: Record<GatedSection, string> = { observation: "Observation", mentorship: "Mentorship" };

/** Whether the viewer holds a live grant for the section (one lookup per request). */
const sectionOpen = cache(async (userId: string, section: GatedSection): Promise<boolean> =>
  (await getActiveGrant(userId, section)) !== null,
);

/** A count from a gated section: null while that section is locked. */
type Gated = number | null;

/** Run `q` only when the section is open; a locked section runs no query. */
async function gatedCount(open: boolean, q: () => PromiseLike<Array<{ c: number }>>): Promise<Gated> {
  if (!open) return null;
  return (await q())[0]?.c ?? 0;
}

function gatedStat(label: string, value: Gated, hint: string, section: GatedSection): Stat {
  return value === null ? { label, value: "—", hint: `${SECTION_NAME[section]} locked` } : { label, value, hint };
}

// ── time windows used in multiple counts ─────────────────────────────────────
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// (No 48-hour constant: the mentor review card used one as a FILTER, which hid
// every overdue review. "< 48 h" is the card's hint, not its predicate.)
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

// startOfWeek(monday-anchored) — keeps the "Scheduled meetings this week"
// count aligned with the prototype's "Mon 20 — Sun 26 May" caption.
function startOfWeekUtc(d = new Date()): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  const dow = out.getUTCDay(); // 0 = Sun, 1 = Mon, ...
  const shift = dow === 0 ? -6 : 1 - dow;
  out.setUTCDate(out.getUTCDate() + shift);
  return out;
}

function endOfWeekUtc(d = new Date()): Date {
  const start = startOfWeekUtc(d);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return end;
}

function startOfDayUtc(d = new Date()): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function endOfDayUtc(d = new Date()): Date {
  const start = startOfDayUtc(d);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

// ── shared / programme-wide chrome ───────────────────────────────────────────
// Programme + super admins read the same broad set. Cached to coalesce queries
// fired from both the stat row and the today-checklist row builders.
const getProgrammeChrome = cache(async (userId: string) => {
  const since24h = new Date(Date.now() - ONE_DAY_MS);
  const [obsOpen, mentorshipOpen] = await Promise.all([
    sectionOpen(userId, "observation"),
    sectionOpen(userId, "mentorship"),
  ]);
  const [
    pairingsActive,
    cyclesInFlight,
    recentUploads,
    pendingObserverForms,
    totalUsers,
    auditEvents24h,
    storageBytes,
    schoolsTotal,
    mentorsTotal,
    teachersTotal,
  ] = await Promise.all([
    gatedCount(mentorshipOpen, () =>
      db.select({ c: count() }).from(mentorPairings).where(eq(mentorPairings.status, "active")),
    ),
    gatedCount(obsOpen, () =>
      db
        .select({ c: count() })
        .from(observationCycles)
        .where(inArray(observationCycles.status, ["nominated", "pre_submitted", "observed", "post_submitted"])),
    ),
    db.select({ c: count() }).from(videoSubmissions).where(gte(videoSubmissions.createdAt, since24h)),
    gatedCount(obsOpen, () =>
      db
        .select({ c: count() })
        .from(observationCycles)
        .where(eq(observationCycles.status, "pre_submitted")),
    ),
    db.select({ c: count() }).from(users).where(eq(users.active, true)),
    db.select({ c: count() }).from(auditLog).where(gte(auditLog.createdAt, since24h)),
    db.select({ b: sql<number>`COALESCE(SUM(${files.sizeBytes}), 0)` }).from(files).where(isNull(files.deletedAt)),
    db.select({ c: count() }).from(schools).where(eq(schools.active, true)),
    db.select({ c: count() }).from(mentors).where(eq(mentors.active, true)),
    db.select({ c: count() }).from(teachers).where(eq(teachers.active, true)),
  ]);
  return {
    pairingsActive,
    cyclesInFlight,
    recentUploads: recentUploads[0]?.c ?? 0,
    pendingObserverForms,
    totalUsers: totalUsers[0]?.c ?? 0,
    auditEvents24h: auditEvents24h[0]?.c ?? 0,
    storageMb: Math.round(Number(storageBytes[0]?.b ?? 0) / (1024 * 1024)),
    schoolsTotal: schoolsTotal[0]?.c ?? 0,
    mentorsTotal: mentorsTotal[0]?.c ?? 0,
    teachersTotal: teachersTotal[0]?.c ?? 0,
  };
});

// ── teacher chrome ───────────────────────────────────────────────────────────
const getTeacherChrome = cache(async (userId: string) => {
  // Resolve the teacher row that owns this user (may be null for users not yet
  // linked to a teacher record — programme-admin still seeded as teacher etc).
  const [teacherRow] = await db
    .select({ id: teachers.id })
    .from(teachers)
    .where(eq(teachers.userId, userId))
    .limit(1);
  const teacherId = teacherRow?.id ?? null;
  const since7d = new Date(Date.now() - SEVEN_DAYS_MS);
  const obsOpen = await sectionOpen(userId, "observation");
  // Her cycles at one stage, or null while observation is locked for her.
  const myCyclesAt = (status: "nominated" | "pre_submitted" | "observed") =>
    gatedCount(obsOpen, () =>
      teacherId
        ? db
            .select({ c: count() })
            .from(observationCycles)
            .where(and(eq(observationCycles.teacherId, teacherId), eq(observationCycles.status, status)))
        : Promise.resolve([{ c: 0 }]),
    );

  const [myUploads7d, pendingPre, awaitingVideo, awaitingPost, openQuizzes] = await Promise.all([
    // My uploads this week — every video_submission this user submitted in
    // the trailing 7 days, regardless of context (covers WhatsApp + direct +
    // teach_back). Matches the "My uploads" panel on the teacher dashboard.
    db
      .select({ c: count() })
      .from(videoSubmissions)
      .where(
        and(
          eq(videoSubmissions.submittedByUserId, userId),
          gte(videoSubmissions.createdAt, since7d),
        ),
      ),
    // Cycles pending pre-form — my cycles where I owe the pre-form. status
    // 'nominated' is the upstream gate before the pre-form submit (see
    // /observation/[cycleId]/actions.ts::submitPreFormAction).
    myCyclesAt("nominated"),
    // Cycles awaiting video — pre-form done, observation upload still owed.
    // 'pre_submitted' is the JSX prototype's "awaiting video" stage.
    myCyclesAt("pre_submitted"),
    // Cycles awaiting her post-form — observed, reflection owed. This stage
    // had no to-do at all, so a teacher whose cycle reached 'observed' was
    // prompted for nothing and the cycle stalled before sign-off.
    myCyclesAt("observed"),
    // Open quizzes — the RTT quizzes the teacher has not yet submitted, as
    // /rtt lists them (the to-do below links there). It counted every active
    // quiz, including ones no learner page offers, so the to-do promised
    // quizzes /rtt could not show.
    countOpenAssessments(db, { id: userId, role: "teacher" }),
  ]);

  return {
    teacherId,
    myUploads7d: myUploads7d[0]?.c ?? 0,
    pendingPre,
    awaitingVideo,
    awaitingPost,
    openQuizzes,
  };
});

// ── observer chrome ──────────────────────────────────────────────────────────
const getObserverChrome = cache(async (userId: string) => {
  // Every card here is observation cycles: all null while the section is locked.
  const obsOpen = await sectionOpen(userId, "observation");
  const [leadingActive, pendingObserverForm, awaitingSignOff] = await Promise.all([
    // Cycles I am leading (active) — assigned observer, not yet complete.
    gatedCount(obsOpen, () =>
      db
        .select({ c: count() })
        .from(observationCycles)
        .where(
          and(
            eq(observationCycles.observerId, userId),
            inArray(observationCycles.status, ["nominated", "pre_submitted", "observed", "post_submitted"]),
          ),
        ),
    ),
    // Pending observer forms — the cycle is in 'pre_submitted' (teacher
    // shipped the pre-form, observer is up next). Filtered to my cycles.
    gatedCount(obsOpen, () =>
      db
        .select({ c: count() })
        .from(observationCycles)
        .where(
          and(
            eq(observationCycles.observerId, userId),
            eq(observationCycles.status, "pre_submitted"),
          ),
        ),
    ),
    // Cycles awaiting sign-off — post-form submitted, the MENTOR's sign-off
    // pending (observers cannot sign off). Mapped to status 'post_submitted'.
    gatedCount(obsOpen, () =>
      db
        .select({ c: count() })
        .from(observationCycles)
        .where(
          and(
            eq(observationCycles.observerId, userId),
            eq(observationCycles.status, "post_submitted"),
          ),
        ),
    ),
  ]);
  return { leadingActive, pendingObserverForm, awaitingSignOff };
});

// ── mentor chrome ────────────────────────────────────────────────────────────
const getMentorChrome = cache(async (userId: string) => {
  // Resolve the mentor row that owns this user. A user with role=mentor but
  // no matching mentors.user_id row sees zeros (rare; bootstrap edge case).
  const [mentorRow] = await db
    .select({ id: mentors.id })
    .from(mentors)
    .where(eq(mentors.userId, userId))
    .limit(1);
  const mentorId = mentorRow?.id ?? null;
  // Pairings, their meetings and their forms are mentorship rows: null while
  // that section is locked. Teach-back reviews are RTT's and are not gated.
  const mentorshipOpen = await sectionOpen(userId, "mentorship");
  if (!mentorId) {
    const none: Gated = mentorshipOpen ? 0 : null;
    return {
      mentorId: null,
      activeMentees: none,
      pendingVideoReviews: 0,
      scheduledMeetingsThisWeek: none,
      qProgressFormsDue: none,
    };
  }

  const weekStart = startOfWeekUtc();
  const weekEnd = endOfWeekUtc();

  const [activeMentees, pendingVideoReviews, scheduledMeetings, qProgressFormsDue] = await Promise.all([
    // Active mentees — pairings where I am the mentor and status='active'.
    gatedCount(mentorshipOpen, () =>
      db
        .select({ c: count() })
        .from(mentorPairings)
        .where(
          and(
            eq(mentorPairings.mentorId, mentorId),
            eq(mentorPairings.status, "active"),
          ),
        ),
    ),
    // Pending video reviews — teach_back clips on MY active pairings that are
    // playable and nobody has reviewed: the shared predicate in
    // lib/video/pending-review.ts, which the sidebar badge uses too.
    //
    // This was `status IN (received, queued, transcoding, review_pending) AND
    // created_at >= now() - 48h`. `review_pending` is written by nothing, so it
    // counted only clips a mentor cannot watch yet, and each clip left the count
    // the moment it became reviewable; the card read 0 while the badge and
    // /rtt/teach-back showed the backlog. The 48h window is gone rather than
    // corrected: it made an overdue review vanish from the card whose hint is
    // "target: < 48 h". The hint is a target, not a filter.
    //
    // The pairing joins stay: this card is for one mentor, the badge is
    // programme-wide. Test: tests/behaviour/pending-review.test.ts.
    db
      .select({ c: count() })
      .from(videoSubmissions)
      .innerJoin(teachers, eq(teachers.userId, videoSubmissions.submittedByUserId))
      .innerJoin(
        mentorPairings,
        and(
          eq(mentorPairings.teacherId, teachers.id),
          eq(mentorPairings.mentorId, mentorId),
          eq(mentorPairings.status, "active"),
        ),
      )
      .where(pendingTeachBackReviewWhere()),
    // Scheduled meetings this week — mentor_meetings where the pairing is
    // mine and scheduled_at lands in the current Mon-Sun window.
    gatedCount(mentorshipOpen, () =>
      db
        .select({ c: count() })
        .from(mentorMeetings)
        .innerJoin(mentorPairings, eq(mentorMeetings.pairingId, mentorPairings.id))
        .where(
          and(
            eq(mentorPairings.mentorId, mentorId),
            gte(mentorMeetings.scheduledAt, weekStart),
            lt(mentorMeetings.scheduledAt, weekEnd),
          ),
        ),
    ),
    // Q-progress forms due — my active pairings where a meeting has been HELD
    // (scheduled_at <= now) since the pairing's latest mentor form, or at all
    // when none has been filed yet, and whose final form is not in.
    //
    // NOT "the current quarter's form is missing". Quarters carry no dates;
    // submitting a form is what closes one: submitFormAction moves
    // current_quarter on in the same transaction that stores the response
    // (QUARTER_AFTER), so the current quarter's form is always the unfiled
    // one, and counting on it made submitting a form push the number UP. What
    // makes the next form owed is mentoring since the last one. current_quarter
    // is not read, so a pairing the admin grid created (NULL, i.e. Q1) counts
    // like any other. A meeting booked for later has not been held. 'final'
    // opens no quarter (completePairingAction closes the pairing).
    //
    // Before that the count was a proxy that never read feedback_responses,
    // and sat at 4 beside "Nothing pending — your queue is clear".
    gatedCount(mentorshipOpen, () =>
      db
        .select({ c: count() })
        .from(mentorPairings)
        .where(
          and(
            eq(mentorPairings.mentorId, mentorId),
            eq(mentorPairings.status, "active"),
            sql`EXISTS (
              SELECT 1 FROM ${mentorMeetings} m
              WHERE m.pairing_id = ${mentorPairings.id}
                AND m.scheduled_at <= now()
                AND m.scheduled_at > COALESCE((
                  SELECT max(r.submitted_at) FROM ${feedbackResponses} r
                  JOIN ${feedbackForms} f ON f.id = r.form_id
                  WHERE r.pairing_id = ${mentorPairings.id} AND f.audience = 'mentor'
                ), '-infinity'::timestamptz)
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${feedbackResponses} r
              JOIN ${feedbackForms} f ON f.id = r.form_id
              WHERE r.pairing_id = ${mentorPairings.id} AND f.audience = 'mentor' AND f.kind = 'final'
            )`,
          ),
        ),
    ),
  ]);

  return {
    mentorId,
    activeMentees,
    pendingVideoReviews: pendingVideoReviews[0]?.c ?? 0,
    scheduledMeetingsThisWeek: scheduledMeetings,
    qProgressFormsDue,
  };
});

// ── today-checklist rows (mentor variant) ────────────────────────────────────
type TodoRow = { text: string; href: string };

/**
 * What a locked section puts on the list in place of its to-dos: something may
 * be waiting there, and this is how to look -- without a count, a code or any
 * other row escaping the gate. The gate sends the user back to the dashboard.
 */
function unlockRow(section: GatedSection): TodoRow {
  return {
    text: `Unlock ${SECTION_NAME[section]} to see what is waiting on you`,
    href: `/gate/${section}?next=${encodeURIComponent("/dashboard")}`,
  };
}

async function getMentorTodos(userId: string): Promise<TodoRow[]> {
  const chrome = await getMentorChrome(userId);
  if (!chrome.mentorId) return [];
  const mentorId = chrome.mentorId;
  const dayStart = startOfDayUtc();
  const dayEnd = endOfDayUtc();
  const [obsOpen, mentorshipOpen] = await Promise.all([
    sectionOpen(userId, "observation"),
    sectionOpen(userId, "mentorship"),
  ]);
  const [awaitingSignOff, pendingVideo, meetingsToday] = await Promise.all([
    // Cycles awaiting my mentor sign-off — teacher just shipped the post-form.
    // A cycle code is an observation row: not read while that gate is locked.
    obsOpen
      ? db
          .select({ id: observationCycles.id, code: observationCycles.code })
          .from(observationCycles)
          .innerJoin(teachers, eq(teachers.id, observationCycles.teacherId))
          .innerJoin(
            mentorPairings,
            and(
              eq(mentorPairings.teacherId, teachers.id),
              eq(mentorPairings.mentorId, mentorId),
              eq(mentorPairings.status, "active"),
            ),
          )
          .where(eq(observationCycles.status, "post_submitted"))
          .orderBy(desc(observationCycles.updatedAt))
          .limit(1)
      : Promise.resolve([] as Array<{ id: string; code: string }>),
    // Mentee video ready and not yet reviewed. Same shared predicate as the
    // stat card; the old never-written `review_pending` set meant this to-do
    // row could not fire for a clip the mentor could actually watch.
    db
      .select({ id: videoSubmissions.id })
      .from(videoSubmissions)
      .innerJoin(teachers, eq(teachers.userId, videoSubmissions.submittedByUserId))
      .innerJoin(
        mentorPairings,
        and(
          eq(mentorPairings.teacherId, teachers.id),
          eq(mentorPairings.mentorId, mentorId),
          eq(mentorPairings.status, "active"),
        ),
      )
      .where(pendingTeachBackReviewWhere())
      .orderBy(desc(videoSubmissions.createdAt))
      .limit(1),
    // Meetings scheduled today.
    mentorshipOpen
      ? db
          .select({ id: mentorMeetings.id })
          .from(mentorMeetings)
          .innerJoin(mentorPairings, eq(mentorMeetings.pairingId, mentorPairings.id))
          .where(
            and(
              eq(mentorPairings.mentorId, mentorId),
              gte(mentorMeetings.scheduledAt, dayStart),
              lt(mentorMeetings.scheduledAt, dayEnd),
            ),
          )
          .orderBy(mentorMeetings.scheduledAt)
          .limit(1)
      : Promise.resolve([] as Array<{ id: string }>),
  ]);

  const todos: TodoRow[] = [];
  if (awaitingSignOff.length > 0) {
    todos.push({
      text: `Sign off cycle ${awaitingSignOff[0].code}`,
      href: `/observation/${awaitingSignOff[0].id}`,
    });
  }
  if (pendingVideo.length > 0) {
    todos.push({
      text: `Review pending teach-back video`,
      href: `/rtt/teach-back`,
    });
  }
  if (meetingsToday.length > 0) {
    todos.push({
      text: `Mentor meeting scheduled today`,
      href: `/mentorship`,
    });
  }
  // A form that is due is something waiting on the mentor; the stat card alone
  // left "Nothing pending" beside a non-zero "forms due".
  const formsDue = chrome.qProgressFormsDue ?? 0;
  if (formsDue > 0) {
    todos.push({
      text: `Submit ${formsDue} quarterly form${formsDue === 1 ? "" : "s"} for your mentees`,
      href: `/mentorship`,
    });
  }
  if (!obsOpen) todos.push(unlockRow("observation"));
  if (!mentorshipOpen) todos.push(unlockRow("mentorship"));
  return todos;
}

// ── today-checklist rows (programme/super-admin variant) ─────────────────────
async function getAdminTodos(userId: string): Promise<TodoRow[]> {
  const chrome = await getProgrammeChrome(userId);
  const todos: TodoRow[] = [];
  if (chrome.recentUploads > 0) {
    todos.push({
      text: `Review ${chrome.recentUploads} recent upload${chrome.recentUploads === 1 ? "" : "s"} (24h)`,
      href: "/videos",
    });
  }
  if (chrome.pendingObserverForms !== null && chrome.pendingObserverForms > 0) {
    todos.push({
      text: `${chrome.pendingObserverForms} cycle${chrome.pendingObserverForms === 1 ? "" : "s"} waiting on observer form`,
      href: "/observation",
    });
  }
  if (chrome.cyclesInFlight !== null && chrome.cyclesInFlight > 0) {
    todos.push({
      text: `${chrome.cyclesInFlight} observation cycle${chrome.cyclesInFlight === 1 ? "" : "s"} in flight`,
      href: "/observation",
    });
  }
  if (chrome.cyclesInFlight === null) todos.push(unlockRow("observation"));
  return todos;
}

// ── today-checklist rows (teacher variant) ───────────────────────────────────
async function getTeacherTodos(userId: string): Promise<TodoRow[]> {
  const chrome = await getTeacherChrome(userId);
  const todos: TodoRow[] = [];
  if (chrome.pendingPre !== null && chrome.pendingPre > 0) {
    todos.push({
      text: `Submit pre-form for ${chrome.pendingPre} cycle${chrome.pendingPre === 1 ? "" : "s"}`,
      href: "/observation",
    });
  }
  if (chrome.awaitingVideo !== null && chrome.awaitingVideo > 0) {
    todos.push({
      text: `Upload lesson video for ${chrome.awaitingVideo} cycle${chrome.awaitingVideo === 1 ? "" : "s"}`,
      href: "/uploads",
    });
  }
  if (chrome.awaitingPost !== null && chrome.awaitingPost > 0) {
    todos.push({
      text: `Submit post-form for ${chrome.awaitingPost} cycle${chrome.awaitingPost === 1 ? "" : "s"}`,
      href: "/observation",
    });
  }
  if (chrome.openQuizzes > 0) {
    todos.push({
      text: `${chrome.openQuizzes} open quiz${chrome.openQuizzes === 1 ? "" : "zes"}`,
      href: "/rtt",
    });
  }
  if (chrome.pendingPre === null) todos.push(unlockRow("observation"));
  return todos;
}

// ── today-checklist rows (observer variant) ──────────────────────────────────
async function getObserverTodos(userId: string): Promise<TodoRow[]> {
  const chrome = await getObserverChrome(userId);
  const todos: TodoRow[] = [];
  if (chrome.pendingObserverForm === null) return [unlockRow("observation")];
  if (chrome.pendingObserverForm > 0) {
    todos.push({
      text: `Fill observer form for ${chrome.pendingObserverForm} cycle${chrome.pendingObserverForm === 1 ? "" : "s"}`,
      href: "/observation",
    });
  }
  // NO SIGN-OFF ROW. This list used to offer "Sign off N completed cycles" for
  // the observer's post_submitted cycles. Sign-off is mentor/admin only
  // (signOffCycleAction's requireRole; the cycle page shows an observer no such
  // control), and a post_submitted cycle is not complete -- so the observer
  // followed the link to find nothing to press, on a to-do they could never
  // clear. The count stays on the stat card, as information.
  return todos;
}

// ── FieldMap data — real schools, replaces the hardcoded 10-marker SVG ───────
const getFieldMapSchools = cache(async () => {
  return db
    .select({
      id: schools.id,
      code: schools.code,
      name: schools.name,
      // The school's real district, via its zone: the map colours and places
      // by it (./FieldMap.tsx), no longer by a guess from the school code.
      districtCode: districts.code,
    })
    .from(schools)
    .innerJoin(zones, eq(schools.zoneId, zones.id))
    .innerJoin(districts, eq(zones.districtId, districts.id))
    .where(eq(schools.active, true))
    .orderBy(schools.code)
    .limit(120);
});

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const role = session.user.role ?? "teacher";
  const name = session.user.name ?? session.user.email ?? "there";
  const tDash = await getTranslations("dashboard");

  // Build the role-specific stat row + the today-checklist rows.
  let stats: Stat[] = [];
  let todos: TodoRow[] = [];

  if (role === "super_admin" || role === "programme_admin") {
    const chrome = await getProgrammeChrome(session.user.id);
    const base: Stat[] = [
      gatedStat("Active pairings", chrome.pairingsActive, `${chrome.mentorsTotal} mentors`, "mentorship"),
      gatedStat("Cycles in flight", chrome.cyclesInFlight, "this term", "observation"),
      { label: "Recent uploads (24h)", value: chrome.recentUploads, hint: "across all sources" },
      gatedStat("Pending observer forms", chrome.pendingObserverForms, "waiting on observer", "observation"),
    ];
    if (role === "super_admin") {
      base.push(
        { label: "Total users", value: chrome.totalUsers, hint: "active accounts" },
        { label: "Audit events (24h)", value: chrome.auditEvents24h, hint: "rolling window" },
        { label: "Storage used (MB)", value: chrome.storageMb, hint: "SUM(files.size_bytes)" },
      );
    }
    stats = base;
    todos = await getAdminTodos(session.user.id);
  } else if (role === "mentor") {
    const chrome = await getMentorChrome(session.user.id);
    stats = [
      gatedStat("Active mentees", chrome.activeMentees, "paired", "mentorship"),
      { label: "Pending video reviews", value: chrome.pendingVideoReviews, hint: "target: < 48 h" },
      gatedStat("Scheduled meetings this week", chrome.scheduledMeetingsThisWeek, "Mon-Sun", "mentorship"),
      gatedStat("Q-progress forms due", chrome.qProgressFormsDue, "met since the last form", "mentorship"),
    ];
    todos = await getMentorTodos(session.user.id);
  } else if (role === "observer") {
    const chrome = await getObserverChrome(session.user.id);
    stats = [
      gatedStat("Cycles I am leading (active)", chrome.leadingActive, "assigned to me", "observation"),
      gatedStat("Pending observer forms", chrome.pendingObserverForm, "I owe", "observation"),
      gatedStat("Cycles awaiting sign-off", chrome.awaitingSignOff, "post-form in · mentor signs off", "observation"),
    ];
    todos = await getObserverTodos(session.user.id);
  } else {
    // teacher
    const chrome = await getTeacherChrome(session.user.id);
    stats = [
      { label: "My uploads this week", value: chrome.myUploads7d, hint: "last 7 days" },
      gatedStat("Cycles pending pre-form", chrome.pendingPre, "needs my reflection", "observation"),
      gatedStat("Cycles awaiting video", chrome.awaitingVideo, "ready to upload", "observation"),
      { label: "Open quizzes", value: chrome.openQuizzes, hint: "active · not yet taken" },
    ];
    todos = await getTeacherTodos(session.user.id);
  }

  // Best-effort dashboard view audit (does not block render on failure).
  void recordAudit({
    action: "dashboard.viewed",
    entityType: "dashboard",
    entityId: role,
    metadata: { role },
  });

  // In IST, not UTC: see ./greeting.ts.
  const greeting = tDash(greetingKey(new Date()));

  const firstName = name.replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.|Mohd\.)\s+/i, "").split(/\s+/)[0];

  const roleLabel = role.replace("_", " ");

  // The phase that contains today, by date. Falls back to null -- and the
  // subtitle then simply omits the phase -- rather than guessing, because a
  // programme with no dated phase has no current phase to report.
  const [currentPhase] = await db
    .select({ label: phases.label })
    .from(phases)
    .where(
      and(
        isNotNull(phases.startDate),
        lte(phases.startDate, new Date()),
        or(isNull(phases.endDate), gte(phases.endDate, new Date())),
      ),
    )
    .orderBy(desc(phases.sequence))
    .limit(1);

  // FieldMap is only meaningful for programme + super admins.
  const showFieldMap = role === "super_admin" || role === "programme_admin";
  const fieldMapSchools = showFieldMap ? await getFieldMapSchools() : [];

  return (
    <div>
      <div className="page-header">
        <div className="label">{roleLabel} dashboard</div>
        <h1 className="serif" style={{ fontSize: 30, marginTop: 4 }}>
          {greeting}, {firstName}.
        </h1>
        {/* The phase comes from the phases table, by date.
            This line used to read "Term 2 Week 7 of 12 · RTT Phase 2" for every
            user on every date, hardcoded -- so the dashboard confidently
            reported a programme position that was fixed at whatever was true on
            the day it was typed, and would still say Week 7 in the middle of
            Phase 3 two years later.

            The phase IS derivable: phases carries start_date and end_date.
            "Term 2 Week 7 of 12" is NOT -- the terms table has a name and a
            sequence and no dates at all, so there is nothing to compute a week
            number from. Rather than swap one invented number for another, that
            half is dropped. */}
        <p style={{ color: "var(--ink-3)", marginTop: 6 }}>
          {new Date().toLocaleDateString("en-IN", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
            // The programme's date, not the server process's (same clock as the greeting).
            timeZone: PROGRAMME_TIME_ZONE,
          })}
          {currentPhase ? ` · RTT ${currentPhase.label}` : ""}
          {role === "teacher" ? "" : ` · ${roleLabel} view`}
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 18 }}>
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 14,
          }}
        >
          {stats.map((s) => (
            <article key={s.label} className="card card-hi" style={{ padding: 14 }}>
              <div className="label">{s.label}</div>
              <div className="serif" style={{ fontSize: 32, marginTop: 6 }}>
                {s.value}
              </div>
              {s.hint ? (
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{s.hint}</div>
              ) : null}
            </article>
          ))}
        </section>

        {/* Stacked below 768 px: an inline "1.4fr 1fr" held on a phone too. */}
        <section className="grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <article className="card card-hi">
            <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
              <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
                {role === "teacher" ? tDash("whatsNext") : tDash("today")}
              </h2>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                {role === "teacher" ? "Your training queue + observation prep." : "Things waiting on you."}
              </div>
            </header>
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              {todos.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  Nothing pending — your queue is clear.
                </div>
              ) : (
                todos.map((t) => <TodoRow key={t.href + t.text} text={t.text} href={t.href} />)
              )}
            </div>
          </article>

          <article className="card card-hi">
            <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
              <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
                {tDash("confidentiality")}
              </h2>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                {tDash("reminderForViewer")}
              </div>
            </header>
            <div style={{ padding: 14 }}>
              <p style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
                All resources here are confidential. Videos are watermarked with your name and timestamp; downloads are
                disabled. Section passwords rotate periodically — ask your programme admin if a section appears locked.
              </p>
              <Link
                href="/inbox"
                style={{ fontSize: 12, color: "var(--indigo)", display: "inline-block", marginTop: 10 }}
              >
                Notifications →
              </Link>
            </div>
          </article>
        </section>

        {showFieldMap ? <FieldMapSection schools={fieldMapSchools} /> : null}
      </div>
    </div>
  );
}

function TodoRow({ text, href }: { text: string; href: string }) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 10px",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-2)",
        background: "var(--paper)",
        fontSize: 13,
        color: "var(--ink-2)",
        textDecoration: "none",
      }}
    >
      <span>{text}</span>
      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>→</span>
    </Link>
  );
}
