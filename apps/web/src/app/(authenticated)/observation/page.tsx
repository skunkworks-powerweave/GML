// /observation — Classroom Observation cycles list.
// Filter by kind (baseline | developmental | evaluative) and status.

import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, teachers, subjects } from "@gml/db/schema";

export const dynamic = "force-dynamic";

const KIND_CHIP: Record<string, string> = {
  baseline: "",
  developmental: "chip-indigo",
  evaluative: "chip-saffron",
};

const STATUS_LABEL: Record<string, string> = {
  nominated: "Nominated",
  pre_submitted: "Pre submitted",
  observed: "Observed",
  post_submitted: "Post submitted",
  complete: "Complete",
};

const CYCLE_STAGES = ["nominated", "pre_submitted", "observed", "post_submitted", "complete"];

export default async function ObservationListPage() {
  const rows = await db
    .select({
      id: observationCycles.id,
      code: observationCycles.code,
      kind: observationCycles.kind,
      status: observationCycles.status,
      scheduledAt: observationCycles.scheduledAt,
      topic: observationCycles.topic,
      videoMin: observationCycles.videoMin,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
      subjectName: subjects.name,
    })
    .from(observationCycles)
    .leftJoin(teachers, eq(observationCycles.teacherId, teachers.id))
    .leftJoin(subjects, eq(observationCycles.subjectId, subjects.id))
    .orderBy(desc(observationCycles.scheduledAt))
    .limit(80);

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <div className="label">Classroom observation</div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Observation cycles</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 6 }}>
              A cycle has three steps: <b>Pre-form</b> from teacher → <b>Observation</b> (live or video) → <b>Post-debrief</b> with mentor.
              Every step is time-stamped and signed.
            </p>
          </div>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <div className="card">
          {rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
              No observation cycles yet. They appear once observers nominate teachers.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Teacher</th>
                  <th>Subject / Topic</th>
                  <th>Kind</th>
                  <th>Stage</th>
                  <th>Date</th>
                  <th>Video</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="mono" style={{ fontSize: 11 }}>{c.code}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{c.teacherName ?? "—"}</div>
                      {c.teacherHindi ? (
                        <div className="deva" style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--deva)" }}>
                          {c.teacherHindi}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div>{c.subjectName ?? "—"}</div>
                      {c.topic ? (
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{c.topic}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`chip ${KIND_CHIP[c.kind] ?? ""}`}>{c.kind}</span>
                    </td>
                    <td>
                      <CycleStage status={c.status} />
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {c.scheduledAt
                        ? new Date(c.scheduledAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                        : <span style={{ color: "var(--ink-4)" }}>—</span>}
                    </td>
                    <td>
                      {c.videoMin ? (
                        <span style={{ fontSize: 12 }}>{c.videoMin}m</span>
                      ) : (
                        <span style={{ color: "var(--ink-4)" }}>—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        href={`/observation/${c.id}`}
                        style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
                      >
                        ›
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function CycleStage({ status }: { status: string }) {
  const idx = CYCLE_STAGES.indexOf(status);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      {CYCLE_STAGES.map((s, i) => (
        <div
          key={s}
          style={{
            width: 22,
            height: 5,
            borderRadius: 2,
            background:
              i <= idx
                ? i === CYCLE_STAGES.length - 1 && i <= idx
                  ? "var(--lichen)"
                  : "var(--ink)"
                : "var(--paper-3)",
          }}
        />
      ))}
      <span style={{ marginLeft: 6, fontSize: 11, color: "var(--ink-3)" }}>
        {STATUS_LABEL[status] ?? status.replace("_", " ")}
      </span>
    </div>
  );
}
