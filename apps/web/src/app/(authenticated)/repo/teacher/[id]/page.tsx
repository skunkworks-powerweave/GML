// /repo/teacher/[id] — Repository: teacher drill-in.
// Mirrors `repository.jsx` RepoTeacherPage (lines 869-908):
// KV details (name+Hindi, subject, school, phase, phone, joined), active mentor
// pairing card, recent observation cycles, sessions-taught list.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import {
  teachers,
  schools,
  zones,
  phases,
  sessions as classroomSessions,
  subjects,
  classes,
  mentorPairings,
  mentors,
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

const SESSION_STATUS_COLOR: Record<string, string> = {
  planned: "var(--ink-3)",
  in_progress: "var(--saffron)",
  complete: "var(--lichen)",
  cancelled: "var(--rust)",
};

const CYCLE_STATUS_COLOR: Record<string, string> = {
  nominated: "var(--ink-3)",
  pre_submitted: "var(--saffron)",
  observed: "var(--indigo)",
  post_submitted: "var(--saffron)",
  complete: "var(--lichen)",
};

const READ_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

export default async function RepoTeacherDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  const role = session?.user?.role ?? "teacher";
  if (!READ_ROLES.has(role)) {
    redirect("/forbidden");
  }

  const { id } = await params;

  const [teacher] = await db
    .select()
    .from(teachers)
    .where(eq(teachers.id, id))
    .limit(1);
  if (!teacher) notFound();

  const [school] = await db
    .select({
      id: schools.id,
      code: schools.code,
      name: schools.name,
      zoneName: zones.name,
    })
    .from(schools)
    .leftJoin(zones, eq(schools.zoneId, zones.id))
    .where(eq(schools.id, teacher.schoolId))
    .limit(1);

  const phaseRow = teacher.currentPhaseId
    ? await db
        .select()
        .from(phases)
        .where(eq(phases.id, teacher.currentPhaseId))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null;

  const recentSessions = await db
    .select({
      id: classroomSessions.id,
      scheduledDate: classroomSessions.scheduledDate,
      scheduledTime: classroomSessions.scheduledTime,
      status: classroomSessions.status,
      topic: classroomSessions.topic,
      durationMin: classroomSessions.durationMin,
      attendedCount: classroomSessions.attendedCount,
      totalCount: classroomSessions.totalCount,
      subjectName: subjects.name,
      classGrade: classes.grade,
    })
    .from(classroomSessions)
    .leftJoin(subjects, eq(classroomSessions.subjectId, subjects.id))
    .leftJoin(classes, eq(classroomSessions.classId, classes.id))
    .where(eq(classroomSessions.teacherId, id))
    .orderBy(desc(classroomSessions.scheduledDate))
    .limit(12);

  const recentCycles = await db
    .select({
      id: observationCycles.id,
      code: observationCycles.code,
      kind: observationCycles.kind,
      status: observationCycles.status,
      scheduledAt: observationCycles.scheduledAt,
      topic: observationCycles.topic,
    })
    .from(observationCycles)
    .where(eq(observationCycles.teacherId, id))
    .orderBy(desc(observationCycles.scheduledAt))
    .limit(6);

  const pairings = await db
    .select({
      id: mentorPairings.id,
      status: mentorPairings.status,
      startedAt: mentorPairings.startedAt,
      currentQuarter: mentorPairings.currentQuarter,
      meetingsCount: mentorPairings.meetingsCount,
      lastMeetingAt: mentorPairings.lastMeetingAt,
      mentorId: mentors.id,
      mentorName: mentors.name,
      mentorHindi: mentors.hindiName,
      mentorBase: mentors.baseLocation,
    })
    .from(mentorPairings)
    .leftJoin(mentors, eq(mentorPairings.mentorId, mentors.id))
    .where(eq(mentorPairings.teacherId, id))
    .orderBy(desc(mentorPairings.startedAt))
    .limit(5);

  const activePairing =
    pairings.find((p) => p.status === "active") ?? pairings[0] ?? null;

  const subjColor =
    (teacher.subjectSpecialism &&
      SUBJECT_COLOR[teacher.subjectSpecialism]) || {
      bg: "var(--paper-2)",
      ink: "var(--ink-3)",
    };

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <Link
          href="/repo/teachers"
          style={{
            fontSize: 12,
            color: "var(--ink-3)",
            textDecoration: "none",
          }}
        >
          ← Teachers
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
          Teacher ·{" "}
          <span style={{ fontFamily: "var(--mono)", textTransform: "none" }}>
            {teacher.id.slice(0, 8)}
          </span>
        </div>
        <h1
          style={{
            fontFamily: "var(--serif)",
            fontSize: 28,
            marginTop: 4,
          }}
        >
          {teacher.fullName}
          {teacher.hindiName ? (
            <span
              style={{
                fontFamily: "var(--deva)",
                fontSize: 18,
                color: "var(--ink-3)",
                fontWeight: 400,
                marginLeft: 10,
              }}
            >
              {teacher.hindiName}
            </span>
          ) : null}
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          {teacher.subjectSpecialism ? `Teaches ${teacher.subjectSpecialism}` : "Teacher"}
          {school ? ` at ${school.code} ${school.name}` : ""}
          {phaseRow ? `. Currently in ${phaseRow.label} of the RTT programme.` : "."}
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 18,
          alignItems: "start",
        }}
      >
        {/* LEFT: Sessions list */}
        <section
          style={{
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-3)",
            overflow: "hidden",
          }}
        >
          <header
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--line)",
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
            }}
          >
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontSize: 16,
                margin: 0,
              }}
            >
              Sessions taught ({recentSessions.length})
            </h2>
            <Link
              href="/sessions"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                textDecoration: "none",
              }}
            >
              All sessions →
            </Link>
          </header>
          {recentSessions.length === 0 ? (
            <p
              style={{
                padding: 24,
                fontSize: 12,
                color: "var(--ink-3)",
                margin: 0,
              }}
            >
              No sessions logged yet.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {recentSessions.map((s, i) => (
                <li
                  key={s.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "12px 14px",
                    borderTop: i ? "1px solid var(--line)" : "none",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--ink-3)",
                      minWidth: 84,
                    }}
                  >
                    {new Date(s.scheduledDate).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                    })}
                    {s.scheduledTime ? ` · ${s.scheduledTime.slice(0, 5)}` : ""}
                  </span>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>
                      {s.topic ?? s.subjectName ?? "Untitled session"}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--ink-3)",
                        marginTop: 2,
                      }}
                    >
                      {s.classGrade ? `Grade ${s.classGrade}` : "—"}
                      {s.subjectName ? ` · ${s.subjectName}` : ""}
                      {s.totalCount > 0
                        ? ` · ${s.attendedCount}/${s.totalCount} present`
                        : ""}
                      {s.durationMin ? ` · ${s.durationMin} min` : ""}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color:
                        SESSION_STATUS_COLOR[s.status] ?? "var(--ink-3)",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    {s.status.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* RIGHT: Details + pairing + cycles */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <section
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 14,
            }}
          >
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontSize: 16,
                marginTop: 0,
                marginBottom: 12,
              }}
            >
              Details
            </h2>
            <dl style={{ display: "grid", gap: 8, margin: 0 }}>
              <KVRow label="Subject">
                {teacher.subjectSpecialism ? (
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
                    {teacher.subjectSpecialism}
                  </span>
                ) : (
                  <span style={{ color: "var(--ink-4)" }}>—</span>
                )}
              </KVRow>
              <KVRow label="School">
                {school ? (
                  <Link
                    href={`/repo/school/${school.id}`}
                    style={{ color: "var(--indigo)", textDecoration: "none" }}
                  >
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                      {school.code}
                    </span>{" "}
                    {school.name}
                  </Link>
                ) : (
                  "—"
                )}
              </KVRow>
              {school?.zoneName ? (
                <KVRow label="Zone">{school.zoneName}</KVRow>
              ) : null}
              <KVRow label="Phase">{phaseRow?.label ?? "—"}</KVRow>
              {teacher.joinedPhase ? (
                <KVRow label="Joined phase">{teacher.joinedPhase}</KVRow>
              ) : null}
              <KVRow label="Phone">
                {teacher.phone ? (
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      color: "var(--ink-2)",
                    }}
                  >
                    {teacher.phone}
                  </span>
                ) : (
                  <span style={{ color: "var(--ink-4)" }}>—</span>
                )}
              </KVRow>
              <KVRow label="Onboarded">
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--ink-2)",
                  }}
                >
                  {new Date(teacher.createdAt).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </KVRow>
              <KVRow label="Status">
                <span
                  style={{
                    padding: "2px 8px",
                    background: teacher.active
                      ? "var(--lichen-soft)"
                      : "var(--paper-2)",
                    color: teacher.active ? "var(--lichen)" : "var(--ink-3)",
                    borderRadius: 999,
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontWeight: 600,
                  }}
                >
                  {teacher.active ? "active" : "inactive"}
                </span>
              </KVRow>
            </dl>
          </section>

          <section
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 14,
            }}
          >
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontSize: 16,
                marginTop: 0,
                marginBottom: 12,
              }}
            >
              Mentor pairing
            </h2>
            {activePairing && activePairing.mentorId ? (
              <Link
                href={`/mentorship/${activePairing.id}`}
                style={{
                  display: "block",
                  textDecoration: "none",
                  color: "var(--ink)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-2)",
                  padding: 12,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--ink-3)",
                  }}
                >
                  {activePairing.mentorBase
                    ? `${activePairing.mentorBase} · mentor`
                    : "mentor"}
                </div>
                <div style={{ fontWeight: 500, marginTop: 4 }}>
                  {activePairing.mentorName ?? "—"}
                  {activePairing.mentorHindi ? (
                    <span
                      style={{
                        fontFamily: "var(--deva)",
                        color: "var(--ink-3)",
                        marginLeft: 8,
                        fontSize: 13,
                      }}
                    >
                      {activePairing.mentorHindi}
                    </span>
                  ) : null}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--ink-3)",
                    marginTop: 8,
                  }}
                >
                  <span
                    style={{
                      padding: "2px 6px",
                      background: "var(--paper-2)",
                      borderRadius: 4,
                    }}
                  >
                    Q{activePairing.currentQuarter ?? 1}
                  </span>
                  <span>{activePairing.meetingsCount ?? 0} meetings</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      color:
                        activePairing.status === "active"
                          ? "var(--lichen)"
                          : "var(--ink-3)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontWeight: 600,
                    }}
                  >
                    {activePairing.status}
                  </span>
                </div>
              </Link>
            ) : (
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                No mentor paired yet.
              </p>
            )}
          </section>

          <section
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 14,
            }}
          >
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontSize: 16,
                marginTop: 0,
                marginBottom: 12,
              }}
            >
              Recent observation cycles ({recentCycles.length})
            </h2>
            {recentCycles.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                No cycles yet.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {recentCycles.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/observation/${c.id}`}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "baseline",
                        justifyContent: "space-between",
                        textDecoration: "none",
                        color: "var(--ink)",
                        padding: "6px 10px",
                        border: "1px solid var(--line)",
                        borderRadius: "var(--r-2)",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--ink-3)",
                        }}
                      >
                        {c.code}
                      </span>
                      <span style={{ fontSize: 12, flex: 1, marginLeft: 8 }}>
                        {c.topic ?? c.kind}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          color:
                            CYCLE_STATUS_COLOR[c.status] ?? "var(--ink-3)",
                          fontFamily: "var(--mono)",
                        }}
                      >
                        {c.status.replace("_", " ")}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function KVRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "110px 1fr",
        gap: 12,
        alignItems: "baseline",
        fontSize: 13,
      }}
    >
      <dt
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--ink-3)",
          fontWeight: 600,
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}
