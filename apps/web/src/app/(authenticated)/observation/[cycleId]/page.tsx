// /observation/[cycleId] — cycle drill-in with 5-step flow diagram.
// Status: nominated → pre_submitted → observed → post_submitted → complete

import { notFound } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, teachers, subjects, observationForms, observationEvidence } from "@gml/db/schema";

export const dynamic = "force-dynamic";

const CYCLE_STAGES = [
  { id: "nominated", label: "Nominated" },
  { id: "pre_submitted", label: "Pre-form" },
  { id: "observed", label: "Observed" },
  { id: "post_submitted", label: "Post-form" },
  { id: "complete", label: "Complete" },
];

export default async function CycleDetailPage({ params }: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await params;

  const [cycle] = await db
    .select()
    .from(observationCycles)
    .where(eq(observationCycles.id, cycleId))
    .limit(1);
  if (!cycle) notFound();

  const [teacher] = await db.select().from(teachers).where(eq(teachers.id, cycle.teacherId)).limit(1);
  const [subject] = cycle.subjectId
    ? await db.select().from(subjects).where(eq(subjects.id, cycle.subjectId)).limit(1)
    : [null];
  const forms = await db.select().from(observationForms).where(eq(observationForms.cycleId, cycleId));
  const evidence = await db.select().from(observationEvidence).where(eq(observationEvidence.cycleId, cycleId));

  const currentStageIdx = CYCLE_STAGES.findIndex((s) => s.id === cycle.status);

  return (
    <div>
      <header style={{ marginBottom: 20, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div>
          <Link href="/observation" style={{ fontSize: 12, color: "var(--ink-3)" }}>
            ← Cycles
          </Link>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginTop: 8 }}>
            Observation cycle · {cycle.kind}
          </div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>
            {teacher?.fullName ?? "—"}
            {teacher?.hindiName ? (
              <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 10, fontSize: 18 }}>
                {teacher.hindiName}
              </span>
            ) : null}
          </h1>
          <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
            <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{cycle.code}</code>
            {subject ? ` · ${subject.name}` : null}
            {cycle.topic ? ` · ${cycle.topic}` : null}
            {cycle.scheduledAt
              ? ` · ${new Date(cycle.scheduledAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`
              : null}
          </div>
        </div>
      </header>

      {/* Cycle Flow Diagram */}
      <section style={{ marginBottom: 24 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${CYCLE_STAGES.length}, 1fr)`,
            gap: 8,
            background: "var(--card-hi)",
            padding: 14,
            border: "1px solid var(--line)",
            borderRadius: "var(--r-3)",
          }}
        >
          {CYCLE_STAGES.map((stage, i) => {
            const isPast = i < currentStageIdx;
            const isCurrent = i === currentStageIdx;
            return (
              <div
                key={stage.id}
                style={{
                  textAlign: "center",
                  padding: 10,
                  borderRadius: "var(--r-2)",
                  background: isCurrent
                    ? "var(--ink)"
                    : isPast
                      ? "var(--lichen-soft)"
                      : "var(--paper-2)",
                  color: isCurrent ? "var(--paper)" : isPast ? "var(--ink)" : "var(--ink-3)",
                  position: "relative",
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {i + 1}
                </div>
                <div style={{ fontWeight: 600, fontSize: 12 }}>{stage.label}</div>
                {isPast ? <span style={{ position: "absolute", right: 8, top: 8, fontSize: 10 }}>✓</span> : null}
              </div>
            );
          })}
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <article style={{ background: "var(--card-hi)", border: "1px solid var(--line)", borderRadius: "var(--r-3)", padding: 16 }}>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, marginBottom: 12 }}>Forms ({forms.length})</h2>
          {forms.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No forms submitted yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {forms.map((f) => (
                <li
                  key={f.id}
                  style={{
                    padding: 10,
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-2)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 10 }}>
                    {f.kind}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                    Submitted {new Date(f.submittedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article style={{ background: "var(--card-hi)", border: "1px solid var(--line)", borderRadius: "var(--r-3)", padding: 16 }}>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, marginBottom: 12 }}>Evidence ({evidence.length})</h2>
          {evidence.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No video evidence linked yet. Teacher uploads via WhatsApp with caption <code>OBS-{cycle.code.replace(/^OBS-/, "")}</code>.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {evidence.map((e) => (
                <li
                  key={e.id}
                  style={{
                    padding: 10,
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-2)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 500 }}>
                    {e.videoSubmissionId ? (
                      <Link href={`/videos/${e.videoSubmissionId}`} style={{ color: "var(--indigo)" }}>
                        Open video →
                      </Link>
                    ) : (
                      <span style={{ color: "var(--ink-3)" }}>(no video yet)</span>
                    )}
                  </div>
                  {e.caption ? <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{e.caption}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      {cycle.remark ? (
        <section style={{ marginTop: 18, padding: 16, background: "var(--card-hi)", border: "1px solid var(--line)", borderRadius: "var(--r-3)" }}>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, marginBottom: 8 }}>Remark</h2>
          <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{cycle.remark}</p>
        </section>
      ) : null}
    </div>
  );
}
