// /rtt/progress — a learner's own RTT progress, and the staff view of quiz
// results, SCORM modules and attendance.
//
// Nothing showed either (F36). A teacher could not see what she had done or
// whether she was marked present; a programme admin or mentor could not see
// who sat or passed an assessment, or who attended, short of SQL: the only
// readers of quiz_submissions were the learner's own result pages, and of
// rtt_attendance the super_admin data grid. The queries are lib/rtt/progress.ts.
//
// WHO SEES WHAT
//   programme_admin, super_admin  every teacher
//   mentor                        her active mentees, and only with the
//                                 mentorship section open: which teachers are
//                                 her mentees IS the pairing roster, a gated
//                                 section's rows (lib/visibility.ts)
//   everyone else                 their own progress only
// Observers are not given the staff view: whether classroom observers should
// read teachers' training scores is a programme decision nobody has made.
// SCORM records follow the same rules (F41): before, only /admin/scorm showed
// them, so a mentor could not see how her mentees did in a module.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { rttSubjects } from "@gml/db/schema";
import { auth } from "@/auth";
import { INTL_LOCALE, type Locale } from "@/i18n/config";
import { getActiveGrant } from "@/lib/gates";
import { isUuid } from "@/lib/ids";
import { menteeTeacherIds, mentorIdFor } from "@/lib/visibility";
import { placeLabel, placeOptions, rttScope, teachersIn } from "@/lib/rtt/scope";
import { PlacePicker } from "../place-picker";
import {
  attendanceRows,
  progressBySubject,
  quizResults,
  scormResults,
  STAFF_ROW_LIMIT,
  type AttendanceStatus,
  type StaffFilter,
} from "@/lib/rtt/progress";
import { isAttendanceStatus } from "@/lib/rtt/attendance";
import { formatDuration, statusChip, statusLabel } from "@/lib/scorm/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("rtt");
  return { title: t("progress.metaTitle") };
}

// Every attendance_status, "late" included (migration 0043): the record's type
// makes a status without a chip a compile error.
const STATUS_CHIP: Record<AttendanceStatus, string> = {
  present: "chip chip-lichen",
  late: "chip chip-saffron",
  absent: "chip chip-rust",
  excused: "chip",
};

type Translate = Awaited<ReturnType<typeof getTranslations>>;

