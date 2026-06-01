// /repo/teachers — Repository: index of all teachers across partner schools.
// Mirrors `repository.jsx` RepoTeachersIndex (lines 829-867 of the prototype):
// name + Hindi (SM-7 optional), school code, current phase, subject, sessions count.
//
// Visual presentation: utility classes from globals.css — `className="deva"`
// applies `font-family: var(--deva)` for the Devanagari Hindi name column,
// `className="mono"` applies `font-family: var(--mono)` for school codes and
// numeric counts. `className="t"` styles the table; `chip-*` variants style
// the subject pill. No inline font-family declarations beyond the serif H1.

import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  teachers,
  schools,
  phases,
  sessions as classroomSessions,
  observationCycles,
} from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// Mirrors `subjectColor(...)` in the JSX prototype (repository.jsx line 854):
// English/Science → blue → chip-indigo; Mathematics/EVS → green → chip-lichen;
// Hindi → orange → chip-saffron; Urdu → purple → chip-rust (closest semantic).
const SUBJECT_CHIP: Record<string, string> = {
  English: "chip-indigo",
  Science: "chip-indigo",
  Mathematics: "chip-lichen",
  Math: "chip-lichen",
  EVS: "chip-lichen",
  Hindi: "chip-saffron",
  Urdu: "chip-rust",
};

const READ_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

export default async function RepoTeachersIndexPage() {
  const session = await auth();
  const role = session?.user?.role ?? "teacher";
  if (!READ_ROLES.has(role)) {
    redirect("/forbidden");
  }

  // Per-teacher session counter joined inline so the index hits the DB once.
  const sessionCounts = db
    .select({
      teacherId: classroomSessions.teacherId,
      sessionsTotal: sql<number>`count(*)::int`.as("sessions_total"),
    })
    .from(classroomSessions)
    .groupBy(classroomSessions.teacherId)
    .as("session_counts");

  const cycleCounts = db
    .select({
      teacherId: observationCycles.teacherId,
      cyclesTotal: sql<number>`count(*)::int`.as("cycles_total"),
    })
    .from(observationCycles)
    .groupBy(observationCycles.teacherId)
    .as("cycle_counts");

  const rows = await db
    .select({
      id: teachers.id,
      fullName: teachers.fullName,
      hindiName: teachers.hindiName,
      phone: teachers.phone,
      subjectSpecialism: teachers.subjectSpecialism,
      active: teachers.active,
      schoolCode: schools.code,
      schoolName: schools.name,
      phaseLabel: phases.label,
      sessionsTotal: sessionCounts.sessionsTotal,
      cyclesTotal: cycleCounts.cyclesTotal,
    })
    .from(teachers)
    .leftJoin(schools, eq(teachers.schoolId, schools.id))
    .leftJoin(phases, eq(teachers.currentPhaseId, phases.id))
    .leftJoin(sessionCounts, eq(sessionCounts.teacherId, teachers.id))
    .leftJoin(cycleCounts, eq(cycleCounts.teacherId, teachers.id))
    .where(eq(teachers.active, true))
    .orderBy(asc(teachers.fullName))
    .limit(200);

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Teachers
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          {rows.length} {rows.length === 1 ? "teacher" : "teachers"} across the
          partner schools. Tap a teacher to see their sessions and pairing.
        </p>
      </div>
      <div className="page-body">
        <div className="card">
          {rows.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "var(--ink-3)",
                fontSize: 13,
              }}
            >
              No teachers yet. Add one from /admin/data/teachers.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="deva" style={{ textTransform: "none", letterSpacing: 0 }}>
                    नाम
                  </th>
                  <th>Subject</th>
                  <th>School</th>
                  <th>Phase</th>
                  <th style={{ textAlign: "right" }}>Sessions</th>
                  <th style={{ textAlign: "right" }}>Obs. cycles</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const chipKind =
                    (t.subjectSpecialism && SUBJECT_CHIP[t.subjectSpecialism]) ||
                    "";
                  return (
                    <tr key={t.id} style={{ cursor: "pointer" }}>
                      <td>
                        <Link
                          href={`/repo/teacher/${t.id}`}
                          style={{
                            color: "var(--ink)",
                            textDecoration: "none",
                            fontWeight: 500,
                          }}
                        >
                          {t.fullName}
                        </Link>
                      </td>
                      <td className="deva" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {t.hindiName ?? (
                          <span style={{ color: "var(--ink-4)" }}>—</span>
                        )}
                      </td>
                      <td>
                        {t.subjectSpecialism ? (
                          <span className={`chip ${chipKind}`.trim()}>
                            {t.subjectSpecialism}
                          </span>
                        ) : (
                          <span style={{ color: "var(--ink-4)" }}>—</span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {t.schoolCode ?? (
                          <span style={{ color: "var(--ink-4)" }}>—</span>
                        )}
                      </td>
                      <td>{t.phaseLabel ?? "—"}</td>
                      <td
                        className="mono"
                        style={{ fontSize: 12, textAlign: "right" }}
                      >
                        {t.sessionsTotal ?? 0}
                      </td>
                      <td
                        className="mono"
                        style={{ fontSize: 12, textAlign: "right" }}
                      >
                        {t.cyclesTotal ?? 0}
                      </td>
                      <td style={{ textAlign: "right", color: "var(--ink-4)" }}>
                        <Link
                          href={`/repo/teacher/${t.id}`}
                          style={{ color: "var(--ink-4)", textDecoration: "none" }}
                          aria-label={`Open ${t.fullName}`}
                        >
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
