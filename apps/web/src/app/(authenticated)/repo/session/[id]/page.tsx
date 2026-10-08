// /repo/session/[id] — single classroom session detail.
// Port of repository.jsx::RepoSessionPage (lines 751-824) — 1:1 visual fidelity.
// Two-column layout: lesson notes + linked observation cycle (left), KV details (right).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { uuidOrNotFound } from "@/lib/ids";
import { actorFrom, sessionVideoAccess } from "@/lib/authz";
import { linkedCycle } from "@/lib/gated-reads";
import { observationAccess } from "@/lib/visibility";
import { mayOpenSession, repoScope } from "@/lib/teaching/visibility";
import { enumLabel } from "@/components/repo/repo-i18n";
import { SessionVideosCard } from "@/components/video/SessionVideosCard";
import { videosOfSessions } from "@/lib/video/session-videos";
import { db } from "@gml/db";
import {
  sessions,
  schools,
  classes,
  subjects,
  teachers,
  outlineLessons,
  courseOutlines,
} from "@gml/db/schema";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("session.metaTitle") };
}

const ALLOWED_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

// The label is repo.sessionStatus.<status>, in the viewer's language.
const STATUS_CHIP: Record<string, { kind: string }> = {
  planned: { kind: "" },
  in_progress: { kind: "chip-saffron" },
  complete: { kind: "chip-lichen" },
  cancelled: { kind: "" },
};

function fmtAttendance(attended: number, total: number): string {
  if (!total) return "—";
  return `${attended} / ${total}`;
}

