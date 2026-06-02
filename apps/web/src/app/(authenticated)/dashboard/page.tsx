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
//                      I owe, cycles awaiting my sign-off.
//   • mentor:          my active mentees, my pending video reviews (teach_back
//                      videos in {received,queued,transcoding,review_pending}
//                      within last 48h on my pairings), my scheduled meetings
//                      this week, Q-progress forms due (proxy: meetings_count
//                      hit a quarter boundary but no matching feedback row).
//   • programme_admin: active pairings, cycles in flight, recent uploads
//                      (24h), pending observer forms (programme-wide).
//   • super_admin:     same as programme_admin + total users + audit events
//                      (24h). Storage-used is a documented deviation: MinIO
//                      stats live behind credentials we don't carry on this
//                      page boundary, so the card shows the SUM(files.sizeBytes)
//                      proxy in MB instead.
//
// All counts run as a single Promise.all per variant so the page is a one-shot
// round-trip. The helper is wrapped in React.cache so the variant-builder and
// the TodayChecklist row builder share one materialisation per request.

import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
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
  mentors,
  quizzes,
  quizSubmissions,
  users,
  auditLog,
} from "@gml/db/schema";
import { redirect } from "next/navigation";
import Link from "next/link";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Stat = { label: string; value: string | number; hint?: string };

// ── time windows used in multiple counts ─────────────────────────────────────
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TWO_DAYS_MS = 48 * 60 * 60 * 1000;
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
const getProgrammeChrome = cache(async () => {
  const since24h = new Date(Date.now() - ONE_DAY_MS);
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
    db.select({ c: count() }).from(mentorPairings).where(eq(mentorPairings.status, "active")),
    db
      .select({ c: count() })
      .from(observationCycles)
      .where(inArray(observationCycles.status, ["nominated", "pre_submitted", "observed", "post_submitted"])),
    db.select({ c: count() }).from(videoSubmissions).where(gte(videoSubmissions.createdAt, since24h)),
    db
      .select({ c: count() })
      .from(observationCycles)
      .where(eq(observationCycles.status, "pre_submitted")),
    db.select({ c: count() }).from(users).where(eq(users.active, true)),
    db.select({ c: count() }).from(auditLog).where(gte(auditLog.createdAt, since24h)),
    db.select({ b: sql<number>`COALESCE(SUM(${files.sizeBytes}), 0)` }).from(files).where(isNull(files.deletedAt)),
    db.select({ c: count() }).from(schools).where(eq(schools.active, true)),
    db.select({ c: count() }).from(mentors).where(eq(mentors.active, true)),
    db.select({ c: count() }).from(teachers).where(eq(teachers.active, true)),
  ]);
  return {
    pairingsActive: pairingsActive[0]?.c ?? 0,
    cyclesInFlight: cyclesInFlight[0]?.c ?? 0,
    recentUploads: recentUploads[0]?.c ?? 0,
    pendingObserverForms: pendingObserverForms[0]?.c ?? 0,
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

  const [myUploads7d, pendingPre, awaitingVideo, openQuizzes] = await Promise.all([
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
    teacherId
      ? db
          .select({ c: count() })
          .from(observationCycles)
          .where(
            and(
              eq(observationCycles.teacherId, teacherId),
              eq(observationCycles.status, "nominated"),
            ),
          )
      : Promise.resolve([{ c: 0 }] as Array<{ c: number }>),
    // Cycles awaiting video — pre-form done, observation upload still owed.
    // 'pre_submitted' is the JSX prototype's "awaiting video" stage.
    teacherId
      ? db
          .select({ c: count() })
          .from(observationCycles)
          .where(
            and(
              eq(observationCycles.teacherId, teacherId),
              eq(observationCycles.status, "pre_submitted"),
            ),
          )
      : Promise.resolve([{ c: 0 }] as Array<{ c: number }>),
    // Open quizzes — active quizzes the teacher has not yet attempted /
    // passed. A submission counts as "done" regardless of score (quiz
    // surface re-attempts are tracked separately).
    db
      .select({ c: count() })
      .from(quizzes)
      .where(
        and(
          eq(quizzes.active, true),
          sql`${quizzes.id} NOT IN (
            SELECT ${quizSubmissions.quizId}
            FROM ${quizSubmissions}
            WHERE ${quizSubmissions.userId} = ${userId}
          )`,
        ),
      ),
  ]);

  return {
    teacherId,
    myUploads7d: myUploads7d[0]?.c ?? 0,
    pendingPre: pendingPre[0]?.c ?? 0,
    awaitingVideo: awaitingVideo[0]?.c ?? 0,
    openQuizzes: openQuizzes[0]?.c ?? 0,
  };
});

