// /repo/subject/[id] — curriculum subject drill-in. Replaces window.WIKI
// filters with Drizzle queries against subjects + course_outlines + sessions +
// resource_subjects + resources + teachers + schools. Visual layout: ports
// `repository.jsx` RepoSubjectPage (lines 489-560) 1:1, with a small
// "teachers who teach it" panel added per spec narrative.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  subjects,
  courseOutlines,
  sessions as classroomSessions,
  resources,
  resourceSubjects,
  teachers,
  schools,
  classes,
} from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const OUTLINE_STATUS_CHIP: Record<
  string,
  { bg: string; ink: string; border: string; label: string }
> = {
  planned: {
    bg: "var(--paper-2)",
    ink: "var(--ink-3)",
    border: "var(--line)",
    label: "Planned",
  },
  in_progress: {
    bg: "var(--saffron-soft)",
    ink: "oklch(0.42 0.13 60)",
    border: "oklch(0.82 0.08 60)",
    label: "In progress",
  },
  complete: {
    bg: "var(--lichen-soft)",
    ink: "oklch(0.32 0.08 145)",
    border: "oklch(0.82 0.06 145)",
    label: "Complete",
  },
  archived: {
    bg: "var(--paper-2)",
    ink: "var(--ink-4)",
    border: "var(--line)",
    label: "Archived",
  },
};

const SESSION_STATUS_CHIP: Record<
  string,
  { bg: string; ink: string; border: string; label: string }
> = {
  planned: {
    bg: "var(--paper-2)",
    ink: "var(--ink-3)",
    border: "var(--line)",
    label: "Planned",
  },
  in_progress: {
    bg: "var(--saffron-soft)",
    ink: "oklch(0.42 0.13 60)",
    border: "oklch(0.82 0.08 60)",
    label: "In progress",
  },
  complete: {
    bg: "var(--lichen-soft)",
    ink: "oklch(0.32 0.08 145)",
    border: "oklch(0.82 0.06 145)",
    label: "Complete",
  },
  cancelled: {
    bg: "var(--rust-soft)",
    ink: "oklch(0.40 0.13 30)",
    border: "oklch(0.82 0.08 30)",
    label: "Cancelled",
  },
};

