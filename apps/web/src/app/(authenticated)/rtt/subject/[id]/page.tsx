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

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <Link href="/rtt" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
          ← All subjects
        </Link>
        <div className="label" style={{ marginTop: 8 }}>
          {phase?.label ?? "Phase ?"} · {term?.name ?? "Term ?"}
          {subject.code ? ` · ${subject.code}` : ""}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          {subject.name}
        </h1>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <article className="card card-hi">
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
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.scheduledAt
                          ? new Date(s.scheduledAt).toLocaleString("en-IN", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          : <span className="empty-dash">unscheduled</span>}
                      </td>
                      <td>{s.title}</td>
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
                    </tr>
                  ))}
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
                    ) : (
                      <span className="chip">—</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}