export default async function RttProgressPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string; district?: string; zone?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const actor = { id: session.user.id, role: session.user.role };
  const sp = await searchParams;
  const t = await getTranslations("rtt");
  const intl = INTL_LOCALE[(await getLocale()) as Locale];
  const fmtDate = (d: Date | null) =>
    d ? new Date(d).toLocaleDateString(intl, { day: "numeric", month: "short", year: "numeric" }) : t("common.unscheduled");
  // attendance_status -> its label (rtt.attendance.<status>), from the enum
  // itself: a hard-coded list here showed a "late" mark as the raw value.
  const attendanceLabel = (status: string) => (isAttendanceStatus(status) ? t(`attendance.${status}`) : status);
  const subjectId = isUuid(sp.subject) ? sp.subject : null;

  const isAdmin = actor.role === "programme_admin" || actor.role === "super_admin";
  const isMentor = actor.role === "mentor";

  if (!isAdmin && !isMentor) {
    const scope = await rttScope(db, actor);
    const mine = await progressBySubject(db, actor.id, scope.subjectWhere);
    return (
      <div>
        <Header title={t("progress.myTitle")} />
        <div className="page-body">
          {mine.length === 0 ? (
            <p style={{ color: "var(--ink-3)" }}>{t("progress.noSubjects")}</p>
          ) : (
            <div className="card card-hi" style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("progress.col.subject")}</th>
                    <th>{t("progress.col.lessons")}</th>
                    <th>{t("progress.col.readings")}</th>
                    <th>{t("progress.col.assessments")}</th>
                    <th>{t("progress.col.modules")}</th>
                    <th>{t("progress.col.sessions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => (
                    <tr key={r.subjectId}>
                      <td>
                        <Link href={`/rtt/subject/${r.subjectId}`}>{r.subjectName}</Link>
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          {r.phaseLabel} · {r.termName}
                        </div>
                      </td>
                      <td className="mono">{t("progress.lessonsDone", { done: r.lessonsDone, total: r.lessonsTotal })}</td>
                      <td className="mono">{t("progress.readingsDone", { done: r.readingsDone, total: r.readingsTotal })}</td>
                      <td className="mono">{t("progress.quizzesPassed", { passed: r.quizzesPassed, total: r.quizzesTotal })}</td>
                      <td className="mono">
                        {r.modulesTotal === 0 ? (
                          <span title={t("progress.noModulesTitle")}>—</span>
                        ) : (
                          t("progress.modulesCompleted", { done: r.modulesCompleted, total: r.modulesTotal })
                        )}
                      </td>
                      <td className="mono">
                        {r.sessionsMarked === 0 ? (
                          <span title={t("progress.noAttendanceTitle")}>—</span>
                        ) : (
                          t("progress.sessionsAttended", { present: r.sessionsPresent, marked: r.sessionsMarked })
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 10 }}>
            {t("progress.footnote")}
          </p>
        </div>
      </div>
    );
  }

  // Staff. A mentor's teachers are her active pairings, and those are
  // mentorship rows: without the section password she is asked for it.
  let teacherIds: string[] | null = null;
  if (isMentor) {
    if (!(await getActiveGrant(actor.id, "mentorship"))) {
      return (
        <div>
          <Header title={t("progress.staffTitle")} />
          <div className="page-body">
            <p style={{ fontSize: 13 }}>
              {t.rich("progress.mentorGate", {
                link: (chunks) => <Link href={`/gate/mentorship?next=${encodeURIComponent("/rtt/progress")}`}>{chunks}</Link>,
              })}
            </p>
          </div>
        </div>
      );
    }
    const mentorId = await mentorIdFor(db, actor);
    teacherIds = mentorId ? await menteeTeacherIds(db, mentorId) : [];
  }

  // District > zone, as on /rtt: the teachers whose school is in the place.
  const scope = await rttScope(db, actor, sp);
  const filter: StaffFilter = { teacherIds, subjectId, teachersWhere: teachersIn(scope.place) };
  const [places, subjects, results, modules, attendance] = await Promise.all([
    placeOptions(db),
    db
      .select({ id: rttSubjects.id, name: rttSubjects.name })
      .from(rttSubjects)
      .where(isAdmin ? undefined : eq(rttSubjects.active, true))
      .orderBy(asc(rttSubjects.name)),
    quizResults(db, filter),
    scormResults(db, filter),
    attendanceRows(db, filter),
  ]);
  // Whose rows these are, for the section intros: the words are the
  // messages' (a select), the place is data.
  const whose = {
    who: isMentor ? "mentees" : "everyone",
    inPlace: scope.place ? "yes" : "no",
    place: scope.place ? placeLabel(scope.place) : "",
  };

  return (
    <div>
      <Header title={t("progress.staffTitle")} />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <PlacePicker basePath="/rtt/progress" options={places} place={scope.place} keep={{ subject: subjectId }} />
        {/* A plain GET form: works with no JavaScript on a slow link. */}
        <form method="get" style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
          {scope.place ? <input type="hidden" name="district" value={scope.place.districtId} /> : null}
          {scope.place?.zoneId ? <input type="hidden" name="zone" value={scope.place.zoneId} /> : null}
          <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
            {t("progress.col.subject")}
            <select name="subject" defaultValue={subjectId ?? ""}>
              <option value="">{t("progress.allSubjects")}</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-sm">
            {t("progress.show")}
          </button>
        </form>

        <section className="card card-hi" style={{ overflowX: "auto" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t("progress.quizResults")}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              {t("progress.quizResultsIntro", whose)}
            </div>
          </div>
          {results.rows.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
              {t("progress.noQuizTaken")}
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>{t("progress.col.teacher")}</th>
                  <th>{t("progress.col.quiz")}</th>
                  <th>{t("progress.col.attempts")}</th>
                  <th>{t("progress.col.best")}</th>
                  <th>{t("progress.col.result")}</th>
                  <th>{t("progress.col.lastTaken")}</th>
                </tr>
              </thead>
              <tbody>
                {results.rows.map((r) => (
                  <tr key={`${r.teacherId}:${r.quizSlug}`}>
                    <td>
                      {r.teacherName}
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.schoolName}</div>
                    </td>
                    <td>
                      {r.quizTitle}
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.subjectName}</div>
                    </td>
                    <td className="mono">{r.attempts}</td>
                    <td className="mono">{r.bestScore}%</td>
                    <td>{r.passed ? <span className="chip chip-lichen">{t("common.passed")}</span> : <span className="chip">{t("common.notPassed")}</span>}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(r.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {results.more ? <More t={t} /> : null}
        </section>

        <section className="card card-hi" style={{ overflowX: "auto" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t("progress.scormModules")}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              {t("progress.scormIntro", whose)}
            </div>
          </div>
          {modules.rows.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
              {t("progress.noScormOpened")}
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>{t("progress.col.teacher")}</th>
                  <th>{t("progress.col.module")}</th>
                  <th>{t("progress.col.status")}</th>
                  <th>{t("progress.col.score")}</th>
                  <th>{t("progress.col.time")}</th>
                  <th>{t("progress.col.lastActivity")}</th>
                </tr>
              </thead>
              <tbody>
                {modules.rows.map((r) => (
                  <tr key={`${r.teacherId}:${r.packageId}`}>
                    <td>
                      {r.teacherName}
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.schoolName}</div>
                    </td>
                    <td>
                      {r.packageTitle}
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.subjectName}</div>
                    </td>
                    <td>
                      <span className={statusChip(r.lessonStatus)}>{statusLabel(r.lessonStatus, t)}</span>
                    </td>
                    <td className="mono">{r.scoreRaw === null ? "—" : String(r.scoreRaw)}</td>
                    <td className="mono">{formatDuration(r.timeCs, t)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {modules.more ? <More t={t} /> : null}
        </section>

        <section className="card card-hi" style={{ overflowX: "auto" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t("progress.attendance")}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              {t("progress.attendanceIntro", whose)}
            </div>
          </div>
          {attendance.rows.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
              {t("progress.noAttendance")}
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>{t("progress.col.teacher")}</th>
                  <th>{t("progress.col.session")}</th>
                  <th>{t("progress.col.date")}</th>
                  <th>{t("progress.col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {attendance.rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.teacherName}
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.schoolName}</div>
                    </td>
                    <td>
                      {r.sessionTitle}
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.subjectName}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(r.scheduledAt)}</td>
                    <td>
                      <span className={STATUS_CHIP[r.status]}>{attendanceLabel(r.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {attendance.more ? <More t={t} /> : null}
        </section>
      </div>
    </div>
  );
}

function Header({ title }: { title: string }) {
  return (
    <div className="page-header">
      <Link href="/rtt" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
        ← RTT
      </Link>
      <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{title}</h1>
    </div>
  );
}

/** Said, never silent: a capped table that looked complete would mislead. */
function More({ t }: { t: Translate }) {
  return (
    <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--ink-3)", borderTop: "1px solid var(--line)" }}>
      {t("progress.more", { limit: STAFF_ROW_LIMIT })}
    </div>
  );
}