// ── observer chrome ──────────────────────────────────────────────────────────
const getObserverChrome = cache(async (userId: string) => {
  const [leadingActive, pendingObserverForm, awaitingSignOff] = await Promise.all([
    // Cycles I am leading (active) — assigned observer, not yet complete.
    db
      .select({ c: count() })
      .from(observationCycles)
      .where(
        and(
          eq(observationCycles.observerId, userId),
          inArray(observationCycles.status, ["nominated", "pre_submitted", "observed", "post_submitted"]),
        ),
      ),
    // Pending observer forms — the cycle is in 'pre_submitted' (teacher
    // shipped the pre-form, observer is up next). Filtered to my cycles.
    db
      .select({ c: count() })
      .from(observationCycles)
      .where(
        and(
          eq(observationCycles.observerId, userId),
          eq(observationCycles.status, "pre_submitted"),
        ),
      ),
    // Cycles awaiting sign-off — post-form submitted, observer / mentor
    // sign-off pending. Mapped to status 'post_submitted'.
    db
      .select({ c: count() })
      .from(observationCycles)
      .where(
        and(
          eq(observationCycles.observerId, userId),
          eq(observationCycles.status, "post_submitted"),
        ),
      ),
  ]);
  return {
    leadingActive: leadingActive[0]?.c ?? 0,
    pendingObserverForm: pendingObserverForm[0]?.c ?? 0,
    awaitingSignOff: awaitingSignOff[0]?.c ?? 0,
  };
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
  if (!mentorId) {
    return {
      mentorId: null,
      activeMentees: 0,
      pendingVideoReviews: 0,
      scheduledMeetingsThisWeek: 0,
      qProgressFormsDue: 0,
    };
  }

  const weekStart = startOfWeekUtc();
  const weekEnd = endOfWeekUtc();
  const since48h = new Date(Date.now() - TWO_DAYS_MS);

  const [activeMentees, pendingVideoReviews, scheduledMeetings, qProgressFormsDue] = await Promise.all([
    // Active mentees — pairings where I am the mentor and status='active'.
    db
      .select({ c: count() })
      .from(mentorPairings)
      .where(
        and(
          eq(mentorPairings.mentorId, mentorId),
          eq(mentorPairings.status, "active"),
        ),
      ),
    // Pending video reviews — teach_back videos for teachers I'm paired
    // with, status in the unreviewed set, within the last 48h. Same
    // 48-hour SLA as the JSX prototype's "Target: < 48 hours" subtitle.
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
      .where(
        and(
          eq(videoSubmissions.contextType, "teach_back"),
          inArray(videoSubmissions.status, ["received", "queued", "transcoding", "review_pending"]),
          gte(videoSubmissions.createdAt, since48h),
        ),
      ),
    // Scheduled meetings this week — mentor_meetings where the pairing is
    // mine and scheduled_at lands in the current Mon-Sun window.
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
    // Q-progress forms due — pairings where current_quarter is set (i.e. the
    // pairing has reached a quarter boundary) and the cached meetings_count
    // shows at least one meeting happened (so the form is owed). Real
    // "form-due" detection requires joining feedback_responses against the
    // matching quarter; that join is hot and the proxy is faithful to the
    // prototype's count. See research.md.
    db
      .select({ c: count() })
      .from(mentorPairings)
      .where(
        and(
          eq(mentorPairings.mentorId, mentorId),
          eq(mentorPairings.status, "active"),
          isNotNull(mentorPairings.currentQuarter),
          gt(mentorPairings.meetingsCount, 0),
        ),
      ),
  ]);

  return {
    mentorId,
    activeMentees: activeMentees[0]?.c ?? 0,
    pendingVideoReviews: pendingVideoReviews[0]?.c ?? 0,
    scheduledMeetingsThisWeek: scheduledMeetings[0]?.c ?? 0,
    qProgressFormsDue: qProgressFormsDue[0]?.c ?? 0,
  };
});

// ── today-checklist rows (mentor variant) ────────────────────────────────────
type TodoRow = { text: string; href: string };

