// /rtt/subject/[id] — RTT subject drill-in: modules + sessions + readings.

import { notFound } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { rttSubjects, rttModules, rttSessions, rttReadings, terms, phases } from "@gml/db/schema";

export const dynamic = "force-dynamic";

export default async function RttSubjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [subject] = await db.select().from(rttSubjects).where(eq(rttSubjects.id, id)).limit(1);
  if (!subject) notFound();
  const [term] = await db.select().from(terms).where(eq(terms.id, subject.termId)).limit(1);
  const [phase] = term ? await db.select().from(phases).where(eq(phases.id, term.phaseId)).limit(1) : [null];

  const modules = await db.select().from(rttModules).where(eq(rttModules.rttSubjectId, id)).orderBy(rttModules.sequence);
  const sessions = await db.select().from(rttSessions).where(eq(rttSessions.rttSubjectId, id)).orderBy(rttSessions.sequence);
  const readings = await db.select().from(rttReadings).where(eq(rttReadings.rttSubjectId, id)).orderBy(rttReadings.sequence);

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
                Click a module to expand its lessons.
              </div>
            </div>
            {modules.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                No modules yet.
              </div>
            ) : (
              <div>
                {modules.map((m, i) => (
                  <div
                    key={m.id}
                    id={`module-${m.sequence}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "36px 1fr",
                      gap: 14,
                      padding: 14,
                      alignItems: "center",
                      borderTop: i ? "1px solid var(--line)" : "none",
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
                  </div>
                ))}
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
                    const sessionHref = `/repo/session/${s.id}`;
                    const isUpcoming =
                      !s.scheduledAt || new Date(s.scheduledAt).getTime() > Date.now();
                    return (
                      <tr key={s.id}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          <Link
                            href={sessionHref}
                            style={{ color: "var(--ink)", textDecoration: "none" }}
                          >
                            {s.scheduledAt
                              ? new Date(s.scheduledAt).toLocaleString("en-IN", {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                })
                              : <span className="empty-dash">unscheduled</span>}
                          </Link>
                        </td>
                        <td>
                          <Link
                            href={sessionHref}
                            style={{ color: "var(--ink)", textDecoration: "none" }}
                          >
                            {s.title}
                          </Link>
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
                          <Link
                            href={sessionHref}
                            className="btn btn-sm"
                            style={{ textDecoration: "none" }}
                          >
                            {isUpcoming ? "Join" : "Watch"}
                          </Link>
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
                    ) : r.fileKey ? (
                      // Spec 119: PDF readings (no externalUrl) route through
                      // the spec 087 in-browser viewer. The viewer route lives
                      // under /repo/resource/[id]/view; it 404s if the reading
                      // id doesn't correspond to a resources row (which is
                      // expected until a future spec links rtt_readings to
                      // resources). Until then this preserves the JSX-prototype
                      // affordance instead of leaving a dead button.
                      <Link
                        href={`/repo/resource/${r.id}/view`}
                        className="btn btn-sm"
                        style={{ textDecoration: "none" }}
                      >
                        View
                      </Link>
                    ) : (
                      <span className="chip">—</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </article>

          {/* Spec 119: Assessment card — Start/Locked CTAs port the JSX
              prototype (rtt.jsx lines 236-251). Both link to /quizzes/<slug>
              with subjectId in the querystring. The /quizzes/* route ships
              in Run 10's quiz-full-stack spec; until then these links
              intentionally 404. Rendering them now means we don't have to
              re-touch this file when the route lands. */}
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
                <Link
                  href={`/quizzes/mid-unit?subjectId=${id}`}
                  className="btn btn-sm btn-primary"
                  style={{ textDecoration: "none" }}
                >
                  Start
                </Link>
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
                <Link
                  href={`/quizzes/endline?subjectId=${id}`}
                  className="chip"
                  aria-disabled="true"
                  style={{ textDecoration: "none" }}
                >
                  Locked
                </Link>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
