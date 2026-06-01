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

// Hex → chip class. Subjects.color stores the design-system hex; we map it
// to the closest semantic chip variant so the table picks up the new utility
// classes without bespoke inline styling.
function chipClassForColor(hex: string | null): string {
  switch ((hex ?? "").toUpperCase()) {
    case "#D97757":
      return "chip chip-rust";
    case "#2A6FDB":
      return "chip chip-indigo";
    case "#1F8A5B":
      return "chip chip-lichen";
    case "#7A5AE0":
      return "chip chip-indigo";
    default:
      return "chip";
  }
}

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
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Subjects</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          Curricular subjects across Grades 1–10. Each subject links to its course outlines,
          sessions and reading material.
        </p>
      </div>
      <div className="page-body">
        <div className="card">
          {rows.length === 0 ? (
            <div style={{ padding: 32, color: "var(--ink-3)", fontSize: 13 }}>
              No subjects seeded yet. Run the spec 086 seed script.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  {["Subject", "Grades", "Outlines", "Sessions", "Readings", ""].map((h, i) => (
                    <th key={i}>{h}</th>
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
                    <tr key={s.id} style={{ cursor: "pointer" }}>
                      <td>
                        <Link
                          href={`/repo/subject/${s.id}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            color: "var(--ink)",
                            textDecoration: "none",
                            fontWeight: 500,
                          }}
                        >
                          <span aria-hidden className={chipClassForColor(s.color)}>
                            {s.code}
                          </span>
                          <span>{s.name}</span>
                        </Link>
                      </td>
                      <td className="mono" style={{ fontSize: 12, fontFamily: "var(--mono)" }}>
                        {gradesLabel}
                      </td>
                      <td>{s.outlines}</td>
                      <td>{s.sessions}</td>
                      <td>{s.readings}</td>
                      <td style={{ color: "var(--ink-4)", textAlign: "right" }}>
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
        </div>
      </div>
    </div>
  );
}
