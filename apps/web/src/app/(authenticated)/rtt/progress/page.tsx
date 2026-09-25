// /rtt/progress — a learner's own RTT progress, and the staff view of quiz
// results and attendance.
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

import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { rttSubjects } from "@gml/db/schema";
import { auth } from "@/auth";
import { getActiveGrant } from "@/lib/gates";
import { isUuid } from "@/lib/ids";
import { menteeTeacherIds, mentorIdFor } from "@/lib/visibility";
import { rttScope } from "@/lib/rtt/scope";
import {
  attendanceRows,
  progressBySubject,
  quizResults,
  STAFF_ROW_LIMIT,
  type StaffFilter,
} from "@/lib/rtt/progress";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<string, string> = {
  present: "chip chip-lichen",
  absent: "chip chip-rust",
  excused: "chip",
};

const fmtDate = (d: Date | null) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "unscheduled";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default async function RttProgressPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const actor = { id: session.user.id, role: session.user.role };
  const sp = await searchParams;
  const subjectId = isUuid(sp.subject) ? sp.subject : null;

  const isAdmin = actor.role === "programme_admin" || actor.role === "super_admin";
  const isMentor = actor.role === "mentor";

  if (!isAdmin && !isMentor) {
    const scope = await rttScope(db, actor);
    const mine = await progressBySubject(db, actor.id, scope.subjectWhere);
    return (
      <div>
        <Header title="My RTT progress" />
        <div className="page-body">
          {mine.length === 0 ? (
            <p style={{ color: "var(--ink-3)" }}>No RTT subjects yet.</p>
          ) : (
            <div className="card card-hi" style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Lessons</th>
                    <th>Readings</th>
                    <th>Assessments</th>
                    <th>Sessions</th>
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
                      <td className="mono">{r.lessonsDone}/{r.lessonsTotal} lessons</td>
                      <td className="mono">{r.readingsDone}/{r.readingsTotal} readings</td>
                      <td className="mono">{r.quizzesPassed}/{r.quizzesTotal} quizzes passed</td>
                      <td className="mono">
                        {r.sessionsMarked === 0 ? (
                          <span title="No attendance has been taken for you in this subject yet">—</span>
                        ) : (
                          `${r.sessionsPresent}/${r.sessionsMarked} sessions attended`
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 10 }}>
            Lessons and readings count when you mark them done on the subject page. Sessions count once
            attendance has been taken.
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
          <Header title="RTT progress & results" />
          <div className="page-body">
            <p style={{ fontSize: 13 }}>
              Your mentees&apos; quiz results and attendance are part of the mentorship section.{" "}
              <Link href={`/gate/mentorship?next=${encodeURIComponent("/rtt/progress")}`}>
                Unlock mentorship
              </Link>{" "}
              to see them.
            </p>
          </div>
        </div>
      );
    }
    const mentorId = await mentorIdFor(db, actor);
    teacherIds = mentorId ? await menteeTeacherIds(db, mentorId) : [];
  }

  const filter: StaffFilter = { teacherIds, subjectId };
  const [subjects, results, attendance] = await Promise.all([
    db
      .select({ id: rttSubjects.id, name: rttSubjects.name })
      .from(rttSubjects)
      .where(isAdmin ? undefined : eq(rttSubjects.active, true))
      .orderBy(asc(rttSubjects.name)),
    quizResults(db, filter),
    attendanceRows(db, filter),
  ]);
  const whose = isMentor ? "your mentees" : "every teacher";

  return (
    <div>
      <Header title="RTT progress & results" />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {/* A plain GET form: works with no JavaScript on a slow link. */}
        <form method="get" style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
            Subject
            <select name="subject" defaultValue={subjectId ?? ""}>
              <option value="">All subjects</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-sm">
            Show
          </button>
        </form>

        <section className="card card-hi" style={{ overflowX: "auto" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Quiz results</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              Each RTT quiz {whose} have taken: attempts, best score, and whether they passed.
            </div>
          </div>
          {results.rows.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
              No quiz has been taken yet.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Teacher</th>
                  <th>Quiz</th>
                  <th>Attempts</th>
                  <th>Best</th>
                  <th>Result</th>
                  <th>Last taken</th>
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
                    <td>{r.passed ? <span className="chip chip-lichen">Passed</span> : <span className="chip">Not passed</span>}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(r.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {results.more ? <More /> : null}
        </section>

        <section className="card card-hi" style={{ overflowX: "auto" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Attendance</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              Attendance taken at RTT sessions for {whose}, newest session first.
            </div>
          </div>
          {attendance.rows.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
              No attendance has been taken yet.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Teacher</th>
                  <th>Session</th>
                  <th>Date</th>
                  <th>Status</th>
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
                      <span className={STATUS_CHIP[r.status] ?? "chip"}>{cap(r.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {attendance.more ? <More /> : null}
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
function More() {
  return (
    <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--ink-3)", borderTop: "1px solid var(--line)" }}>
      Showing the first {STAFF_ROW_LIMIT} rows. Choose a subject to narrow the list.
    </div>
  );
}
