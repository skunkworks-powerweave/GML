// /rtt — phase index + subjects matrix.

import Link from "next/link";
import { db } from "@gml/db";
import { phases, terms, rttSubjects } from "@gml/db/schema";

export const dynamic = "force-dynamic";

export default async function RttIndexPage() {
  const phaseRows = await db.select().from(phases).orderBy(phases.sequence);
  const termRows = await db.select().from(terms);
  const subjectRows = await db.select().from(rttSubjects);

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          Refresher Teacher Training
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>RTT phases &amp; subjects</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          {phaseRows.length} phases · {termRows.length} terms · {subjectRows.length} subjects across Leh + Kargil.
        </p>
      </header>

      {phaseRows.length === 0 ? (
        <p style={{ color: "var(--ink-3)" }}>No phases seeded yet. Run the spec 086 seed script.</p>
      ) : (
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {phaseRows.map((p) => {
            const phaseTerms = termRows.filter((t) => t.phaseId === p.id).sort((a, b) => a.sequence - b.sequence);
            return (
              <article
                key={p.id}
                style={{
                  background: "var(--card-hi)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-3)",
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <header>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
                    Phase
                  </div>
                  <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, marginTop: 2 }}>{p.label}</h2>
                  {p.startDate ? (
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                      {new Date(p.startDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      {p.endDate ? ` → ${new Date(p.endDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                    </div>
                  ) : null}
                </header>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {phaseTerms.map((t) => {
                    const termSubjects = subjectRows.filter((s) => s.termId === t.id);
                    return (
                      <li key={t.id} style={{ fontSize: 12 }}>
                        <div style={{ fontWeight: 500 }}>{t.name}</div>
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          {termSubjects.length === 0 ? (
                            "no subjects yet"
                          ) : (
                            termSubjects.map((s) => (
                              <Link
                                key={s.id}
                                href={`/rtt/subject/${s.id}`}
                                style={{ color: "var(--indigo)", marginRight: 8 }}
                              >
                                {s.name}
                              </Link>
                            ))
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
