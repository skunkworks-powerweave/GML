// /repo/school/[id] — Repository: detail page for one school.
// Port of repository.jsx::RepoSchoolPage (lines 226-314) — 1:1 visual fidelity.
// Two-column body: left = Classes + Recent sessions, right = Details KV + Teachers list.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
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
import { actorFrom } from "@/lib/authz";
import { classesWhere, mayOpenSchool, repoScope, sessionsWhere, teachersWhere } from "@/lib/teaching/visibility";
import { uuidOrNotFound } from "@/lib/ids";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import { districtLabel, enumLabel, type RepoTranslator } from "@/components/repo/repo-i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("school.metaTitle") };
}

const READ_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

// The label is the district's name in the viewer's language (repo.district.*).
const DISTRICT_CHIP: Record<string, { kind: string }> = {
  leh: { kind: "chip-indigo" },
  kargil: { kind: "chip-saffron" },
  kgl: { kind: "chip-saffron" },
};

const STAGE_CHIP: Record<string, string> = {
  Primary: "chip-lichen",
  Middle: "chip-indigo",
  High: "chip-saffron",
};

// The label is repo.sessionStatus.<status>, in the viewer's language.
const SESSION_STATUS_CHIP: Record<string, { kind: string }> = {
  planned: { kind: "" },
  in_progress: { kind: "chip-saffron" },
  complete: { kind: "chip-lichen" },
  cancelled: { kind: "" },
};

function districtChipFor(t: RepoTranslator, code: string | null | undefined, name: string | null | undefined) {
  const key = (code ?? name ?? "").toLowerCase();
  const known = DISTRICT_CHIP[key];
  return known
    ? { kind: known.kind, label: districtLabel(t, key) }
    : { kind: "", label: name ?? code ?? "—" };
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
  const t = await getTranslations("repo");

  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // A teacher opens her own school only (another school answers 404), and on
  // it sees herself, the classes she teaches and her own sessions -- not the
  // school's teacher roster or colleagues' sessions (lib/teaching/visibility.ts).
  const scope = await repoScope(db, actor);
  if (!mayOpenSchool(scope, id)) notFound();

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
    .where(and(eq(classes.schoolId, id), eq(classes.active, true), classesWhere(scope)))
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
    .where(and(eq(teachers.schoolId, id), eq(teachers.active, true), teachersWhere(scope)))
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
    .where(and(eq(classroomSessions.schoolId, id), sessionsWhere(scope)))
    .orderBy(desc(classroomSessions.scheduledDate), desc(classroomSessions.scheduledTime))
    .limit(12);

  const districtChip = districtChipFor(t, school.districtCode, school.districtName);

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
          {t("school.back")}
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
              {t.rich("school.label", {
                code: school.code,
                mono: (chunks) => (
                  <span className="mono" style={{ textTransform: "none" }}>
                    {chunks}
                  </span>
                ),
              })}
            </div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
              {school.name}
            </h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640 }}>
              {t("school.intro", { zone: school.zoneName ?? "—", district: districtChip.label })}
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

      {/* One column below 768 px, 1.6fr 1fr above. This was an inline
          "1.6fr 1fr", which holds at every width, so on a phone the two
          columns stayed side by side and the page scrolled sideways. */}
      <section className="page-body grid grid-cols-1 items-start gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Left column — Classes + Recent sessions */}
        <div style={{ display: "grid", gap: 16 }}>
          <SectionCard
            title={t("school.classesTitle", { count: classRows.length })}
            sub={t("school.classesSub")}
          >
            {classRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                {t("school.noClasses")}
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("common.grade")}</th>
                    <th>{t("common.stage")}</th>
                    <th>{t("common.students")}</th>
                    <th>{t("common.sections")}</th>
                    <th>{t("common.classTeacher")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {classRows.map((c) => {
                    const stageKind = STAGE_CHIP[c.stage] ?? "";
                    return (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 500 }}>{t("common.gradeN", { grade: c.grade })}</td>
                        <td>
                          <span className={`chip ${stageKind}`}>{enumLabel(t, "stage", c.stage)}</span>
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
            title={t("school.sessionsTitle", { count: sessionRows.length })}
            sub={t("common.mostRecentFirst")}
          >
            {sessionRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                {t("school.noSessions")}
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("common.date")}</th>
                    <th>{t("common.time")}</th>
                    <th>{t("common.grade")}</th>
                    <th>{t("common.subject")}</th>
                    <th>{t("common.topic")}</th>
                    <th>{t("common.teacher")}</th>
                    <th>{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionRows.map((s) => {
                    const statusInfo =
                      SESSION_STATUS_CHIP[s.status] ?? SESSION_STATUS_CHIP.planned;
                    const statusText = enumLabel(t, "sessionStatus", SESSION_STATUS_CHIP[s.status] ? s.status : "planned");
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
                          <span className={`chip ${statusInfo.kind}`}>{statusText}</span>
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
          <SectionCard title={t("common.details")}>
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label={t("common.code")}>
                <span className="mono">{school.code}</span>
              </KVRow>
              <KVRow label={t("common.zone")}>
                <span className={`chip ${districtChip.kind}`}>{school.zoneName ?? "—"}</span>
              </KVRow>
              <KVRow label={t("common.district")}>{districtChip.label}</KVRow>
              <KVRow label={t("common.teachers")}>{teacherRows.length}</KVRow>
              <KVRow label={t("common.classes")}>{classRows.length}</KVRow>
              <KVRow label={t("common.sessionsLogged")}>{sessionRows.length}</KVRow>
              <KVRow label={t("school.principal")}>{school.headTeacherName ?? "—"}</KVRow>
              <KVRow label={t("school.onboarded")}>
                <span className="mono">
                  {school.createdAt
                    ? new Date(school.createdAt).toISOString().slice(0, 10)
                    : "—"}
                </span>
              </KVRow>
              <KVRow label={t("common.learners")}>
                <Link
                  // /repo/school/<id>/learners has never existed -- the only learners
                  // sub-route is under /repo/class/<id>. /repo/students already takes a
                  // ?school= filter, which is exactly this view.
                  href={`/repo/students?school=${school.id}`}
                  style={{
                    fontSize: 12,
                    color: "var(--indigo)",
                    textDecoration: "none",
                    fontWeight: 500,
                  }}
                >
                  {t("school.viewRoster")}
                </Link>
              </KVRow>
            </div>
          </SectionCard>

          <SectionCard
            title={t("school.teachersTitle", { count: teacherRows.length })}
            sub={t("school.teachersSub")}
          >
            {teacherRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                {t("school.noTeachers")}
              </div>
            ) : (
              <div style={{ padding: 4 }}>
                {teacherRows.map((tc, i) => (
                  <Link
                    key={tc.id}
                    href={`/repo/teacher/${tc.id}`}
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
                      {initialsOf(tc.fullName)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {tc.fullName}
                        {tc.hindiName ? (
                          <span
                            className="deva"
                            style={{
                              fontFamily: "var(--deva)",
                              color: "var(--ink-3)",
                              marginLeft: 8,
                              fontSize: 12,
                            }}
                          >
                            {tc.hindiName}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {tc.joinedPhase
                          ? t("school.teacherPhase", { subject: tc.subjectSpecialism ?? "—", phase: tc.joinedPhase })
                          : (tc.subjectSpecialism ?? "—")}
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
      {/* Scrolls sideways inside the card: a table wider than a phone was
          otherwise cut off by the card's overflow:hidden. */}
      <div style={{ overflowX: "auto" }}>{children}</div>
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
