// /admin/quizzes/[id] — JSON editor for a single quiz (metadata + questions).
// Server component (role gate + initial fetch); the editor is a 'use client'
// child that posts back through the `saveQuizSchema` server action defined in
// ./actions.ts. Mirrors the spec 073 form-schema editor pattern.

import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { quizzes, quizQuestions } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { QuizSchemaEditor } from "./parts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function AdminQuizDetailPage({ params }: Props) {
  await requireRole(["programme_admin", "super_admin"]);
  const { id } = await params;

  const [row] = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.id, id))
    .limit(1);
  if (!row) notFound();

  const qs = await db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, row.id))
    .orderBy(asc(quizQuestions.sequence));

  // Spec 159 — Workflow Run 15 audit-closure MISS: time_limit_seconds is
  // now part of the editable JSON. The export shape carries it (NULL =
  // untimed) and the schema reference aside calls out the valid range so
  // the editor knows what numbers are accepted. The saveQuizSchema
  // server action validates the same range before writing.
  const exportShape = {
    title: row.title,
    passThreshold: row.passThreshold,
    timeLimitSeconds: row.timeLimitSeconds,
    active: row.active,
    questions: qs.map((q) => ({
      prompt: q.prompt,
      options: q.options,
      correctIndex: q.correctIndex,
      explanation: q.explanation ?? undefined,
    })),
  };
  const pretty = JSON.stringify(exportShape, null, 2);

  return (
    <main style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 28px" }}>
      <header style={{ marginBottom: 18 }}>
        <Link
          href="/admin/quizzes"
          style={{
            fontSize: 12,
            color: "var(--ink-3)",
            textDecoration: "none",
            marginBottom: 6,
            display: "inline-block",
          }}
        >
          ← Quizzes registry
        </Link>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          Quiz · {row.slug}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginTop: 4,
          }}
        >
          <div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>
              {row.title}
            </h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 6 }}>
              Edit the JSON below. <strong>Save</strong> validates the payload and
              replaces all questions for this quiz in a single transaction. The
              change is recorded in the audit log.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--ink-3)",
              }}
            >
              Pass threshold
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 22,
                color: "var(--ink)",
                marginTop: 2,
              }}
            >
              {row.passThreshold}%
            </div>
            {/* Spec 159 — time-limit summary. Renders "untimed" for legacy
                quizzes (timeLimitSeconds = NULL) and "Nm Xs" (or "Nm") for
                quizzes carrying a value. Editors change the value via the
                JSON editor below; the read-out here keeps the at-a-glance
                contract symmetric with the pass-threshold display. */}
            <div
              data-testid="quiz-time-limit-summary"
              style={{
                fontSize: 11,
                fontFamily: "var(--mono)",
                color: "var(--ink-3)",
                marginTop: 6,
              }}
            >
              {row.timeLimitSeconds === null || row.timeLimitSeconds === undefined
                ? "untimed"
                : `time limit: ${Math.floor(row.timeLimitSeconds / 60)}m${
                    row.timeLimitSeconds % 60 !== 0
                      ? ` ${row.timeLimitSeconds % 60}s`
                      : ""
                  }`}
            </div>
            <span
              style={{
                display: "inline-block",
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontFamily: "var(--mono)",
                marginTop: 4,
                background: row.active ? "var(--lichen-soft)" : "var(--paper-2)",
                color: row.active ? "var(--lichen)" : "var(--ink-3)",
              }}
            >
              {row.active ? "active" : "inactive"}
            </span>
          </div>
        </div>
      </header>

      <section style={{ display: "grid", gap: 18 }}>
        <QuizSchemaEditor quizId={row.id} initialJson={pretty} />
        <aside
          style={{
            background: "var(--paper-2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            padding: "10px 14px",
            fontSize: 12,
            color: "var(--ink-3)",
            lineHeight: 1.55,
          }}
        >
          <strong style={{ color: "var(--ink-2)" }}>Schema reference.</strong>{" "}
          The payload accepts <code>title</code>, <code>passThreshold</code>,
          <code> active</code>, an optional <code>timeLimitSeconds</code>
          (Spec 159; <code>null</code> = untimed; otherwise an integer
          between 60 and 7200 = 1 min to 2 h), and a{" "}
          <code>questions[]</code> array. Each question must have{" "}
          <code>prompt</code> (string), <code>options</code> (array of ≥ 2
          strings), <code>correctIndex</code> (0-based integer into options),
          and an optional <code>explanation</code>.
        </aside>
      </section>
    </main>
  );
}