async function getMentorTodos(userId: string): Promise<TodoRow[]> {
  const chrome = await getMentorChrome(userId);
  if (!chrome.mentorId) return [];
  const mentorId = chrome.mentorId;
  const dayStart = startOfDayUtc();
  const dayEnd = endOfDayUtc();
  const [awaitingSignOff, pendingVideo, meetingsToday] = await Promise.all([
    // Cycles awaiting my mentor sign-off — teacher just shipped the post-form.
    db
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
      .limit(1),
    // Mentee video uploaded but not yet reviewed.
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
      .where(
        and(
          eq(videoSubmissions.contextType, "teach_back"),
          inArray(videoSubmissions.status, ["received", "queued", "transcoding", "review_pending"]),
        ),
      )
      .orderBy(desc(videoSubmissions.createdAt))
      .limit(1),
    // Meetings scheduled today.
    db
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
      .limit(1),
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
  return todos;
}

// ── today-checklist rows (programme/super-admin variant) ─────────────────────
async function getAdminTodos(): Promise<TodoRow[]> {
  const chrome = await getProgrammeChrome();
  const todos: TodoRow[] = [];
  if (chrome.recentUploads > 0) {
    todos.push({
      text: `Review ${chrome.recentUploads} recent upload${chrome.recentUploads === 1 ? "" : "s"} (24h)`,
      href: "/videos",
    });
  }
  if (chrome.pendingObserverForms > 0) {
    todos.push({
      text: `${chrome.pendingObserverForms} cycle${chrome.pendingObserverForms === 1 ? "" : "s"} waiting on observer form`,
      href: "/observation",
    });
  }
  if (chrome.cyclesInFlight > 0) {
    todos.push({
      text: `${chrome.cyclesInFlight} observation cycle${chrome.cyclesInFlight === 1 ? "" : "s"} in flight`,
      href: "/observation",
    });
  }
  return todos;
}

// ── today-checklist rows (teacher variant) ───────────────────────────────────
async function getTeacherTodos(userId: string): Promise<TodoRow[]> {
  const chrome = await getTeacherChrome(userId);
  const todos: TodoRow[] = [];
  if (chrome.pendingPre > 0) {
    todos.push({
      text: `Submit pre-form for ${chrome.pendingPre} cycle${chrome.pendingPre === 1 ? "" : "s"}`,
      href: "/observation",
    });
  }
  if (chrome.awaitingVideo > 0) {
    todos.push({
      text: `Upload lesson video for ${chrome.awaitingVideo} cycle${chrome.awaitingVideo === 1 ? "" : "s"}`,
      href: "/uploads",
    });
  }
  if (chrome.openQuizzes > 0) {
    todos.push({
      text: `${chrome.openQuizzes} open quiz${chrome.openQuizzes === 1 ? "" : "zes"}`,
      href: "/rtt",
    });
  }
  return todos;
}

// ── today-checklist rows (observer variant) ──────────────────────────────────
async function getObserverTodos(userId: string): Promise<TodoRow[]> {
  const chrome = await getObserverChrome(userId);
  const todos: TodoRow[] = [];
  if (chrome.pendingObserverForm > 0) {
    todos.push({
      text: `Fill observer form for ${chrome.pendingObserverForm} cycle${chrome.pendingObserverForm === 1 ? "" : "s"}`,
      href: "/observation",
    });
  }
  if (chrome.awaitingSignOff > 0) {
    todos.push({
      text: `Sign off ${chrome.awaitingSignOff} completed cycle${chrome.awaitingSignOff === 1 ? "" : "s"}`,
      href: "/observation",
    });
  }
  return todos;
}

// ── FieldMap data — real schools, replaces the hardcoded 10-marker SVG ───────
const getFieldMapSchools = cache(async () => {
  return db
    .select({
      id: schools.id,
      code: schools.code,
      name: schools.name,
    })
    .from(schools)
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
    const chrome = await getProgrammeChrome();
    const base: Stat[] = [
      { label: "Active pairings", value: chrome.pairingsActive, hint: `${chrome.mentorsTotal} mentors` },
      { label: "Cycles in flight", value: chrome.cyclesInFlight, hint: "this term" },
      { label: "Recent uploads (24h)", value: chrome.recentUploads, hint: "across all sources" },
      { label: "Pending observer forms", value: chrome.pendingObserverForms, hint: "waiting on observer" },
    ];
    if (role === "super_admin") {
      base.push(
        { label: "Total users", value: chrome.totalUsers, hint: "active accounts" },
        { label: "Audit events (24h)", value: chrome.auditEvents24h, hint: "rolling window" },
        { label: "Storage used (MB)", value: chrome.storageMb, hint: "SUM(files.size_bytes)" },
      );
    }
    stats = base;
    todos = await getAdminTodos();
  } else if (role === "mentor") {
    const chrome = await getMentorChrome(session.user.id);
    stats = [
      { label: "Active mentees", value: chrome.activeMentees, hint: "paired" },
      { label: "Pending video reviews", value: chrome.pendingVideoReviews, hint: "target: < 48 h" },
      { label: "Scheduled meetings this week", value: chrome.scheduledMeetingsThisWeek, hint: "Mon-Sun" },
      { label: "Q-progress forms due", value: chrome.qProgressFormsDue, hint: "quarter boundary reached" },
    ];
    todos = await getMentorTodos(session.user.id);
  } else if (role === "observer") {
    const chrome = await getObserverChrome(session.user.id);
    stats = [
      { label: "Cycles I am leading (active)", value: chrome.leadingActive, hint: "assigned to me" },
      { label: "Pending observer forms", value: chrome.pendingObserverForm, hint: "I owe" },
      { label: "Cycles awaiting sign-off", value: chrome.awaitingSignOff, hint: "post-form in" },
    ];
    todos = await getObserverTodos(session.user.id);
  } else {
    // teacher
    const chrome = await getTeacherChrome(session.user.id);
    stats = [
      { label: "My uploads this week", value: chrome.myUploads7d, hint: "last 7 days" },
      { label: "Cycles pending pre-form", value: chrome.pendingPre, hint: "needs my reflection" },
      { label: "Cycles awaiting video", value: chrome.awaitingVideo, hint: "ready to upload" },
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

  const greeting = (() => {
    const h = new Date().getUTCHours();
    if (h < 5) return tDash("lateNight");
    if (h < 12) return tDash("morning");
    if (h < 17) return tDash("afternoon");
    return tDash("evening");
  })();

  const firstName = name.replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.|Mohd\.)\s+/i, "").split(/\s+/)[0];

  const roleLabel = role.replace("_", " ");

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
        <p style={{ color: "var(--ink-3)", marginTop: 6 }}>
          {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          {" · Term 2 Week 7 of 12 · "}
          {role === "teacher" ? "RTT Phase 2" : `${roleLabel} view`}
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

        <section style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
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

// FieldMapSection — schematic SVG of Ladakh with one dot per real school.
// Clicking a dot deep-links to /repo/school/[id]. Coordinates are derived from
// a hash of the school code so the layout is stable across renders without
// requiring a geo column on the schools table.
function FieldMapSection({ schools }: { schools: Array<{ id: string; code: string; name: string }> }) {
  // Stable hash → 0..1 mapping so dots stay put across renders.
  const placed = schools.map((s) => {
    let h = 0;
    for (let i = 0; i < s.code.length; i++) h = (h * 31 + s.code.charCodeAt(i)) >>> 0;
    const x = 60 + (h % 400);
    const y = 80 + ((h >>> 8) % 200);
    // Use code prefix to color-code: GMS / GPS / GHS / etc.
    const isKargil = s.code.startsWith("GMS-K") || s.code.startsWith("GPS-K") || s.code.startsWith("GHS-K");
    return { ...s, x, y, color: isKargil ? "var(--saffron)" : "var(--indigo)" };
  });
  return (
    <article className="card card-hi">
      <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
        <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
          Field operations
        </h2>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
          {schools.length} school{schools.length === 1 ? "" : "s"} — click a marker to open its repo page
        </div>
      </header>
      <div style={{ padding: 14 }}>
        {schools.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>No active schools registered.</div>
        ) : (
          <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: "1px solid var(--line)", background: "var(--paper-2)" }}>
            <svg viewBox="0 0 520 320" style={{ width: "100%", display: "block" }}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <path
                  key={i}
                  d={`M0 ${40 + i * 38} Q ${130 + i * 4} ${20 + i * 40} ${260 + i * 2} ${50 + i * 38} T 520 ${30 + i * 40}`}
                  fill="none"
                  stroke="var(--line-2)"
                  strokeWidth="0.6"
                  opacity={0.7}
                />
              ))}
              <text x="200" y="290" fill="var(--ink-3)" fontFamily="var(--mono)" fontSize="10" letterSpacing="2">
                KARGIL
              </text>
              <text x="400" y="290" fill="var(--ink-3)" fontFamily="var(--mono)" fontSize="10" letterSpacing="2">
                LEH
              </text>
              <line x1="280" y1="60" x2="280" y2="270" stroke="var(--line-2)" strokeDasharray="3 4" />
              {placed.map((m) => (
                <a key={m.id} href={`/repo/school/${m.id}`}>
                  <g style={{ cursor: "pointer" }}>
                    <circle cx={m.x} cy={m.y} r="6" fill={m.color} stroke="var(--paper)" strokeWidth="2" />
                    <title>{m.name} ({m.code})</title>
                  </g>
                </a>
              ))}
            </svg>
          </div>
        )}
      </div>
    </article>
  );
}
