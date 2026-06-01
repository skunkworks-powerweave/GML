// /observation — Classroom Observation cycles list.
// Filter by kind (baseline | developmental | evaluative) and status.

import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, teachers, subjects } from "@gml/db/schema";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  nominated: "var(--ink-3)",
  pre_submitted: "var(--saffron)",
  observed: "var(--indigo)",
  post_submitted: "var(--saffron)",
  complete: "var(--lichen)",
};

const KIND_COLOR: Record<string, { bg: string; ink: string }> = {
  baseline: { bg: "var(--paper-2)", ink: "var(--ink-2)" },
  developmental: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  evaluative: { bg: "var(--indigo-soft)", ink: "var(--indigo)" },
};

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
    .leftJoin(teachers, eqCol(observationCycles.teacherId, teachers.id))
    .leftJoin(subjects, eqCol(observationCycles.subjectId, subjects.id))
    .orderBy(desc(observationCycles.scheduledAt))
    .limit(80);

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          Classroom Observation
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Observation cycles
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          Pre-form → observation → post-form. Three kinds: baseline, developmental, evaluative.
        </p>
      </header>

      <section
        style={{
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          overflow: "hidden",
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
            No observation cycles yet. They appear once observers nominate teachers.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {rows.map((c, i) => (
              <li
                key={c.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto auto",
                  gap: 14,
                  alignItems: "center",
                  padding: "14px 16px",
                  borderTop: i ? "1px solid var(--line)" : "none",
                }}
              >
                <code
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--ink-3)",
                    minWidth: 84,
                  }}
                >
                  {c.code}
                </code>
                <div>
                  <div style={{ fontWeight: 500 }}>
                    {c.teacherName ?? "—"}
                    {c.teacherHindi ? (
                      <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 8, fontSize: 12 }}>
                        {c.teacherHindi}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    {c.subjectName ?? c.topic ?? "no subject"} ·{" "}
                    {c.scheduledAt
                      ? new Date(c.scheduledAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                      : "unscheduled"}
                    {c.videoMin ? ` · ${c.videoMin} min` : ""}
                  </div>
                </div>
                <Chip kind={KIND_COLOR[c.kind] ?? KIND_COLOR.baseline}>{c.kind}</Chip>
                <span style={{ fontSize: 11, color: STATUS_COLOR[c.status] ?? "var(--ink-3)", fontFamily: "var(--mono)" }}>
                  {c.status.replace("_", " ")}
                </span>
                <Link
                  href={`/observation/${c.id}`}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    background: "var(--ink)",
                    color: "var(--paper)",
                    borderRadius: "var(--r-2)",
                    textDecoration: "none",
                  }}
                >
                  Open →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Chip({ kind, children }: { kind: { bg: string; ink: string }; children: React.ReactNode }) {
  return (
    <span
      style={{
        padding: "2px 8px",
        background: kind.bg,
        color: kind.ink,
        borderRadius: 999,
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}

// Tiny local FK join helper since drizzle's eq+leftJoin imports get long
function eqCol<T>(a: T, b: T) {
  // @ts-expect-error drizzle's eq is the right type here; this wrapper exists only to shorten imports
  return require("drizzle-orm").eq(a, b);
}
