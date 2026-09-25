// /rtt/subject/[id] — RTT subject drill-in: modules + sessions + readings.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { auth } from "@/auth";
import {
  rttSubjects,
  rttModules,
  rttLessons,
  rttSessions,
  rttReadings,
  terms,
  phases,
  districts,
  zones,
} from "@gml/db/schema";
import { uuidOrNotFound } from "@/lib/ids";
import { listSubjectAssessments } from "@/lib/rtt/assessments";
import { attendanceOf, doneItems, resumeModule } from "@/lib/rtt/progress";
import { rttScope } from "@/lib/rtt/scope";
import { markProgressAction } from "./actions";

/** A one-button form that marks a lesson or reading done, or undoes it. */
function ProgressToggle({ kind, itemId, isDone }: { kind: "lesson" | "reading"; itemId: string; isDone: boolean }) {
  return (
    <form action={markProgressAction} style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="done" value={isDone ? "false" : "true"} />
      {isDone ? <span className="chip chip-lichen">Done</span> : null}
      <button type="submit" className={isDone ? "btn btn-sm btn-ghost" : "btn btn-sm"}>
        {isDone ? "Undo" : kind === "lesson" ? "Mark done" : "Mark read"}
      </button>
    </form>
  );
}

const ATTENDANCE_CHIP: Record<string, string> = {
  present: "chip chip-lichen",
  absent: "chip chip-rust",
  excused: "chip",
};

export const dynamic = "force-dynamic";

