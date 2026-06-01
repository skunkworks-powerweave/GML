// /repo/subjects — curriculum subjects index. Replaces window.WIKI.SUBJECTS
// with a Drizzle roll-up over subjects + course_outlines + sessions +
// resource_subjects. Visual layout: ports `repository.jsx` RepoSubjectsIndex
// (lines 444-484) 1:1.

import { redirect } from "next/navigation";
import Link from "next/link";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  subjects,
  courseOutlines,
  sessions as classroomSessions,
  resourceSubjects,
} from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export default async function RepoSubjectsIndexPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // One round-trip: subjects + grouped counts via correlated subqueries.
  // Aggregates are evaluated per-row in Postgres; ~9 subjects so cost is O(1).
  const rows = await db
    .select({
      id: subjects.id,
      name: subjects.name,
      code: subjects.code,
      color: subjects.color,
      gradesMin: subjects.gradesMin,
      gradesMax: subjects.gradesMax,
      displayOrder: subjects.displayOrder,
      outlines: sql<number>`(
        SELECT COUNT(*)::int FROM ${courseOutlines}
        WHERE ${courseOutlines.subjectId} = ${subjects.id}
      )`.as("outlines"),
      sessions: sql<number>`(
        SELECT COUNT(*)::int FROM ${classroomSessions}
        WHERE ${classroomSessions.subjectId} = ${subjects.id}
      )`.as("sessions"),
      readings: sql<number>`(
        SELECT COUNT(*)::int FROM ${resourceSubjects}
        WHERE ${resourceSubjects.subjectId} = ${subjects.id}
      )`.as("readings"),
    })
    .from(subjects)
    .where(eq(subjects.active, true))
    .orderBy(asc(subjects.displayOrder), asc(subjects.name));

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          Repository
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Subjects</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 640 }}>
          Curricular subjects across Grades 1–10. Each subject links to its course outlines,
          sessions and reading material.
        </p>
      </header>

      <section
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          overflow: "hidden",
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "var(--ink-3)", fontSize: 13 }}>
            No subjects seeded yet. Run the spec 086 seed script.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
            <thead>
              <tr>
                {["Subject", "Grades", "Outlines", "Sessions", "Readings", ""].map((h, i) => (
                  <th
                    key={i}
                    style={{
                      padding: "9px 12px",
                      textAlign: "left",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                      color: "var(--ink-3)",
                      fontWeight: 600,
                      background: "var(--paper-2)",
                      borderBottom: "1px solid var(--line)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const gradesLabel =
                  s.gradesMin != null && s.gradesMax != null
                    ? `${s.gradesMin}–${s.gradesMax}`
                    : "—";
                return (
                  <tr key={s.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={cellTd}>
                      <Link
                        href={`/repo/subject/${s.id}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          color: "var(--ink)",
                          textDecoration: "none",
                          fontWeight: 500,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: s.color ?? "var(--ink-4)",
                            border: "1px solid var(--line-2)",
                            flexShrink: 0,
                          }}
                        />
                        <span>{s.name}</span>
                      </Link>
                    </td>
                    <td style={{ ...cellTd, fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-3)" }}>
                      {gradesLabel}
                    </td>
                    <td style={cellTd}>{s.outlines}</td>
                    <td style={cellTd}>{s.sessions}</td>
                    <td style={cellTd}>{s.readings}</td>
                    <td style={{ ...cellTd, color: "var(--ink-4)", textAlign: "right" }}>
                      <Link href={`/repo/subject/${s.id}`} style={{ color: "var(--ink-4)" }}>
                        ›
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const cellTd: React.CSSProperties = {
  padding: "9px 12px",
  textAlign: "left",
  borderBottom: "1px solid var(--line)",
  verticalAlign: "middle",
};
