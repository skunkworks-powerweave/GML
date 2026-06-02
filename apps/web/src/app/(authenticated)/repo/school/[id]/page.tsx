// /repo/school/[id] — Repository: detail page for one school.
// Port of repository.jsx::RepoSchoolPage (lines 226-314) — 1:1 visual fidelity.
// Two-column body: left = Classes + Recent sessions, right = Details KV + Teachers list.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import {
  schools,
  zones,
  districts,
  teachers,
  classes,
  sessions as classroomSessions,
  subjects,
} from "@gml/db/schema";
import { auth } from "@/auth";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";

export const dynamic = "force-dynamic";

const READ_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

const DISTRICT_CHIP: Record<string, { kind: string; label: string }> = {
  leh: { kind: "chip-indigo", label: "Leh" },
  kargil: { kind: "chip-saffron", label: "Kargil" },
  kgl: { kind: "chip-saffron", label: "Kargil" },
};

const STAGE_CHIP: Record<string, string> = {
  Primary: "chip-lichen",
  Middle: "chip-indigo",
  High: "chip-saffron",
};

const SESSION_STATUS_CHIP: Record<string, { kind: string; label: string }> = {
  planned: { kind: "", label: "Planned" },
  in_progress: { kind: "chip-saffron", label: "In progress" },
  complete: { kind: "chip-lichen", label: "Complete" },
  cancelled: { kind: "", label: "Cancelled" },
};

