// /repo/subject/[id] — curriculum subject drill-in. Replaces window.WIKI
// filters with Drizzle queries against subjects + course_outlines + sessions +
// resource_subjects + resources + teachers + schools. Visual layout: ports
// `repository.jsx` RepoSubjectPage (lines 489-560) 1:1, with a small
// "teachers who teach it" panel added per spec narrative.

import type { Metadata } from "next";
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
import { uuidOrNotFound } from "@/lib/ids";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Subject" };

// Status → chip-* utility class + label. Matches JSX `Chip kind={...}` pattern
// using the global utilities now in globals.css.
const OUTLINE_STATUS_CHIP: Record<string, { cls: string; label: string }> = {
  planned: { cls: "", label: "Planned" },
  in_progress: { cls: "chip-saffron", label: "In progress" },
  complete: { cls: "chip-lichen", label: "Complete" },
  archived: { cls: "", label: "Archived" },
};

const SESSION_STATUS_CHIP: Record<string, { cls: string; label: string }> = {
  planned: { cls: "", label: "Planned" },
  in_progress: { cls: "chip-saffron", label: "In progress" },
  complete: { cls: "chip-lichen", label: "Complete" },
  cancelled: { cls: "chip-rust", label: "Cancelled" },
};

export default async function RepoSubjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);
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
      <div className="page-header">
        <Link
          href="/repo/subjects"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8 }}
        >
          ← Subjects
        </Link>
        <div>
          <div className="label">Repository · Subject</div>
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
        </div>
      </div>

      {/* PHONE WIDTH: the stat strip was an inline repeat(4, 1fr) and the
          readings/teachers pair "1.5fr 1fr", both held at every width.
          Below 768 px the stats go two a row and the pair stacks; the page
          column is minmax(0, 1fr) so the tables scroll in their cards. */}
      <div className="page-body" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
        {/* 4-stat strip */}
        <section className="grid grid-cols-2 gap-[14px] md:grid-cols-4">
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
          <table className="t">
            <thead>
              <tr>
                <th>Outline</th>
                <th>Grade</th>
                <th>Term</th>
                <th>Sessions</th>
                <th>Weeks</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {outlines.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "var(--ink-3)", padding: 24 }}>
                    No outlines yet.
                  </td>
                </tr>
              ) : (
                outlines.map((o) => {
                  const chip = OUTLINE_STATUS_CHIP[o.status] ?? OUTLINE_STATUS_CHIP.planned;
                  return (
                    <tr key={o.id}>
                      <td style={{ fontWeight: 500 }}>
                        <Link
                          href={`/repo/outline/${o.id}`}
                          style={{ color: "var(--ink)", textDecoration: "none" }}
                        >
                          {o.name}
                        </Link>
                      </td>
                      <td>{o.grade}</td>
                      <td>{o.term}</td>
                      <td>{o.sessionsCount}</td>
                      <td>{o.weeks ?? "—"}</td>
                      <td>
                        <span className={`chip ${chip.cls}`.trim()}>{chip.label}</span>
                      </td>
                      <td style={{ color: "var(--ink-4)", textAlign: "right" }}>
                        <Link href={`/repo/outline/${o.id}`} style={{ color: "var(--ink-4)" }}>
                          ›
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </SectionCard>

        {/* Recent sessions */}
        <SectionCard title={`Recent sessions (${sessionsTotal})`}>
          <table className="t">
            <thead>
              <tr>
                <th>Date</th>
                <th>School</th>
                <th>Grade</th>
                <th>Topic</th>
                <th>Teacher</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentSessions.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--ink-3)", padding: 24 }}>
                    No sessions recorded yet.
                  </td>
                </tr>
              ) : (
                recentSessions.map((s) => {
                  const chip = SESSION_STATUS_CHIP[s.status] ?? SESSION_STATUS_CHIP.planned;
                  return (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.scheduledDate
                          ? new Date(s.scheduledDate).toLocaleDateString("en-IN", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : "—"}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.schoolCode ?? "—"}
                      </td>
                      <td>{s.grade ?? "—"}</td>
                      <td>{s.topic ?? "—"}</td>
                      <td>
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
                      <td>
                        <span className={`chip ${chip.cls}`.trim()}>{chip.label}</span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </SectionCard>

        {/* Two-column: Readings + Teachers */}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <SectionCard title={`Reading material (${readingsTotal})`}>
            <table className="t">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Kind</th>
                  <th>Owner</th>
                  <th>Pages</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {readingRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "var(--ink-3)", padding: 24 }}>
                      No readings linked.
                    </td>
                  </tr>
                ) : (
                  readingRows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 500 }}>
                        <Link
                          href={`/repo/resource/${r.id}`}
                          style={{ color: "var(--ink)", textDecoration: "none" }}
                        >
                          {r.name}
                        </Link>
                      </td>
                      <td>
                        <span className="chip">{r.kind}</span>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {r.owner ?? "—"}
                      </td>
                      <td>{r.pages ?? "—"}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {new Date(r.updatedAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                        })}
                      </td>
                      <td style={{ color: "var(--ink-4)", textAlign: "right" }}>
                        <Link href={`/repo/resource/${r.id}`} style={{ color: "var(--ink-4)" }}>
                          ›
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </SectionCard>

          <SectionCard
            title={`Teachers (${teacherRows.length})`}
            sub="Distinct teachers with sessions on this subject"
          >
            {teacherRows.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                No teachers yet.
              </div>
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
                      className="mono"
                      style={{
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
    </div>
  );
}

// Stat tile — matches JSX `Stat` (ui.jsx:147) using `.card` + `.label` + serif numeric.
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="label">{label}</div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginTop: 6,
        }}
      >
        <div
          className="serif"
          style={{
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: "-0.02em",
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

// Section card — matches JSX `SectionCard` (ui.jsx:161) using `.card`.
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
    <div className="card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "12px 14px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
          {sub ? (
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>
          ) : null}
        </div>
      </div>
      {/* Scrolls sideways inside the card: a table wider than a phone was
          otherwise cut off by the card's overflow:hidden. */}
      <div style={{ overflowX: "auto" }}>{children}</div>
    </div>
  );
}
