// /admin/quizzes/[id] — JSON editor for a single quiz (metadata + questions).
// Server component (role gate + initial fetch); the editor is a 'use client'
// child that posts back through the `saveQuizSchema` server action defined in
// ./actions.ts. Mirrors the spec 073 form-schema editor pattern.
//
// Words are in the user's language (adminData.quizzes.detail); the quiz JSON
// and the payload's key names (title, questions, ...) are data and code.

import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { quizzes, quizQuestions, quizSubmissions } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { QuizSchemaEditor } from "./parts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function AdminQuizDetailPage({ params }: Props) {
  await requireRole(["programme_admin", "super_admin"]);
  const { id } = await params;
  const t = await getTranslations("adminData");
  // <code>…</code> and <strong>…</strong> inside the page's sentences.
  const code = (chunks: ReactNode) => <code>{chunks}</code>;
  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;

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

  // Said before anyone edits a quiz learners have sat: what happens to their
  // results. The editor used to give no sign that submissions existed.
  const [sat] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(quizSubmissions)
    .where(eq(quizSubmissions.quizId, row.id));
  const submittedCount = sat?.n ?? 0;

  // Spec 159 — Workflow Run 15 audit-closure MISS: time_limit_seconds is
  // now part of the editable JSON. The export shape carries it (NULL =
  // untimed) and the schema reference aside calls out the valid range so
  // the editor knows what numbers are accepted. The saveQuizSchema
  // server action validates the same range before writing.
  const exportShape = {
    title: row.title,
    passThreshold: row.passThreshold,
    timeLimitSeconds: row.timeLimitSeconds,
    maxAttempts: row.maxAttempts,
    // Only when there is one. A quiz on a curriculum subject has none, and
    // exporting "rttSubjectId": null made this editor's own untouched output
    // unsaveable: the action reads any value as a move, and null is no RTT
    // subject (W3-16).
    ...(row.rttSubjectId ? { rttSubjectId: row.rttSubjectId } : {}),
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
          {t("quizzes.detail.back")}
        </Link>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          {t("quizzes.detail.eyebrow", { slug: row.slug })}
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
              {t.rich("quizzes.detail.intro", { strong, code })}
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
              {t("quizzes.detail.passThreshold")}
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
                ? t("quizzes.detail.untimed")
                : row.timeLimitSeconds % 60 !== 0
                  ? t("quizzes.detail.timeLimitSeconds", {
                      minutes: String(Math.floor(row.timeLimitSeconds / 60)),
                      seconds: String(row.timeLimitSeconds % 60),
                    })
                  : t("quizzes.detail.timeLimit", { minutes: String(Math.floor(row.timeLimitSeconds / 60)) })}
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
              {row.active ? t("common.active") : t("common.inactive")}
            </span>
          </div>
        </div>
      </header>

      <section style={{ display: "grid", gap: 18 }}>
        {submittedCount > 0 ? (
          <p
            data-testid="quiz-editor-submissions"
            style={{
              margin: 0,
              padding: "8px 12px",
              border: "1px solid var(--saffron)",
              background: "var(--saffron-soft)",
              borderRadius: "var(--r-2)",
              fontSize: 12,
              color: "var(--ink-2)",
            }}
          >
            {t.rich("quizzes.detail.submissions", { count: submittedCount, code })}
          </p>
        ) : null}
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
          {t.rich("quizzes.detail.schemaReference", {
            code,
            strong: (chunks) => <strong style={{ color: "var(--ink-2)" }}>{chunks}</strong>,
          })}
        </aside>
      </section>
    </main>
  );
}
