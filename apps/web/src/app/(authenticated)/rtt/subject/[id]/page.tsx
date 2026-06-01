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

  const modules = await db.select().from(rttModules).where(eq(rttModules.subjectId, id)).orderBy(rttModules.sequence);
  const sessions = await db.select().from(rttSessions).where(eq(rttSessions.subjectId, id)).orderBy(rttSessions.sequence);
  const readings = await db.select().from(rttReadings).where(eq(rttReadings.rttSubjectId, id)).orderBy(rttReadings.sequence);

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <Link href="/rtt" style={{ fontSize: 12, color: "var(--ink-3)" }}>← RTT</Link>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginTop: 8 }}>
          {phase?.label ?? "Phase ?"} · {term?.name ?? "Term ?"}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          {subject.name}
          {subject.code ? (
            <code style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--ink-3)", marginLeft: 10 }}>{subject.code}</code>
          ) : null}
        </h1>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18 }}>
        <article style={{ background: "var(--card-hi)", border: "1px solid var(--line)", borderRadius: "var(--r-3)", padding: 16 }}>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, marginBottom: 12 }}>Modules ({modules.length})</h2>
          {modules.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No modules yet.</p>
          ) : (
            <ol style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 10 }}>
              {modules.map((m) => (
                <li key={m.id} style={{ fontSize: 13 }}>
                  <div style={{ fontWeight: 500 }}>{m.title}</div>
                  {m.description ? <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{m.description}</div> : null}
                </li>
              ))}
            </ol>
          )}
        </article>

        <article style={{ background: "var(--card-hi)", border: "1px solid var(--line)", borderRadius: "var(--r-3)", padding: 16 }}>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, marginBottom: 12 }}>Sessions ({sessions.length})</h2>
          {sessions.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No sessions scheduled.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {sessions.map((s) => (
                <li key={s.id} style={{ fontSize: 12, padding: 8, border: "1px solid var(--line)", borderRadius: "var(--r-2)" }}>
                  <div style={{ fontWeight: 500 }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                    {s.scheduledAt
                      ? new Date(s.scheduledAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
                      : "unscheduled"}
                    {s.type ? ` · ${s.type}` : ""}
                    {s.durationMin ? ` · ${s.durationMin} min` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section style={{ marginTop: 18, background: "var(--card-hi)", border: "1px solid var(--line)", borderRadius: "var(--r-3)", padding: 16 }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, marginBottom: 12 }}>Readings ({readings.length})</h2>
        {readings.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No readings linked.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {readings.map((r) => (
              <li key={r.id} style={{ fontSize: 13 }}>
                {r.externalUrl ? (
                  <a href={r.externalUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--indigo)" }}>
                    {r.title}
                  </a>
                ) : (
                  r.title
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
