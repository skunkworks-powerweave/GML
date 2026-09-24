// /rtt/subject/[id] — RTT subject drill-in: modules + sessions + readings.

import { notFound } from "next/navigation";
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
  quizzes,
} from "@gml/db/schema";

export const dynamic = "force-dynamic";

export default async function RttSubjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [subject] = await db.select().from(rttSubjects).where(eq(rttSubjects.id, id)).limit(1);
  if (!subject) notFound();
  const [term] = await db.select().from(terms).where(eq(terms.id, subject.termId)).limit(1);
  const [phase] = term ? await db.select().from(phases).where(eq(phases.id, term.phaseId)).limit(1) : [null];

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

  // DO THE ASSESSMENT QUIZZES EXIST?
  //
  // The two links below were hardcoded to /quizzes/mid-unit and
  // /quizzes/endline. The runner calls notFound() for a slug with no active
  // quiz, so on a programme that has not created them -- which is every new
  // deployment, since nothing seeds quizzes -- "Start" was a 404 on every
  // subject page in the product. A missing quiz is a normal state, not an
  // error, so it now reads as "not published yet" instead of pretending to be
  // a working link.
  const assessmentSlugs = ["mid-unit", "endline"];
  const publishedQuizzes = await db
    .select({ slug: quizzes.slug })
    .from(quizzes)
    .where(and(inArray(quizzes.slug, assessmentSlugs), eq(quizzes.active, true)));
  const hasQuiz = new Set(publishedQuizzes.map((q) => q.slug));

  // Where an empty card points an administrator. Modules, lessons and readings
  // had no write path anywhere in the product; they are admin grid tables now,
  // and an empty card that says where to fill it reads as "not loaded yet"
  // rather than "broken".
  const session = await auth();
  const viewerIsAdmin =
    session?.user?.role === "programme_admin" || session?.user?.role === "super_admin";

  // Spec 119 — wire the JSX-prototype "Resume" CTA to the first module by
  // sequence (anchor jump on this same page). When no modules exist, the
  // anchor falls back to the modules card heading so the user still lands
  // somewhere sensible instead of a dead button.
  const firstModule = modules[0];
  const resumeHref = firstModule
    ? `/rtt/subject/${id}#module-${firstModule.sequence}`
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
            </div>
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
                        <span className="chip">
                          {moduleLessons.length} {moduleLessons.length === 1 ? "lesson" : "lessons"}
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
                    <details key={m.id} id={`module-${m.sequence}`} style={rowStyle}>
                      <summary style={{ cursor: "pointer", listStyle: "none" }}>{header}</summary>
                      <ol style={{ margin: 0, padding: "0 14px 14px 64px", display: "grid", gap: 10 }}>
                        {moduleLessons.map((l) => (
                          <li key={l.id} style={{ fontSize: 13 }}>
                            <div style={{ fontWeight: 500 }}>{l.title}</div>
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

          {/* Spec 119: Assessment card — Start/Locked CTAs port the JSX
              prototype (rtt.jsx lines 236-251). Mid-unit links to
              /quizzes/mid-unit?subjectId=... only when that quiz is published;
              endline is an inert "Locked" chip (see the note on it below). */}
          <article className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Assessment</div>
            </div>
            <div style={{ padding: 14, fontSize: 13 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 0",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <span>Mid-unit check</span>
                {hasQuiz.has("mid-unit") ? (
                  <Link
                    href={`/quizzes/mid-unit?subjectId=${id}`}
                    className="btn btn-sm btn-primary"
                    style={{ textDecoration: "none" }}
                  >
                    Start
                  </Link>
                ) : (
                  <span className="chip" title="No active quiz with the address mid-unit">
                    Not published yet
                  </span>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingTop: 12,
                }}
              >
                <span style={{ color: "var(--ink-3)" }}>Endline assessment</span>
                {/* NOT A LINK. This was a <Link> to the endline quiz runner with
                    only aria-disabled="true", which is a hint to assistive
                    technology and does not stop navigation; `.chip` sets no
                    pointer-events guard. It looked inert and navigated, and the
                    runner 404s a slug with no active quiz. A span says what
                    aria-disabled was trying to, like the mid-unit fallback.
                    Whether endline should open once published is a programme
                    decision (a sequencing rule nothing implements yet), so the
                    fetched "endline" slug above stays deliberately unread. */}
                <span className="chip" title="Unlocks after the mid-unit check">
                  Locked
                </span>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