export default async function RttSubjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ open?: string }>;
}) {
  // A malformed id is a subject that does not exist, not a Postgres 500.
  const id = uuidOrNotFound((await params).id);
  // ?open=<module sequence>: the module a progress tick came from stays open
  // after the form round-trip (actions.ts redirects here with it).
  const openSeq = Number((await searchParams).open);
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const viewer = { id: session.user.id, role: session.user.role };
  // Only a subject the viewer is shown (lib/rtt/scope.ts): a retired subject
  // stayed reachable here for everyone, because this page never read `active`.
  const scope = await rttScope(db, viewer);
  const [subject] = await db
    .select()
    .from(rttSubjects)
    .where(and(eq(rttSubjects.id, id), scope.subjectWhere))
    .limit(1);
  if (!subject) notFound();
  const [term] = await db.select().from(terms).where(eq(terms.id, subject.termId)).limit(1);
  const [phase] = term ? await db.select().from(phases).where(eq(phases.id, term.phaseId)).limit(1) : [null];
  // Where it is taught, when that is not the whole programme (F42).
  const [taughtIn] = subject.zoneId
    ? await db
        .select({ name: sql<string>`${zones.name} || ', ' || ${districts.name}` })
        .from(zones)
        .innerJoin(districts, eq(districts.id, zones.districtId))
        .where(eq(zones.id, subject.zoneId))
        .limit(1)
    : subject.districtId
      ? await db.select({ name: districts.name }).from(districts).where(eq(districts.id, subject.districtId)).limit(1)
      : [null];

  const modules = await db.select().from(rttModules).where(eq(rttModules.rttSubjectId, id)).orderBy(rttModules.sequence);
  // LESSONS. rtt_lessons existed in the schema and nothing read or wrote it,
  // while the card below told teachers to "click a module to expand its
  // lessons" over static rows. They are now authored at /admin/data/rtt-lessons
  // and listed under their module in a native <details> disclosure, so the
  // expansion works with no client JavaScript.
  const lessons = modules.length
    ? await db
        .select({
          id: rttLessons.id,
          rttModuleId: rttLessons.rttModuleId,
          title: rttLessons.title,
          bodyMd: rttLessons.bodyMd,
        })
        .from(rttLessons)
        .where(
          inArray(
            rttLessons.rttModuleId,
            modules.map((m) => m.id),
          ),
        )
        .orderBy(rttLessons.rttModuleId, rttLessons.sequence)
    : [];
  const lessonsByModule = new Map<string, typeof lessons>();
  for (const l of lessons) {
    const list = lessonsByModule.get(l.rttModuleId) ?? [];
    list.push(l);
    lessonsByModule.set(l.rttModuleId, list);
  }
  // isUpcoming is computed by Postgres, not the app process. Doing it in SQL
  // uses the same clock the scheduled_at timestamps were written against (no
  // app/DB skew), gives every row one consistent "now", and keeps an impure
  // clock read out of the render path entirely.
  const sessions = await db
    .select({
      ...getTableColumns(rttSessions),
      isUpcoming: sql<boolean>`(${rttSessions.scheduledAt} IS NULL OR ${rttSessions.scheduledAt} > now())`,
    })
    .from(rttSessions)
    .where(eq(rttSessions.rttSubjectId, id))
    .orderBy(rttSessions.sequence);
  const readings = await db.select().from(rttReadings).where(eq(rttReadings.rttSubjectId, id)).orderBy(rttReadings.sequence);

  // Where an empty card points an administrator. Modules, lessons and readings
  // had no write path anywhere in the product; they are admin grid tables now,
  // and an empty card that says where to fill it reads as "not loaded yet"
  // rather than "broken".
  const viewerIsAdmin = scope.isAdmin;

  // THIS SUBJECT'S ASSESSMENTS: the active quizzes bound to it. They were
  // looked up by the fixed slugs "mid-unit" and "endline" with no subject
  // predicate, so one programme-wide "mid-unit" quiz ran on every subject and
  // a quiz under any other slug was offered nowhere (lib/rtt/assessments.ts).
  const assessments = await listSubjectAssessments(db, id, session.user.id);

  // THE LEARNER'S OWN PROGRESS (F36): the lessons and readings she has marked
  // done (rtt_progress, written by ./actions.ts) and the attendance taken of
  // her at this subject's sessions. None of it was recorded or shown before.
  const [done, attendance] = await Promise.all([
    doneItems(
      db,
      session.user.id,
      lessons.map((l) => l.id),
      readings.map((r) => r.id),
    ),
    attendanceOf(
      db,
      session.user.id,
      sessions.map((s) => s.id),
    ),
  ]);
  const presentCount = [...attendance.values()].filter((s) => s === "present").length;
  const passedCount = assessments.filter((q) => q.passed).length;

  // "Resume" (spec 119's in-page anchor) goes to the first module with a
  // lesson she has not done. It always went to module 1, whatever she had
  // done. No modules: the modules card, so the button is never dead.
  const resume = resumeModule(modules, lessonsByModule, done.lessons);
  const resumeHref = resume
    ? `/rtt/subject/${id}#module-${resume.sequence}`
    : `/rtt/subject/${id}#modules`;

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <Link href="/rtt" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
          ← All subjects
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 14,
          }}
        >
          <div>
            <div className="label" style={{ marginTop: 8 }}>
              {phase?.label ?? "Phase ?"} · {term?.name ?? "Term ?"}
              {subject.code ? ` · ${subject.code}` : ""}
              {taughtIn ? ` · ${taughtIn.name} only` : ""}
            </div>
            {!subject.active ? (
              // Only an administrator reaches an inactive subject.
              <span className="chip chip-rust" title="Hidden from teachers until re-activated at Admin → RTT Subjects">
                Inactive
              </span>
            ) : null}
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
              {subject.name}
            </h1>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link
              href={resumeHref}
              className="btn btn-primary"
              style={{ textDecoration: "none" }}
            >
              Resume
            </Link>
          </div>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <article id="modules" className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Modules ({modules.length})</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                {/* Only promise the expansion when there is something to
                    expand; this used to say it over rows that could not. */}
                {lessons.length > 0
                  ? "Click a module to expand its lessons."
                  : "The units of this subject, in teaching order."}
              </div>
            </div>
            {modules.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                No modules yet.
                {viewerIsAdmin ? (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    Add them at <Link href="/admin/data/rtt-modules">Admin → RTT Modules</Link>, and
                    their lessons at <Link href="/admin/data/rtt-lessons">Admin → RTT Lessons</Link>.
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                {modules.map((m, i) => {
                  const moduleLessons = lessonsByModule.get(m.id) ?? [];
                  const moduleDone = moduleLessons.filter((l) => done.lessons.has(l.id)).length;
                  const header = (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "36px 1fr auto",
                        gap: 14,
                        padding: 14,
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 6,
                          background: "var(--paper-2)",
                          color: "var(--ink-2)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {i + 1}
                      </div>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{m.title}</div>
                        {m.description ? (
                          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                            {m.description}
                          </div>
                        ) : null}
                      </div>
                      {moduleLessons.length > 0 ? (
                        <span
                          className={moduleDone === moduleLessons.length ? "chip chip-lichen" : "chip"}
                          title="Lessons you have marked done"
                        >
                          {moduleDone}/{moduleLessons.length} {moduleLessons.length === 1 ? "lesson" : "lessons"}
                        </span>
                      ) : (
                        <span />
                      )}
                    </div>
                  );
                  const rowStyle = { borderTop: i ? "1px solid var(--line)" : "none" };
                  // A module with no lessons stays a plain row: a disclosure
                  // that opens onto nothing is the same false promise the old
                  // subtitle made.
                  if (moduleLessons.length === 0) {
                    return (
                      <div key={m.id} id={`module-${m.sequence}`} style={rowStyle}>
                        {header}
                      </div>
                    );
                  }
                  return (
                    <details
                      key={m.id}
                      id={`module-${m.sequence}`}
                      style={rowStyle}
                      // Where she is (the Resume module), or where she just
                      // ticked a lesson, opens without a tap.
                      open={m.id === resume?.id || m.sequence === openSeq}
                    >
                      <summary style={{ cursor: "pointer", listStyle: "none" }}>{header}</summary>
                      <ol style={{ margin: 0, padding: "0 14px 14px 64px", display: "grid", gap: 10 }}>
                        {moduleLessons.map((l) => (
                          <li key={l.id} style={{ fontSize: 13 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                              <div style={{ fontWeight: 500 }}>{l.title}</div>
                              <ProgressToggle kind="lesson" itemId={l.id} isDone={done.lessons.has(l.id)} />
                            </div>
                            {l.bodyMd ? (
                              // Plain text with the author's line breaks kept.
                              // Never rendered as markup: this is typed into an
                              // admin grid and shown to every teacher.
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "var(--ink-2)",
                                  marginTop: 4,
                                  whiteSpace: "pre-wrap",
                                  lineHeight: 1.5,
                                }}
                              >
                                {l.bodyMd}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  );
                })}
              </div>
            )}
          </article>

          <article className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Cohort sessions ({sessions.length})</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                Live or hybrid touchpoints with mentor &amp; peers
              </div>
            </div>
            {sessions.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                No sessions scheduled.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Session</th>
                    <th>Type</th>
                    <th>Duration</th>
                    <th title="Your attendance, once it has been taken">You</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => {
                    // Spec 119: each rtt-session row links to /repo/session/${id}
                    // (the classroom-session detail page). For sessions that are
                    // still upcoming (scheduledAt in the future or null) the
                    // action column shows "Join"; for past sessions "Watch".
                    // Both render as <Link href=…> so they have real handlers.
                    // NO LINK. `s.id` is an rtt_sessions id, and
                    // /repo/session/[id] looks up the CLASSROOM sessions table
                    // -- a different table entirely -- so every one of these
                    // rows 404'd. rtt_sessions has no detail page; the calendar
                    // at /rtt/online/synchronous is where these are listed.
                    const isUpcoming = s.isUpcoming;
                    return (
                      <tr key={s.id}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {s.scheduledAt ? (
                            new Date(s.scheduledAt).toLocaleString("en-IN", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          ) : (
                            <span className="empty-dash">unscheduled</span>
                          )}
                        </td>
                        <td>
                          {s.title}
                        </td>
                        <td>
                          {s.type ? (
                            <span className="chip">{s.type}</span>
                          ) : (
                            <em className="dash">—</em>
                          )}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {s.durationMin ? `${s.durationMin} min` : <em className="dash">—</em>}
                        </td>
                        <td>
                          {attendance.has(s.id) ? (
                            <span className={ATTENDANCE_CHIP[attendance.get(s.id)!] ?? "chip"}>
                              {attendance.get(s.id)!.charAt(0).toUpperCase() + attendance.get(s.id)!.slice(1)}
                            </span>
                          ) : (
                            <em className="dash">—</em>
                          )}
                        </td>
                        <td>
                          {s.linkOrRecording ? (
                            <a
                              href={s.linkOrRecording}
                              className="btn btn-sm"
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ textDecoration: "none" }}
                            >
                              {isUpcoming ? "Join" : "Watch"}
                            </a>
                          ) : (
                            <span className="chip" title="No meeting link or recording recorded for this session">
                              {isUpcoming ? "No link yet" : "No recording"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </article>
        </div>

        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <article className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Your progress</div>
            </div>
            <dl
              style={{
                margin: 0,
                padding: 14,
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: "6px 12px",
                fontSize: 13,
              }}
            >
              <dt>Lessons</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {done.lessons.size} of {lessons.length}
              </dd>
              <dt>Readings</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {done.readings.size} of {readings.length}
              </dd>
              <dt>Assessments passed</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {passedCount} of {assessments.length}
              </dd>
              <dt>Sessions attended</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {attendance.size === 0 ? "not taken yet" : `${presentCount} of ${attendance.size}`}
              </dd>
            </dl>
            <div style={{ padding: "0 14px 12px", fontSize: 11 }}>
              <Link href="/rtt/progress">All my RTT progress →</Link>
            </div>
          </article>

          <article id="readings" className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Required readings ({readings.length})</div>
            </div>
            {readings.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                No readings linked.
                {viewerIsAdmin ? (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    Add them at <Link href="/admin/data/rtt-readings">Admin → RTT Readings</Link>.
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                {readings.map((r, i) => (
                  <div
                    key={r.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "30px 1fr auto",
                      gap: 10,
                      padding: 12,
                      alignItems: "center",
                      borderTop: i ? "1px solid var(--line)" : "none",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--rust)",
                        border: "1px solid var(--line)",
                        borderRadius: 4,
                        padding: "2px 4px",
                        textAlign: "center",
                      }}
                    >
                      PDF
                    </span>
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>
                        {r.externalUrl ? (
                          <a
                            href={r.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "var(--ink)" }}
                          >
                            {r.title}
                          </a>
                        ) : (
                          r.title
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                        {r.externalUrl ? "External link" : "Reading"}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <ProgressToggle kind="reading" itemId={r.id} isDone={done.readings.has(r.id)} />
                      </div>
                    </div>
                    {r.externalUrl ? (
                      <a
                        href={r.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-sm"
                      >
                        Open
                      </a>
                    ) : (
                      // NO "View" BUTTON for a fileKey-only reading. It sent an
                      // rtt_readings id to /repo/resource/[id]/view, which looks
                      // the id up in `resources` -- a different table -- so it
                      // 404'd by construction. The branch could not be reached
                      // honestly anyway: file_key is a MinIO object key and
                      // MinIO is out of the stack, so nothing can set or serve
                      // it. Readings are authored at /admin/data/rtt-readings
                      // as external links, which render "Open" above.
                      <span className="chip">—</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </article>

          {/* Assessment card: one row per active quiz bound to this subject,
              with the learner's own best result. Release is the quiz's
              `active` flag at /admin/quizzes; there is no sequencing rule (an
              endline locked until a mid-unit is passed) because nothing in the
              programme defines one, so none is pretended here. */}
          <article className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Assessment</div>
            </div>
            {assessments.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                No assessments published yet.
                {viewerIsAdmin ? (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    Create and activate one for this subject at <Link href="/admin/quizzes">Admin → Quizzes</Link>.
                  </div>
                ) : null}
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: "0 14px", fontSize: 13 }}>
                {assessments.map((q, i) => (
                  <li
                    key={q.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 0",
                      borderTop: i ? "1px solid var(--line)" : "none",
                    }}
                  >
                    <div>
                      <div>{q.title}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                        {q.attempts === 0
                          ? `Pass mark ${q.passThreshold}%`
                          : `Best ${q.bestScore}% · ${q.attempts} ${q.attempts === 1 ? "attempt" : "attempts"}`}
                        {q.maxAttempts !== null ? ` · ${q.maxAttempts} allowed` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {q.passed ? <span className="chip chip-lichen">Passed</span> : null}
                      <Link
                        href={q.href}
                        className={q.attempts === 0 ? "btn btn-sm btn-primary" : "btn btn-sm"}
                        style={{ textDecoration: "none" }}
                      >
                        {q.spent ? "Results" : q.attempts === 0 ? "Start" : "Retake"}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}