function districtChipFor(code: string | null | undefined, name: string | null | undefined) {
  const key = (code ?? name ?? "").toLowerCase();
  return (
    DISTRICT_CHIP[key] ?? {
      kind: "",
      label: name ?? code ?? "—",
    }
  );
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default async function RepoSchoolDetailPage({
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

  const [school] = await db
    .select({
      id: schools.id,
      code: schools.code,
      name: schools.name,
      address: schools.address,
      contactPhone: schools.contactPhone,
      headTeacherName: schools.headTeacherName,
      createdAt: schools.createdAt,
      zoneName: zones.name,
      districtName: districts.name,
      districtCode: districts.code,
    })
    .from(schools)
    .leftJoin(zones, eq(schools.zoneId, zones.id))
    .leftJoin(districts, eq(zones.districtId, districts.id))
    .where(eq(schools.id, id))
    .limit(1);

  if (!school) {
    notFound();
  }

  const classRows = await db
    .select({
      id: classes.id,
      grade: classes.grade,
      stage: classes.stage,
      studentsCount: classes.studentsCount,
      sectionsCount: classes.sectionsCount,
      classTeacherName: classes.classTeacherName,
    })
    .from(classes)
    .where(and(eq(classes.schoolId, id), eq(classes.active, true)))
    .orderBy(asc(classes.grade));

  const teacherRows = await db
    .select({
      id: teachers.id,
      fullName: teachers.fullName,
      hindiName: teachers.hindiName,
      subjectSpecialism: teachers.subjectSpecialism,
      joinedPhase: teachers.joinedPhase,
    })
    .from(teachers)
    .where(and(eq(teachers.schoolId, id), eq(teachers.active, true)))
    .orderBy(asc(teachers.fullName))
    .limit(50);

  const sessionRows = await db
    .select({
      id: classroomSessions.id,
      scheduledDate: classroomSessions.scheduledDate,
      scheduledTime: classroomSessions.scheduledTime,
      topic: classroomSessions.topic,
      status: classroomSessions.status,
      grade: classes.grade,
      subjectName: subjects.name,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(classroomSessions)
    .leftJoin(classes, eq(classroomSessions.classId, classes.id))
    .leftJoin(subjects, eq(classroomSessions.subjectId, subjects.id))
    .leftJoin(teachers, eq(classroomSessions.teacherId, teachers.id))
    .where(eq(classroomSessions.schoolId, id))
    .orderBy(desc(classroomSessions.scheduledDate), desc(classroomSessions.scheduledTime))
    .limit(12);

  const districtChip = districtChipFor(school.districtCode, school.districtName);

  // Spec 137 — device-aware MobileDetailFrame adoption. The mobile chrome
  // wraps the existing two-column desktop body with a thin back-arrow header.
  // Data fetching + role gating above are unchanged.
  const device = await getDeviceType();

  const body = (
    <div>
      <div className="page-header">
        <Link
          href="/repo/schools"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, display: "inline-flex" }}
        >
          ← Schools
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <div className="label">
              School · <span className="mono" style={{ textTransform: "none" }}>{school.code}</span>
            </div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
              {school.name}
            </h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640 }}>
              {school.zoneName ?? "—"}, {districtChip.label} district. Government school under
              SCERT Ladakh, partnered with the programme since 2024.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span className={`chip ${districtChip.kind}`}>{districtChip.label}</span>
            {school.zoneName ? (
              <span className="chip">{school.zoneName}</span>
            ) : null}
          </div>
        </div>
      </div>

      <section
        className="page-body"
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 18,
          alignItems: "start",
        }}
      >
        {/* Left column — Classes + Recent sessions */}
        <div style={{ display: "grid", gap: 16 }}>
          <SectionCard
            title={`Classes (${classRows.length})`}
            sub="Tap to drill into a grade"
          >
            {classRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                No classes recorded for this school yet.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Grade</th>
                    <th>Stage</th>
                    <th>Students</th>
                    <th>Sections</th>
                    <th>Class teacher</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {classRows.map((c) => {
                    const stageKind = STAGE_CHIP[c.stage] ?? "";
                    return (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 500 }}>Grade {c.grade}</td>
                        <td>
                          <span className={`chip ${stageKind}`}>{c.stage}</span>
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {c.studentsCount}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {c.sectionsCount}
                        </td>
                        <td>{c.classTeacherName ?? "—"}</td>
                        <td style={{ textAlign: "right" }}>
                          <Link
                            href={`/repo/class/${c.id}`}
                            style={{
                              fontSize: 11,
                              color: "var(--ink-3)",
                              textDecoration: "none",
                            }}
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
          </SectionCard>

          <SectionCard
            title={`Sessions (${sessionRows.length})`}
            sub="Most recent first"
          >
            {sessionRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                No sessions recorded for this school yet.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Grade</th>
                    <th>Subject</th>
                    <th>Topic</th>
                    <th>Teacher</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionRows.map((s) => {
                    const statusInfo =
                      SESSION_STATUS_CHIP[s.status] ?? SESSION_STATUS_CHIP.planned;
                    return (
                      <tr key={s.id}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {s.scheduledDate}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {s.scheduledTime ?? "—"}
                        </td>
                        <td>{s.grade ?? "—"}</td>
                        <td>{s.subjectName ?? "—"}</td>
                        <td>{s.topic ?? "—"}</td>
                        <td>
                          {s.teacherName ?? "—"}
                          {s.teacherHindi ? (
                            <span
                              className="deva"
                              style={{
                                fontFamily: "var(--deva)",
                                color: "var(--ink-3)",
                                marginLeft: 6,
                                fontSize: 12,
                              }}
                            >
                              {s.teacherHindi}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <span className={`chip ${statusInfo.kind}`}>{statusInfo.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </SectionCard>
        </div>

        {/* Right column — Details + Teachers list */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <SectionCard title="Details">
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label="Code">
                <span className="mono">{school.code}</span>
              </KVRow>
              <KVRow label="Zone">
                <span className={`chip ${districtChip.kind}`}>{school.zoneName ?? "—"}</span>
              </KVRow>
              <KVRow label="District">{districtChip.label}</KVRow>
              <KVRow label="Teachers">{teacherRows.length}</KVRow>
              <KVRow label="Classes">{classRows.length}</KVRow>
              <KVRow label="Sessions logged">{sessionRows.length}</KVRow>
              <KVRow label="Principal">{school.headTeacherName ?? "—"}</KVRow>
              <KVRow label="Onboarded">
                <span className="mono">
                  {school.createdAt
                    ? new Date(school.createdAt).toISOString().slice(0, 10)
                    : "—"}
                </span>
              </KVRow>
              <KVRow label="Learners">
                <Link
                  href={`/repo/school/${school.id}/learners`}
                  style={{
                    fontSize: 12,
                    color: "var(--indigo)",
                    textDecoration: "none",
                    fontWeight: 500,
                  }}
                >
                  View roster →
                </Link>
              </KVRow>
            </div>
          </SectionCard>

          <SectionCard
            title={`Teachers (${teacherRows.length})`}
            sub="At this school"
          >
            {teacherRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                No teachers on roster yet.
              </div>
            ) : (
              <div style={{ padding: 4 }}>
                {teacherRows.map((t, i) => (
                  <Link
                    key={t.id}
                    href={`/repo/teacher/${t.id}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderTop: i ? "1px solid var(--line)" : "none",
                      textDecoration: "none",
                      color: "var(--ink)",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        background: "var(--ink)",
                        color: "var(--paper)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {initialsOf(t.fullName)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {t.fullName}
                        {t.hindiName ? (
                          <span
                            className="deva"
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
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {t.subjectSpecialism ?? "—"}
                        {t.joinedPhase ? ` · Phase ${t.joinedPhase}` : ""}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--ink-3)",
                      }}
                    >
                      ›
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </section>
    </div>
  );

  return device === "mobile" ? (
    <MobileDetailFrame title={school.name} backHref="/repo/schools">
      {body}
    </MobileDetailFrame>
  ) : (
    body
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
          background: "var(--card)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        {sub ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>
        ) : null}
      </header>
      {children}
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
        gridTemplateColumns: "120px 1fr",
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
