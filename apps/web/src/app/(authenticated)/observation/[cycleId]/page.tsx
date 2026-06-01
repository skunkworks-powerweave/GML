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

  const kindChipClass =
    cycle.kind === "developmental"
      ? "chip chip-saffron"
      : cycle.kind === "evaluative"
        ? "chip chip-indigo"
        : "chip";
  const statusChipClass =
    cycle.status === "complete"
      ? "chip chip-lichen"
      : cycle.status === "post_submitted" || cycle.status === "pre_submitted"
        ? "chip chip-saffron"
        : cycle.status === "observed"
          ? "chip chip-indigo"
          : "chip";

  return (
    <div>
      <header style={{ marginBottom: 20, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <Link href="/observation" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
            ← All cycles
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{cycle.code}</span>
            <span className={kindChipClass}>{cycle.kind}</span>
            <span className={statusChipClass}>{cycle.status.replace(/_/g, " ")}</span>
          </div>
          <h1 className="serif" style={{ fontSize: 26, marginTop: 6 }}>
            {teacher?.fullName ?? "—"}
            {teacher?.hindiName ? (
              <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 10, fontSize: 18 }}>
                {teacher.hindiName}
              </span>
            ) : null}
          </h1>
          <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
            {subject ? `${subject.name}` : null}
            {subject && cycle.topic ? " · " : null}
            {cycle.topic ? `${cycle.topic}` : null}
            {(subject || cycle.topic) && cycle.scheduledAt ? " · " : null}
            {cycle.scheduledAt
              ? new Date(cycle.scheduledAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
              : null}
          </p>
        </div>
      </header>

      {/* Cycle Flow Diagram */}
      <section style={{ marginBottom: 24 }}>
        <div className="card card-hi" style={{ padding: 14 }}>
          <div className="stepper">
            {CYCLE_STAGES.map((stage, i) => {
              const isPast = i < currentStageIdx;
              const isCurrent = i === currentStageIdx;
              const stepClass = `step${isPast ? " done" : ""}${isCurrent ? " active" : ""}`;
              return (
                <span key={stage.id} style={{ display: "contents" }}>
                  <div className={stepClass}>
                    <span className="num">{isPast ? "✓" : i + 1}</span>
                    <span>{stage.label}</span>
                  </div>
                  {i < CYCLE_STAGES.length - 1 ? <span className="sep">·····</span> : null}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <article className="card card-hi" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>Forms · {forms.length}</div>
          <h2 className="serif" style={{ fontSize: 16, marginBottom: 12 }}>Pre &amp; post-observation</h2>
          {forms.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No forms submitted yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {forms.map((f) => (
                <li
                  key={f.id}
                  className="card"
                  style={{ padding: 10, fontSize: 12, boxShadow: "none" }}
                >
                  <span className="chip chip-ink" style={{ fontSize: 10 }}>{f.kind}</span>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
                    Submitted <span className="mono">{new Date(f.submittedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="card card-hi" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>Evidence · {evidence.length}</div>
          <h2 className="serif" style={{ fontSize: 16, marginBottom: 12 }}>Lesson video</h2>
          {evidence.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
              No video evidence linked yet. Teacher uploads via WhatsApp with caption{" "}
              <span className="kbd">OBS-{cycle.code.replace(/^OBS-/, "")}</span>.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {evidence.map((e) => (
                <li
                  key={e.id}
                  className="card"
                  style={{ padding: 10, fontSize: 12, boxShadow: "none" }}
                >
                  <div style={{ fontWeight: 500 }}>
                    {e.videoSubmissionId ? (
                      <Link href={`/videos/${e.videoSubmissionId}`}>
                        Open video →
                      </Link>
                    ) : (
                      <span style={{ color: "var(--ink-3)" }}>(no video yet)</span>
                    )}
                  </div>
                  {e.caption ? <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{e.caption}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      {cycle.remark ? (
        <section className="card card-hi" style={{ marginTop: 18, padding: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>Remark</div>
          <h2 className="serif" style={{ fontSize: 16, marginBottom: 8 }}>Mentor note</h2>
          <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{cycle.remark}</p>
        </section>
      ) : null}
    </div>
  );
}