export default async function RepoSubjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const [subject] = await db
    .select()
    .from(subjects)
    .where(eq(subjects.id, id))
    .limit(1);
  if (!subject) notFound();

  // Parallel data fetch.
  const [outlines, recentSessions, readingRows, teacherRows] = await Promise.all([
    db
      .select({
        id: courseOutlines.id,
        name: courseOutlines.name,
        grade: courseOutlines.grade,
        term: courseOutlines.term,
        sessionsCount: courseOutlines.sessionsCount,
        weeks: courseOutlines.weeks,
        status: courseOutlines.status,
      })
      .from(courseOutlines)
      .where(eq(courseOutlines.subjectId, id))
      .orderBy(asc(courseOutlines.grade), asc(courseOutlines.term)),
    db
      .select({
        id: classroomSessions.id,
        scheduledDate: classroomSessions.scheduledDate,
        topic: classroomSessions.topic,
        status: classroomSessions.status,
        grade: classes.grade,
        schoolCode: schools.code,
        teacherName: teachers.fullName,
        teacherHindi: teachers.hindiName,
      })
      .from(classroomSessions)
      .leftJoin(classes, eq(classroomSessions.classId, classes.id))
      .leftJoin(schools, eq(classroomSessions.schoolId, schools.id))
      .leftJoin(teachers, eq(classroomSessions.teacherId, teachers.id))
      .where(eq(classroomSessions.subjectId, id))
      .orderBy(desc(classroomSessions.scheduledDate))
      .limit(8),
    db
      .select({
        id: resources.id,
        name: resources.name,
        kind: resources.kind,
        owner: resources.owner,
        pages: resources.pages,
        updatedAt: resources.updatedAt,
      })
      .from(resources)
      .innerJoin(resourceSubjects, eq(resourceSubjects.resourceId, resources.id))
      .where(and(eq(resourceSubjects.subjectId, id), eq(resources.active, true)))
      .orderBy(desc(resources.updatedAt))
      .limit(40),
    db
      .select({
        id: teachers.id,
        fullName: teachers.fullName,
        hindiName: teachers.hindiName,
        schoolCode: schools.code,
        sessionsCount: sql<number>`COUNT(${classroomSessions.id})::int`.as("sessions_count"),
      })
      .from(classroomSessions)
      .innerJoin(teachers, eq(classroomSessions.teacherId, teachers.id))
      .leftJoin(schools, eq(teachers.schoolId, schools.id))
      .where(eq(classroomSessions.subjectId, id))
      .groupBy(teachers.id, teachers.fullName, teachers.hindiName, schools.code)
      .orderBy(desc(sql`COUNT(${classroomSessions.id})`))
      .limit(12),
  ]);

  // Total counts (separate from the 8/40-row preview slices above).
  const totalsRows = await db
    .select({
      outlinesTotal: sql<number>`(SELECT COUNT(*)::int FROM ${courseOutlines} WHERE ${courseOutlines.subjectId} = ${id})`,
      sessionsTotal: sql<number>`(SELECT COUNT(*)::int FROM ${classroomSessions} WHERE ${classroomSessions.subjectId} = ${id})`,
      readingsTotal: sql<number>`(SELECT COUNT(*)::int FROM ${resourceSubjects} WHERE ${resourceSubjects.subjectId} = ${id})`,
    })
    .from(subjects)
    .where(eq(subjects.id, id))
    .limit(1);
  const outlinesTotal = totalsRows[0]?.outlinesTotal ?? 0;
  const sessionsTotal = totalsRows[0]?.sessionsTotal ?? 0;
  const readingsTotal = totalsRows[0]?.readingsTotal ?? 0;

  const gradesLabel =
    subject.gradesMin != null && subject.gradesMax != null
      ? `${subject.gradesMin}–${subject.gradesMax}`
      : "—";
  const gradesCount =
    subject.gradesMin != null && subject.gradesMax != null
      ? subject.gradesMax - subject.gradesMin + 1
      : 0;

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <Link
          href="/repo/subjects"
          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
        >
          ← Subjects
        </Link>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginTop: 8,
          }}
        >
          Repository · Subject
        </div>
        <h1
          style={{
            fontFamily: "var(--serif)",
            fontSize: 28,
            marginTop: 4,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: subject.color ?? "var(--ink-4)",
              border: "1px solid var(--line-2)",
              display: "inline-block",
            }}
          />
          {subject.name}
          {subject.code ? (
            <code
              style={{
                fontFamily: "var(--mono)",
                fontSize: 14,
                color: "var(--ink-3)",
                marginLeft: 6,
                fontWeight: 400,
              }}
            >
              {subject.code}
            </code>
          ) : null}
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          Grades {gradesLabel}
          {gradesCount > 0 ? ` (${gradesCount} grades)` : ""}. FLN-aligned for foundational
          grades; SCERT framework for higher classes.
        </p>
      </header>

      {/* 4-stat strip */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 14,
          marginBottom: 16,
        }}
      >
        <StatTile label="Grades covered" value={gradesLabel} />
        <StatTile label="Course outlines" value={String(outlinesTotal)} />
        <StatTile label="Sessions" value={String(sessionsTotal)} />
        <StatTile label="Readings" value={String(readingsTotal)} />
      </section>

      {/* Course outlines */}
      <SectionCard
        title={`Course outlines (${outlinesTotal})`}
        sub="By grade and term"
      >
        {outlines.length === 0 ? (
          <EmptyRow>No outlines yet.</EmptyRow>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                {["Outline", "Grade", "Term", "Sessions", "Weeks", "Status", ""].map((h, i) => (
                  <th key={i} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {outlines.map((o) => {
                const chip = OUTLINE_STATUS_CHIP[o.status] ?? OUTLINE_STATUS_CHIP.planned;
                return (
                  <tr key={o.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={tdStyle}>
                      <Link
                        href={`/repo/outline/${o.id}`}
                        style={{ color: "var(--ink)", fontWeight: 500, textDecoration: "none" }}
                      >
                        {o.name}
                      </Link>
                    </td>
                    <td style={tdStyle}>{o.grade}</td>
                    <td style={tdStyle}>{o.term}</td>
                    <td style={tdStyle}>{o.sessionsCount}</td>
                    <td style={tdStyle}>{o.weeks ?? "—"}</td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          fontSize: 11,
                          fontWeight: 500,
                          borderRadius: 999,
                          background: chip.bg,
                          color: chip.ink,
                          border: `1px solid ${chip.border}`,
                        }}
                      >
                        {chip.label}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, color: "var(--ink-4)", textAlign: "right" }}>
                      <Link href={`/repo/outline/${o.id}`} style={{ color: "var(--ink-4)" }}>
                        ›
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* Recent sessions */}
      <SectionCard title={`Recent sessions (${sessionsTotal})`}>
        {recentSessions.length === 0 ? (
          <EmptyRow>No sessions recorded yet.</EmptyRow>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                {["Date", "School", "Grade", "Topic", "Teacher", "Status"].map((h, i) => (
                  <th key={i} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((s) => {
                const chip = SESSION_STATUS_CHIP[s.status] ?? SESSION_STATUS_CHIP.planned;
                return (
                  <tr key={s.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ ...tdStyle, fontFamily: "var(--mono)", fontSize: 12 }}>
                      {s.scheduledDate
                        ? new Date(s.scheduledDate).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : "—"}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "var(--mono)", fontSize: 12 }}>
                      {s.schoolCode ?? "—"}
                    </td>
                    <td style={tdStyle}>{s.grade ?? "—"}</td>
                    <td style={tdStyle}>{s.topic ?? "—"}</td>
                    <td style={tdStyle}>
                      {s.teacherName ?? "—"}
                      {s.teacherHindi ? (
                        <span
                          style={{
                            fontFamily: "var(--deva)",
                            color: "var(--ink-3)",
                            marginLeft: 8,
                            fontSize: 12,
                          }}
                        >
                          {s.teacherHindi}
                        </span>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          fontSize: 11,
                          fontWeight: 500,
                          borderRadius: 999,
                          background: chip.bg,
                          color: chip.ink,
                          border: `1px solid ${chip.border}`,
                        }}
                      >
                        {chip.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* Two-column: Readings + Teachers */}
      <section style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginTop: 16 }}>
        <SectionCard title={`Reading material (${readingsTotal})`}>
          {readingRows.length === 0 ? (
            <EmptyRow>No readings linked.</EmptyRow>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  {["Title", "Kind", "Owner", "Pages", "Updated", ""].map((h, i) => (
                    <th key={i} style={thStyle}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {readingRows.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={tdStyle}>
                      <Link
                        href={`/repo/resource/${r.id}`}
                        style={{ color: "var(--ink)", fontWeight: 500, textDecoration: "none" }}
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          fontSize: 11,
                          fontWeight: 500,
                          borderRadius: 999,
                          background: "var(--paper-2)",
                          color: "var(--ink-2)",
                          border: "1px solid var(--line)",
                        }}
                      >
                        {r.kind}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontSize: 12, color: "var(--ink-3)" }}>
                      {r.owner ?? "—"}
                    </td>
                    <td style={tdStyle}>{r.pages ?? "—"}</td>
                    <td style={{ ...tdStyle, fontFamily: "var(--mono)", fontSize: 12 }}>
                      {new Date(r.updatedAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                      })}
                    </td>
                    <td style={{ ...tdStyle, color: "var(--ink-4)", textAlign: "right" }}>
                      <Link href={`/repo/resource/${r.id}`} style={{ color: "var(--ink-4)" }}>
                        ›
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard title={`Teachers (${teacherRows.length})`} sub="Distinct teachers with sessions on this subject">
          {teacherRows.length === 0 ? (
            <EmptyRow>No teachers yet.</EmptyRow>
          ) : (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 0,
              }}
            >
              {teacherRows.map((t) => (
                <li
                  key={t.id}
                  style={{
                    padding: "9px 14px",
                    borderBottom: "1px solid var(--line)",
                    fontSize: 13,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    alignItems: "baseline",
                  }}
                >
                  <span>
                    <span style={{ fontWeight: 500 }}>{t.fullName}</span>
                    {t.hindiName ? (
                      <span
                        style={{
                          fontFamily: "var(--deva)",
                          color: "var(--ink-3)",
                          marginLeft: 8,
                          fontSize: 12,
                        }}
                      >
                        {t.hindiName}
                      </span>
                    ) : null}
                    {t.schoolCode ? (
                      <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 8 }}>
                        · {t.schoolCode}
                      </span>
                    ) : null}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--ink-3)",
                    }}
                  >
                    {t.sessionsCount} session{t.sessionsCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </section>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--card-hi)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        padding: 14,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ink-3)",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: "var(--serif)", fontSize: 24, marginTop: 4, color: "var(--ink)" }}>
        {value}
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
    <article
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card-hi)",
        }}
      >
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>{title}</h2>
        {sub ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>
        ) : null}
      </header>
      {children}
    </article>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
      {children}
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "separate",
  borderSpacing: 0,
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  padding: "9px 12px",
  textAlign: "left",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--ink-3)",
  fontWeight: 600,
  background: "var(--paper-2)",
  borderBottom: "1px solid var(--line)",
};

const tdStyle: React.CSSProperties = {
  padding: "9px 12px",
  textAlign: "left",
  verticalAlign: "middle",
};
