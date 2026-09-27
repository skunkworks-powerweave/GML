// /repo/outline/[id] — course outline detail.
// Ports LMS GML Frontend/repository.jsx :: RepoOutlinePage (lines 601-688).
// Two-column layout (1.6fr / 1fr): outcomes + lessons + sessions ↔ details + readings.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { asc, eq, inArray, desc } from "drizzle-orm";
import { db } from "@gml/db";
import { uuidOrNotFound } from "@/lib/ids";
import { enumLabel, repoIntlLocale } from "@/components/repo/repo-i18n";
import {
  courseOutlines,
  outlineLessons,
  subjects,
  teachers,
  sessions as classroomSessions,
  schools,
  resources,
  resourceSubjects,
} from "@gml/db/schema";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("outline.metaTitle") };
}

// The label is repo.outlineStatus.<status>, in the viewer's language.
const STATUS_CHIP: Record<string, { kind: string }> = {
  planned: { kind: "" },
  in_progress: { kind: "chip-saffron" },
  complete: { kind: "chip-lichen" },
  archived: { kind: "" },
};

const SESSION_STATUS_CHIP: Record<string, string> = {
  planned: "",
  in_progress: "chip-saffron",
  complete: "chip-lichen",
  cancelled: "chip-rust",
};

export default async function RepoOutlineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);

  const [outline] = await db.select().from(courseOutlines).where(eq(courseOutlines.id, id)).limit(1);
  if (!outline) notFound();

  const [subject] = await db.select().from(subjects).where(eq(subjects.id, outline.subjectId)).limit(1);
  const owner = outline.ownerTeacherId
    ? (await db.select().from(teachers).where(eq(teachers.id, outline.ownerTeacherId)).limit(1))[0]
    : undefined;

  const lessons = await db
    .select()
    .from(outlineLessons)
    .where(eq(outlineLessons.outlineId, id))
    .orderBy(asc(outlineLessons.sequence));

  // Sessions delivered against any of this outline's lessons.
  const lessonIds = lessons.map((l) => l.id);
  const sessionsRows = lessonIds.length
    ? await db
        .select({
          id: classroomSessions.id,
          scheduledDate: classroomSessions.scheduledDate,
          scheduledTime: classroomSessions.scheduledTime,
          topic: classroomSessions.topic,
          status: classroomSessions.status,
          attendedCount: classroomSessions.attendedCount,
          totalCount: classroomSessions.totalCount,
          schoolCode: schools.code,
          schoolName: schools.name,
          teacherName: teachers.fullName,
          teacherHindi: teachers.hindiName,
        })
        .from(classroomSessions)
        .leftJoin(schools, eq(classroomSessions.schoolId, schools.id))
        .leftJoin(teachers, eq(classroomSessions.teacherId, teachers.id))
        .where(inArray(classroomSessions.outlineLessonId, lessonIds))
        .orderBy(desc(classroomSessions.scheduledDate))
        .limit(20)
    : [];

  // Subject-tagged readings: resource_subjects join.
  const readings = await db
    .select({
      id: resources.id,
      name: resources.name,
      kind: resources.kind,
      pages: resources.pages,
    })
    .from(resources)
    .innerJoin(resourceSubjects, eq(resourceSubjects.resourceId, resources.id))
    .where(eq(resourceSubjects.subjectId, outline.subjectId))
    .orderBy(asc(resources.name))
    .limit(5);

  const t = await getTranslations("repo");
  const intl = await repoIntlLocale();
  const status = STATUS_CHIP[outline.status] ?? STATUS_CHIP.planned;
  const statusLabel = enumLabel(t, "outlineStatus", STATUS_CHIP[outline.status] ? outline.status : "planned");
  const outcomes: string[] = Array.isArray(outline.learningOutcomes) ? outline.learningOutcomes : [];
  const kindLabel = (kind: string) => enumLabel(t, "resourceKind", kind);

  return (
    <div>
      <div className="page-header">
        <Link
          href="/repo/outlines"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, textDecoration: "none" }}
        >
          {t("outline.back")}
        </Link>
        <div>
          <div className="label">
            {subject ? t("outline.labelSubject", { subject: subject.name }) : t("outline.label")}
          </div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{outline.name}</h1>
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
            {outline.weeks
              ? t("outline.summaryWeeks", {
                  weeks: outline.weeks,
                  sessions: outline.sessionsCount,
                  grade: outline.grade,
                  term: outline.term,
                })
              : t("outline.summary", { sessions: outline.sessionsCount, grade: outline.grade, term: outline.term })}
          </p>
        </div>
      </div>

      {/* One column below 768 px, 1.6fr 1fr above. This was an inline
          "1.6fr 1fr", which holds at every width, so on a phone the two
          columns stayed side by side and the page scrolled sideways. */}
      <div className="page-body grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Main column */}
        <div style={{ display: "grid", gap: 16 }}>
          {/* Learning outcomes */}
          <SectionCard
            title={t("outline.outcomesTitle")}
            sub={t("outline.outcomesSub")}
          >
            <div style={{ padding: "8px 16px 14px" }}>
              {outcomes.length === 0 ? (
                <div style={{ color: "var(--ink-3)", fontSize: 13, padding: "6px 0" }}>
                  {t("outline.noOutcomes")}
                </div>
              ) : (
                outcomes.map((lo, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "20px minmax(0, 1fr)",
                      gap: 8,
                      padding: "6px 0",
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                  >
                    <span className="mono" style={{ color: "var(--ink-3)", fontSize: 11 }}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>{lo}</span>
                  </div>
                ))
              )}
            </div>
          </SectionCard>

          {/* Lessons */}
          <SectionCard title={t("outline.lessonsTitle", { count: lessons.length })}>
            {lessons.length === 0 ? (
              <div style={{ padding: 20, color: "var(--ink-3)", fontSize: 13 }}>
                {t("outline.noLessons")}
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>#</th>
                    <th>{t("outline.lesson")}</th>
                    <th style={{ width: 80 }}>{t("outline.week")}</th>
                    <th style={{ width: 220 }}>{t("outline.lessonId")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lessons.map((l) => (
                    <tr key={l.id}>
                      <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {String(l.sequence).padStart(2, "0")}
                      </td>
                      <td style={{ fontWeight: 500 }}>{l.title}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{l.week ?? "—"}</td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {l.id}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          {/* Sessions delivered */}
          <SectionCard title={t("outline.sessionsTitle", { count: sessionsRows.length })}>
            {sessionsRows.length === 0 ? (
              <div style={{ padding: 20, color: "var(--ink-3)", fontSize: 13 }}>
                {t("outline.noSessions")}
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("common.date")}</th>
                    <th>{t("common.school")}</th>
                    <th>{t("common.topic")}</th>
                    <th>{t("common.teacher")}</th>
                    <th>{t("common.attendance")}</th>
                    <th>{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionsRows.map((s) => {
                    const chipKind = SESSION_STATUS_CHIP[s.status] ?? "";
                    const statusText = enumLabel(t, "sessionStatusPlain", s.status);
                    return (
                      <tr key={s.id}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {s.scheduledDate
                            ? new Date(s.scheduledDate).toLocaleDateString(intl, {
                                day: "numeric",
                                month: "short",
                              })
                            : "—"}
                        </td>
                        <td>{s.schoolCode ?? s.schoolName ?? "—"}</td>
                        <td>{s.topic ?? "—"}</td>
                        <td>
                          {s.teacherName ?? "—"}
                          {s.teacherHindi ? (
                            <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 6, fontSize: 12 }}>
                              {s.teacherHindi}
                            </span>
                          ) : null}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {s.totalCount ? `${s.attendedCount} / ${s.totalCount}` : "—"}
                        </td>
                        <td>
                          <span className={`chip ${chipKind}`.trim()}>
                            {statusText}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </SectionCard>
        </div>

        {/* Sidebar */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <SectionCard title={t("common.details")}>
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label={t("common.subject")}>{subject?.name ?? "—"}</KVRow>
              <KVRow label={t("common.grade")}>{outline.grade}</KVRow>
              <KVRow label={t("common.term")}>{outline.term}</KVRow>
              <KVRow label={t("common.sessions")}>{outline.sessionsCount}</KVRow>
              <KVRow label={t("common.weeks")}>{outline.weeks ?? "—"}</KVRow>
              <KVRow label={t("common.status")}>
                <span className={`chip ${status.kind}`.trim()}>{statusLabel}</span>
              </KVRow>
              <KVRow label={t("common.owner")}>
                {owner ? (
                  <>
                    {owner.fullName}
                    {owner.hindiName ? (
                      <span className="deva" style={{ color: "var(--ink-3)", marginLeft: 6, fontSize: 12 }}>
                        {owner.hindiName}
                      </span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </KVRow>
            </div>
          </SectionCard>

          <SectionCard title={t("common.readingMaterial")} sub={t("outline.readingSub")}>
            <div style={{ padding: 4 }}>
              {readings.length === 0 ? (
                <div style={{ padding: 16, color: "var(--ink-3)", fontSize: 13 }}>
                  {t("outline.noReadings")}
                </div>
              ) : (
                readings.map((r, i) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderTop: i ? "1px solid var(--line)" : "none",
                      fontSize: 13,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        background: "var(--paper-2)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        color: "var(--ink-3)",
                        fontFamily: "var(--mono)",
                      }}
                    >
                      ▤
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {r.pages
                          ? t("outline.readingPages", { kind: kindLabel(r.kind), pages: r.pages })
                          : kindLabel(r.kind)}
                      </div>
                    </div>
                  </div>
                ))
              )}
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
    <section className="card card-hi" style={{ overflow: "hidden" }}>
      <header style={{ padding: "12px 16px 8px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 16 }}>{title}</div>
        {sub ? <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div> : null}
      </header>
      {/* Scrolls sideways inside the card: a table wider than a phone was
          otherwise cut off by the card's overflow:hidden. */}
      <div style={{ overflowX: "auto" }}>{children}</div>
    </section>
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
      <span
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontWeight: 500,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <div style={{ fontSize: 13, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}

