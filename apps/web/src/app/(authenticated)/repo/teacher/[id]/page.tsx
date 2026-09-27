// /repo/teacher/[id] — Repository: teacher drill-in.
// Mirrors `repository.jsx` RepoTeacherPage (lines 869-908):
// KV details (name+Hindi, subject, school, phase, phone, joined), active mentor
// pairing card, recent observation cycles, sessions-taught list.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
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
} from "@gml/db/schema";
import { auth } from "@/auth";
import { uuidOrNotFound } from "@/lib/ids";
import { actorFrom } from "@/lib/authz";
import { teacherCycleHistory, teacherPairingHistory } from "@/lib/gated-reads";
import { mentorshipAccess, observationAccess } from "@/lib/visibility";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import { enumLabel, present, repoIntlLocale } from "@/components/repo/repo-i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("teacher.metaTitle") };
}

const SUBJECT_COLOR: Record<string, { chip: string }> = {
  English: { chip: "chip-indigo" },
  Mathematics: { chip: "chip-lichen" },
  Math: { chip: "chip-lichen" },
  EVS: { chip: "chip-lichen" },
  Science: { chip: "chip-indigo" },
  Hindi: { chip: "chip-saffron" },
  Urdu: { chip: "chip-indigo" },
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
  // READ_ROLES answers "may you read /repo at all" and stays. The actor is what
  // the section-access checks below need; actorFrom only narrows a null session.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const t = await getTranslations("repo");
  const intl = await repoIntlLocale();

  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);

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

  // The teacher's own profile -- name, subject, school, phase, sessions -- is
  // directory data and stays visible to any signed-in user; that is what /repo
  // is for. THE OBSERVATION HISTORY AND THE MENTOR PAIRING ARE NOT. Both were
  // bare `teacher_id = $1` selects on a page outside the observation and
  // mentorship section gates, so any teacher could open a colleague from
  // /repo/teachers and read her cycle codes, topics, evaluative-vs-developmental
  // kind and stage, plus who mentors her, where, and how often they meet -- the
  // rows /observation and /mentorship guard with a section password AND a
  // per-actor predicate. Both controls now apply here too: without the section
  // grant the card is locked and no query runs (so not even the count
  // escapes); with it, the actor's visibility predicate is in the SQL.
  // Executed in tests/behaviour/access-control.test.ts.
  const [observation, mentorship] = await Promise.all([
    observationAccess(db, actor),
    mentorshipAccess(db, actor),
  ]);
  const [recentCycles, pairings] = await Promise.all([
    teacherCycleHistory(db, observation, id),
    teacherPairingHistory(db, mentorship, id),
  ]);

  const activePairing =
    pairings?.find((p) => p.status === "active") ?? pairings?.[0] ?? null;
  const unlockHref = (slug: "observation" | "mentorship") =>
    `/gate/${slug}?next=${encodeURIComponent(`/repo/teacher/${id}`)}`;

  const subjColor =
    (teacher.subjectSpecialism &&
      SUBJECT_COLOR[teacher.subjectSpecialism]) || { chip: "" };

  // Stored statuses and kinds, as labels in the viewer's language.
  const sessionStatusText = (status: string) => enumLabel(t, "sessionStatusPlain", status);
  const cycleStatusText = (status: string) => enumLabel(t, "cycleStatus", status);
  const cycleKindText = (kind: string) => enumLabel(t, "cycleKind", kind);
  const pairingStatusText = (status: string) => enumLabel(t, "pairingStatus", status);

  // Spec 137 — device-aware MobileDetailFrame adoption. Wraps the desktop
  // two-column body in the thin-header chrome on mobile; on desktop the
  // existing layout renders unchanged. Data fetching above is untouched.
  const device = await getDeviceType();
  const mobileTitle = teacher.fullName;

  const body = (
    <div>
      <div className="page-header">
        <Link
          href="/repo/teachers"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, textDecoration: "none" }}
        >
          {t("teacher.back")}
        </Link>
        <div>
          <div className="label">
            {t.rich("teacher.label", {
              id: teacher.id.slice(0, 8),
              mono: (chunks) => (
                <span
                  className="mono"
                  style={{
                    fontFamily: "var(--mono)",
                    textTransform: "none",
                    letterSpacing: 0,
                  }}
                >
                  {chunks}
                </span>
              ),
            })}
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
                className="deva"
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
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
            {t("teacher.intro", {
              hasSubject: present(teacher.subjectSpecialism),
              subject: teacher.subjectSpecialism ?? "",
              hasSchool: present(school),
              school: school ? `${school.code} ${school.name}` : "",
              hasPhase: present(phaseRow),
              phase: phaseRow?.label ?? "",
            })}
          </p>
        </div>
      </div>

      {/* One column below 768 px, 1.6fr 1fr above. This was an inline
          "1.6fr 1fr", which holds at every width, so on a phone the two
          columns stayed side by side and the page scrolled sideways. */}
      <div className="page-body grid grid-cols-1 items-start gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* LEFT: Sessions list */}
        <section className="card card-hi" style={{ overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "12px 14px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {t("teacher.sessionsTitle", { count: recentSessions.length })}
            </div>
            <div style={{ marginLeft: "auto" }}>
              <Link href="/repo/sessions" className="btn btn-sm">
                {t("common.allSessions")}
              </Link>
            </div>
          </div>
          {recentSessions.length === 0 ? (
            <p
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--ink-3)",
                margin: 0,
              }}
            >
              {t("common.noSessionsYet")}
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("common.date")}</th>
                    <th>{t("common.time")}</th>
                    <th>{t("common.grade")}</th>
                    <th>{t("common.subject")}</th>
                    <th>{t("common.topic")}</th>
                    <th>{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((s) => (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {new Date(s.scheduledDate).toLocaleDateString(intl, {
                          day: "numeric",
                          month: "short",
                        })}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.scheduledTime ? s.scheduledTime.slice(0, 5) : "—"}
                      </td>
                      <td>{s.classGrade ? t("common.gradeN", { grade: s.classGrade }) : "—"}</td>
                      <td>{s.subjectName ?? "—"}</td>
                      <td>{s.topic ?? "—"}</td>
                      <td>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            color:
                              SESSION_STATUS_COLOR[s.status] ?? "var(--ink-3)",
                          }}
                        >
                          {sessionStatusText(s.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* RIGHT: Details + pairing + cycles */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <section className="card card-hi">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "12px 14px",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t("common.details")}</div>
            </div>
            <dl style={{ padding: "0 14px 8px", margin: 0 }}>
              <KVRow label={t("common.subject")}>
                {teacher.subjectSpecialism ? (
                  <span className={`chip ${subjColor.chip}`}>
                    {teacher.subjectSpecialism}
                  </span>
                ) : (
                  <span style={{ color: "var(--ink-4)" }}>—</span>
                )}
              </KVRow>
              <KVRow label={t("common.school")}>
                {school ? (
                  <Link
                    href={`/repo/school/${school.id}`}
                    style={{ color: "var(--indigo)", textDecoration: "none" }}
                  >
                    <span className="mono" style={{ fontSize: 11 }}>
                      {school.code}
                    </span>{" "}
                    {school.name}
                  </Link>
                ) : (
                  "—"
                )}
              </KVRow>
              {school?.zoneName ? (
                <KVRow label={t("common.zone")}>{school.zoneName}</KVRow>
              ) : null}
              <KVRow label={t("common.phase")}>{phaseRow?.label ?? "—"}</KVRow>
              {teacher.joinedPhase ? (
                <KVRow label={t("teacher.joinedPhase")}>{teacher.joinedPhase}</KVRow>
              ) : null}
              <KVRow label={t("teacher.phone")}>
                {teacher.phone ? (
                  <span
                    className="mono"
                    style={{ fontSize: 12, color: "var(--ink-2)" }}
                  >
                    {teacher.phone}
                  </span>
                ) : (
                  <span style={{ color: "var(--ink-4)" }}>—</span>
                )}
              </KVRow>
              <KVRow label={t("teacher.onboarded")}>
                <span
                  className="mono"
                  style={{ fontSize: 12, color: "var(--ink-2)" }}
                >
                  {new Date(teacher.createdAt).toLocaleDateString(intl, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </KVRow>
              <KVRow label={t("common.status")}>
                <span
                  className={`chip ${teacher.active ? "chip-lichen" : ""}`}
                >
                  {teacher.active ? t("teacher.statusActive") : t("teacher.statusInactive")}
                </span>
              </KVRow>
            </dl>
          </section>

          <section className="card card-hi">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "12px 14px",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t("teacher.pairingTitle")}</div>
            </div>
            <div style={{ padding: 14 }}>
              {pairings === null ? (
                <LockedNote
                  text={t.rich("teacher.lockedMentorship", { link: unlockLink(unlockHref("mentorship")) })}
                />
              ) : activePairing && activePairing.mentorId ? (
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
                  <div className="label">
                    {activePairing.mentorBase
                      ? t("teacher.mentorLabelBase", { base: activePairing.mentorBase })
                      : t("teacher.mentorLabel")}
                  </div>
                  <div style={{ fontWeight: 500, marginTop: 4 }}>
                    {activePairing.mentorName ?? "—"}
                    {activePairing.mentorHindi ? (
                      <span
                        className="deva"
                        style={{
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
                      alignItems: "center",
                      marginTop: 8,
                    }}
                  >
                    <span className="chip">
                      Q{activePairing.currentQuarter ?? 1}
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 11, color: "var(--ink-3)" }}
                    >
                      {t("teacher.meetings", { count: activePairing.meetingsCount ?? 0 })}
                    </span>
                    <span
                      className={`chip ${activePairing.status === "active" ? "chip-lichen" : ""}`}
                      style={{ marginLeft: "auto" }}
                    >
                      {pairingStatusText(activePairing.status)}
                    </span>
                  </div>
                </Link>
              ) : (
                <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                  {t("teacher.noMentor")}
                </p>
              )}
            </div>
          </section>

          <section className="card card-hi">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "12px 14px",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {recentCycles
                  ? t("teacher.cyclesTitleCount", { count: recentCycles.length })
                  : t("teacher.cyclesTitle")}
              </div>
            </div>
            <div style={{ padding: 14 }}>
              {recentCycles === null ? (
                <LockedNote
                  text={t.rich("teacher.lockedObservation", { link: unlockLink(unlockHref("observation")) })}
                />
              ) : recentCycles.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                  {t("teacher.noCycles")}
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
                          className="mono"
                          style={{ fontSize: 11, color: "var(--ink-3)" }}
                        >
                          {c.code}
                        </span>
                        <span style={{ fontSize: 12, flex: 1, marginLeft: 8 }}>
                          {c.topic ?? cycleKindText(c.kind)}
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            color:
                              CYCLE_STATUS_COLOR[c.status] ?? "var(--ink-3)",
                          }}
                        >
                          {cycleStatusText(c.status)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );

  return device === "mobile" ? (
    <MobileDetailFrame title={mobileTitle} backHref="/repo/teachers">
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}

/**
 * A gated card's content when the viewer has not unlocked that section. Says
 * why the card is empty and offers the unlock, returning here afterwards,
 * rather than rendering "No cycles yet." -- which would be a false statement.
 * `text` is the whole sentence (repo.teacher.locked*), its <link> the unlock.
 */
function LockedNote({ text }: { text: React.ReactNode }) {
  return <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>{text}</p>;
}

/** The unlock link inside a LockedNote sentence (the message's <link> tag). */
function unlockLink(href: string) {
  function UnlockLink(chunks: React.ReactNode) {
    return (
      <Link href={href} style={{ color: "var(--indigo)" }}>
        {chunks}
      </Link>
    );
  }
  return UnlockLink;
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
      <dt
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
      </dt>
      <dd
        style={{
          margin: 0,
          fontSize: 13,
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
        }}
      >
        {children}
      </dd>
    </div>
  );
}
