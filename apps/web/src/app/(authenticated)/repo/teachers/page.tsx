// /repo/teachers — Repository: index of all teachers across partner schools.
// Mirrors `repository.jsx` RepoTeachersIndex (lines 829-867 of the prototype):
// name + Hindi (SM-7 optional), school code, current phase, subject, sessions count.

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

const SUBJECT_COLOR: Record<string, { bg: string; ink: string }> = {
  English: { bg: "var(--indigo-soft)", ink: "var(--indigo)" },
  Mathematics: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  Math: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  EVS: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  Science: { bg: "var(--indigo-soft)", ink: "var(--indigo)" },
  Hindi: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  Urdu: { bg: "var(--rust-soft)", ink: "var(--rust)" },
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
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Teachers
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          {rows.length} {rows.length === 1 ? "teacher" : "teachers"} across the
          partner schools. Tap a teacher to see their sessions and pairing.
        </p>
      </header>

      <section
        style={{
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          overflow: "hidden",
        }}
      >
        {rows.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--ink-3)",
            }}
          >
            No teachers yet. Add one from /admin/data/teachers.
          </div>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr
                style={{
                  background: "var(--paper-2)",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <Th>Name</Th>
                <Th deva>नाम</Th>
                <Th>Subject</Th>
                <Th>School</Th>
                <Th>Phase</Th>
                <Th align="right">Sessions</Th>
                <Th align="right">Obs. cycles</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => {
                const subjColor =
                  (t.subjectSpecialism &&
                    SUBJECT_COLOR[t.subjectSpecialism]) || {
                    bg: "var(--paper-2)",
                    ink: "var(--ink-3)",
                  };
                return (
                  <tr
                    key={t.id}
                    style={{
                      borderTop: i ? "1px solid var(--line)" : "none",
                    }}
                  >
                    <Td>
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
                    </Td>
                    <Td>
                      {t.hindiName ? (
                        <span
                          style={{
                            fontFamily: "var(--deva)",
                            fontSize: 12,
                            color: "var(--ink-3)",
                          }}
                        >
                          {t.hindiName}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink-4)" }}>—</span>
                      )}
                    </Td>
                    <Td>
                      {t.subjectSpecialism ? (
                        <span
                          style={{
                            padding: "2px 8px",
                            background: subjColor.bg,
                            color: subjColor.ink,
                            borderRadius: 999,
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            fontWeight: 600,
                          }}
                        >
                          {t.subjectSpecialism}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink-4)" }}>—</span>
                      )}
                    </Td>
                    <Td>
                      {t.schoolCode ? (
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 11,
                            color: "var(--ink-2)",
                          }}
                        >
                          {t.schoolCode}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink-4)" }}>—</span>
                      )}
                    </Td>
                    <Td>
                      <span style={{ color: "var(--ink-2)" }}>
                        {t.phaseLabel ?? "—"}
                      </span>
                    </Td>
                    <Td align="right">
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--ink-2)",
                        }}
                      >
                        {t.sessionsTotal ?? 0}
                      </span>
                    </Td>
                    <Td align="right">
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--ink-2)",
                        }}
                      >
                        {t.cyclesTotal ?? 0}
                      </span>
                    </Td>
                    <Td align="right">
                      <Link
                        href={`/repo/teacher/${t.id}`}
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          textDecoration: "none",
                        }}
                      >
                        ›
                      </Link>
                    </Td>
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

function Th({
  children,
  align,
  deva,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  deva?: boolean;
}) {
  return (
    <th
      style={{
        padding: "10px 14px",
        textAlign: align ?? "left",
        fontSize: 10,
        textTransform: deva ? "none" : "uppercase",
        letterSpacing: deva ? "0" : "0.06em",
        color: "var(--ink-3)",
        fontWeight: 600,
        fontFamily: deva ? "var(--deva)" : "var(--sans)",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      style={{
        padding: "10px 14px",
        textAlign: align ?? "left",
        verticalAlign: "middle",
      }}
    >
      {children}
    </td>
  );
}
