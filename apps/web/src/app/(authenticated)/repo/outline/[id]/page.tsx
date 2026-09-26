// /repo/outline/[id] — course outline detail.
// Ports LMS GML Frontend/repository.jsx :: RepoOutlinePage (lines 601-688).
// Two-column layout (1.6fr / 1fr): outcomes + lessons + sessions ↔ details + readings.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, inArray, desc } from "drizzle-orm";
import { db } from "@gml/db";
import { uuidOrNotFound } from "@/lib/ids";
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

export const metadata: Metadata = { title: "Course outline" };

const STATUS_CHIP: Record<string, { kind: string; label: string }> = {
  planned: { kind: "", label: "Planned" },
  in_progress: { kind: "chip-saffron", label: "In progress" },
  complete: { kind: "chip-lichen", label: "Complete" },
  archived: { kind: "", label: "Archived" },
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

  const status = STATUS_CHIP[outline.status] ?? STATUS_CHIP.planned;
  const outcomes: string[] = Array.isArray(outline.learningOutcomes) ? outline.learningOutcomes : [];

  return (
    <div>
      <div className="page-header">
        <Link
          href="/repo/outlines"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, textDecoration: "none" }}
        >
          ← Course outlines
        </Link>
        <div>
          <div className="label">Course outline{subject ? ` · ${subject.name}` : ""}</div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{outline.name}</h1>
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
            {outline.weeks ? `${outline.weeks}-week unit · ` : ""}
            {outline.sessionsCount} session{outline.sessionsCount === 1 ? "" : "s"} ·{" "}
            Grade {outline.grade}, Term {outline.term}.
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
            title="Learning outcomes"
            sub="What students should demonstrate by the end of this unit"
          >
            <div style={{ padding: "8px 16px 14px" }}>
              {outcomes.length === 0 ? (
                <div style={{ color: "var(--ink-3)", fontSize: 13, padding: "6px 0" }}>
                  No outcomes recorded.
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
          <SectionCard title={`Lessons (${lessons.length})`}>
            {lessons.length === 0 ? (
              <div style={{ padding: 20, color: "var(--ink-3)", fontSize: 13 }}>
                No lessons yet.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>#</th>
                    <th>Lesson</th>
                    <th style={{ width: 80 }}>Week</th>
                    <th style={{ width: 220 }}>Lesson ID</th>
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
          <SectionCard title={`Sessions delivered against this outline (${sessionsRows.length})`}>
            {sessionsRows.length === 0 ? (
              <div style={{ padding: 20, color: "var(--ink-3)", fontSize: 13 }}>
                No sessions delivered yet.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>School</th>
                    <th>Topic</th>
                    <th>Teacher</th>
                    <th>Attendance</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionsRows.map((s) => {
                    const chipKind = SESSION_STATUS_CHIP[s.status] ?? "";
                    return (
                      <tr key={s.id}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {s.scheduledDate
                            ? new Date(s.scheduledDate).toLocaleDateString("en-IN", {
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
                            {s.status.replace("_", " ")}
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
          <SectionCard title="Details">
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label="Subject">{subject?.name ?? "—"}</KVRow>
              <KVRow label="Grade">{outline.grade}</KVRow>
              <KVRow label="Term">{outline.term}</KVRow>
              <KVRow label="Sessions">{outline.sessionsCount}</KVRow>
              <KVRow label="Weeks">{outline.weeks ?? "—"}</KVRow>
              <KVRow label="Status">
                <span className={`chip ${status.kind}`.trim()}>{status.label}</span>
              </KVRow>
              <KVRow label="Owner">
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

          <SectionCard title="Reading material" sub="Subject-tagged readings">
            <div style={{ padding: 4 }}>
              {readings.length === 0 ? (
                <div style={{ padding: 16, color: "var(--ink-3)", fontSize: 13 }}>
                  No readings tagged for this subject.
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
                        {r.kind}
                        {r.pages ? ` · ${r.pages} pages` : ""}
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