export default async function RepoSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const authSession = await auth();
  const role = authSession?.user?.role;
  if (!role || !ALLOWED_ROLES.has(role)) redirect("/forbidden");
  const actor = actorFrom(authSession);
  if (!actor) redirect("/login");

  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);

  const [s] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!s) notFound();
  // A teacher opens her own sessions only; a colleague's answers 404
  // (lib/teaching/visibility.ts). Other roles are unchanged.
  if (!mayOpenSession(await repoScope(db, actor), s)) notFound();

  const [school] = await db.select().from(schools).where(eq(schools.id, s.schoolId)).limit(1);
  const [cls] = await db.select().from(classes).where(eq(classes.id, s.classId)).limit(1);
  const [subject] = await db.select().from(subjects).where(eq(subjects.id, s.subjectId)).limit(1);
  const [teacher] = await db.select().from(teachers).where(eq(teachers.id, s.teacherId)).limit(1);

  let lesson: (typeof outlineLessons.$inferSelect) | undefined;
  let outline: (typeof courseOutlines.$inferSelect) | undefined;
  if (s.outlineLessonId) {
    const [ll] = await db
      .select()
      .from(outlineLessons)
      .where(eq(outlineLessons.id, s.outlineLessonId))
      .limit(1);
    lesson = ll;
    if (ll) {
      const [ol] = await db
        .select()
        .from(courseOutlines)
        .where(eq(courseOutlines.id, ll.outlineId))
        .limit(1);
      outline = ol;
    }
  }

  // The linked cycle's code and UUID are observation-section data, and this page
  // is outside that section. It used to select the cycle by id alone, so any
  // signed-in user could read the code of any cycle a session was observed
  // under and follow its link. Now it is named only when the viewer has
  // unlocked the observation section AND may see that cycle; otherwise the
  // session just reads "Observed". See lib/gated-reads.ts.
  const cycle = s.observationCycleId
    ? await linkedCycle(db, await observationAccess(db, actor), s.observationCycleId)
    : null;

  // The session's own teacher and administrators may see and add its videos.
  const videoViewer = await sessionVideoAccess(actor, id);
  const videos = videoViewer ? await videosOfSessions([id]) : [];

  const t = await getTranslations("repo");
  const statusChip = STATUS_CHIP[s.status] ?? STATUS_CHIP.planned;
  const statusLabel = enumLabel(t, "sessionStatus", STATUS_CHIP[s.status] ? s.status : "planned");
  const mono = (chunks: React.ReactNode) => <span className="mono">{chunks}</span>;
  const bold = (chunks: React.ReactNode) => <b>{chunks}</b>;
  const when = `${s.scheduledDate}${s.scheduledTime ? ` ${s.scheduledTime}` : ""}`;
  const metaArgs = {
    school: school?.code ?? "—",
    grade: cls?.grade ?? "—",
    subject: subject?.name ?? "—",
    when,
    mono,
  };

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <Link
          href="/repo/sessions"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, textDecoration: "none" }}
        >
          {t("session.back")}
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="label">
              {t.rich("session.label", {
                id: s.id.slice(0, 8),
                mono: (chunks) => (
                  <span className="mono" style={{ textTransform: "none" }}>
                    {chunks}
                  </span>
                ),
              })}
            </div>
            <h1 className="serif" style={{ fontSize: 26, marginTop: 4 }}>
              {s.topic ?? lesson?.title ?? t("session.untitled")}
            </h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
              {s.durationMin
                ? t.rich("session.metaDuration", { ...metaArgs, minutes: s.durationMin })
                : t.rich("session.meta", metaArgs)}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`chip ${statusChip.kind}`.trim()}>{statusLabel}</span>
            {/* A session a teacher entered is visible before a programme
                admin approves it, labelled as such (design: "Before approval"). */}
            {s.approvalStatus !== "approved" ? (
              <span className="chip chip-saffron">{enumLabel(t, "approval", s.approvalStatus)}</span>
            ) : null}
            {s.observed ? (
              <span className="chip chip-saffron">
                {cycle?.code ? t("session.observedCode", { code: cycle.code }) : t("session.observed")}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Body: two-column */}
      {/* One column below 768 px, 1.6fr 1fr above. This was an inline
          "1.6fr 1fr", which holds at every width, so on a phone the two
          columns stayed side by side and the page scrolled sideways. */}
      <div className="page-body grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Left col: notes + linked cycle */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <SectionCard title={t("session.notesTitle")}>
            <div
              style={{
                padding: "8px 18px 16px",
                fontSize: 13.5,
                lineHeight: 1.6,
                color: "var(--ink-2)",
              }}
            >
              {s.topic ? (
                <p style={{ margin: "8px 0" }}>
                  {t.rich("session.notesTopic", { topic: s.topic, b: bold })}
                </p>
              ) : null}
              {lesson ? (
                <p style={{ margin: "8px 0" }}>
                  {lesson.week
                    ? t.rich("session.notesLessonWeek", {
                        sequence: lesson.sequence,
                        title: lesson.title,
                        week: lesson.week,
                        b: bold,
                      })
                    : t.rich("session.notesLesson", { sequence: lesson.sequence, title: lesson.title, b: bold })}
                </p>
              ) : null}
              <p style={{ margin: "8px 0" }}>
                {s.status === "complete"
                  ? t.rich("session.notesAttendance", {
                      attendance: fmtAttendance(s.attendedCount, s.totalCount),
                      b: bold,
                    })
                  : t.rich("session.notesAttendancePending", { b: bold })}
              </p>
              {!s.topic && !lesson ? (
                <p style={{ color: "var(--ink-3)", fontStyle: "italic", margin: "8px 0" }}>
                  {t("session.noNotes")}
                </p>
              ) : null}
            </div>
          </SectionCard>

          {s.observed && cycle ? (
            <SectionCard
              title={t("session.cycleTitle")}
              sub={t("session.cycleSub")}
            >
              <div style={{ padding: 14, fontSize: 13, color: "var(--ink-2)" }}>
                {t.rich("session.cycleBody", { code: cycle.code, mono })}
                <div style={{ marginTop: 10 }}>
                  <Link
                    href={`/observation/${cycle.id}`}
                    className="btn btn-sm"
                    style={{ textDecoration: "none" }}
                  >
                    {t("session.openCycle", { code: cycle.code })}
                  </Link>
                </div>
              </div>
            </SectionCard>
          ) : null}

          {videoViewer ? <SessionVideosCard videos={videos} upload={{ kind: "session", sessionId: id }} /> : null}
        </div>

        {/* Right col: KV details */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <SectionCard title={t("common.details")}>
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label={t("session.sessionId")}>
                <span className="mono" style={{ fontSize: 12 }}>{s.id}</span>
              </KVRow>
              <KVRow label={t("common.school")}>
                <RelLink href={`/repo/school/${s.schoolId}`}>
                  {school?.code} {school?.name}
                </RelLink>
              </KVRow>
              {cls ? (
                <KVRow label={t("common.class")}>
                  <RelLink href={`/repo/class/${cls.id}`}>{t("common.gradeN", { grade: cls.grade })}</RelLink>
                </KVRow>
              ) : null}
              <KVRow label={t("common.subject")}>
                <RelLink href={`/repo/subject/${s.subjectId}`}>{subject?.name ?? "—"}</RelLink>
              </KVRow>
              <KVRow label={t("common.teacher")}>
                <RelLink href={`/repo/teacher/${s.teacherId}`}>
                  {teacher?.fullName ?? "—"}
                  {teacher?.hindiName ? (
                    <span
                      style={{
                        fontFamily: "var(--deva)",
                        color: "var(--ink-3)",
                        marginLeft: 6,
                        fontSize: 12,
                      }}
                    >
                      {teacher.hindiName}
                    </span>
                  ) : null}
                </RelLink>
              </KVRow>
              <KVRow label={t("common.date")}>
                <span className="mono" style={{ fontSize: 12 }}>
                  {s.scheduledDate}
                  {s.scheduledTime ? ` · ${s.scheduledTime}` : ""}
                </span>
              </KVRow>
              <KVRow label={t("session.duration")}>
                {s.durationMin ? t("session.minutes", { minutes: s.durationMin }) : "—"}
              </KVRow>
              <KVRow label={t("common.status")}>
                <span className={`chip ${statusChip.kind}`.trim()}>{statusLabel}</span>
              </KVRow>
              <KVRow label={t("common.attendance")}>{fmtAttendance(s.attendedCount, s.totalCount)}</KVRow>
              {outline ? (
                <KVRow label={t("common.outline")}>
                  <RelLink href={`/repo/outline/${outline.id}`}>{outline.name}</RelLink>
                </KVRow>
              ) : null}
              <KVRow label={t("session.observed")}>
                {s.observed ? (
                  <span className="chip chip-saffron">{t("session.yes")}</span>
                ) : (
                  <span className="chip">{t("session.no")}</span>
                )}
              </KVRow>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card card-hi" style={{ overflow: "hidden" }}>
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          background: "var(--paper)",
        }}
      >
        <div className="serif" style={{ fontSize: 15, color: "var(--ink)" }}>{title}</div>
        {sub ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>
        ) : null}
      </header>
      {children}
    </div>
  );
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        // minmax(0, ...): a bare 1fr is at least as wide as its content, so a
        // long code or e-mail pushed the value past the card on a phone.
        gridTemplateColumns: "120px minmax(0, 1fr)",
        overflowWrap: "anywhere",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        alignItems: "flex-start",
      }}
    >
      <span className="label" style={{ paddingTop: 2 }}>
        {label}
      </span>
      <div
        style={{
          fontSize: 13,
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function RelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="chip" style={{ textDecoration: "none", fontSize: 12 }}>
      {children}
    </Link>
  );
}
