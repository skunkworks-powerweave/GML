// /quizzes/[slug]/result/[submissionId] — quiz result screen.
// Server-renders the submission summary (score + pass/fail banner) and a
// per-question breakdown (correct/incorrect + explanation). "Retake" links
// back to the runner. Mirrors the JSX prototype's done-state in
// `LMS GML Frontend/forms.jsx::QuizRunner` (lines 166-200).

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import {
  quizzes,
  quizQuestions,
  quizSubmissions,
} from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export default async function QuizResultPage({
  params,
}: {
  params: Promise<{ slug: string; submissionId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { slug, submissionId } = await params;

  const [quiz] = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.slug, slug))
    .limit(1);
  if (!quiz) notFound();

  const [submission] = await db
    .select()
    .from(quizSubmissions)
    .where(
      and(
        eq(quizSubmissions.id, submissionId),
        eq(quizSubmissions.quizId, quiz.id),
      ),
    )
    .limit(1);
  if (!submission) notFound();

  // SM-9 light gate: only the submission owner can see the result page.
  if (submission.userId !== session.user.id) {
    redirect("/forbidden");
  }

  const questions = await db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id))
    .orderBy(asc(quizQuestions.sequence));

  const answerMap = new Map(
    (submission.answers ?? []).map((a) => [a.questionId, a.selectedIndex] as const),
  );

  const passed = submission.passed;
  const score = submission.score;
  const threshold = quiz.passThreshold;

  // Spec 146 — grading-bug fix surfaces a separate "answered" vs
  // "correct" count. Skipped (null/undefined) and explicitly-answered
  // are now distinct on the result page so a learner who skipped
  // questions sees that called out (rather than being told they "got
  // them wrong" — which is technically true for the grade but isn't
  // the most useful framing).
  const totalCount = questions.length;
  let answeredCount = 0;
  let correctCount = 0;
  for (const q of questions) {
    const picked = answerMap.get(q.id);
    const wasAnswered = picked !== undefined && picked !== null;
    if (wasAnswered) {
      answeredCount += 1;
      if (picked === q.correctIndex) correctCount += 1;
    }
  }
  const skippedCount = totalCount - answeredCount;

  return (
    <main>
      <div className="page-header">
        <Link
          href={`/quizzes/${slug}`}
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 6, textDecoration: "none" }}
        >
          ← Quiz
        </Link>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>
          Quiz results
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4, fontSize: 13 }}>
          {quiz.title}
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", placeItems: "center" }}>
        <div
          className="card card-hi"
          style={{
            padding: 40,
            textAlign: "center",
            maxWidth: 640,
            width: "100%",
          }}
        >
          <div
            style={{
              fontFamily: "var(--serif)",
              fontSize: 56,
              color: passed ? "var(--lichen)" : "var(--saffron)",
            }}
          >
            {score}%
          </div>
          <div
            style={{
              display: "inline-block",
              marginTop: 8,
              padding: "4px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              background: passed ? "var(--lichen-soft)" : "var(--saffron-soft)",
              color: passed ? "var(--lichen)" : "var(--saffron)",
            }}
          >
            {passed ? `Pass · ≥ ${threshold}%` : `Try again · need ${threshold}%`}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--ink-3)",
              marginTop: 12,
            }}
          >
            {passed
              ? "Well done — you may proceed to the next module."
              : "Review the explanations below and retake when you are ready."}
          </div>
          {/* Spec 146 — answered vs total breakdown. Skipped questions
              are counted as wrong against the denominator (same
              percentage shown above), but called out separately here so
              the learner can see "I skipped 3" vs "I got 3 wrong". */}
          <div
            data-testid="quiz-result-breakdown"
            style={{
              marginTop: 14,
              fontSize: 12,
              color: "var(--ink-3)",
              fontFamily: "var(--mono)",
              letterSpacing: "0.02em",
            }}
          >
            {answeredCount} of {totalCount} answered ·{" "}
            <span style={{ color: "var(--lichen)" }}>
              {correctCount} correct
            </span>{" "}
            of {totalCount}
            {skippedCount > 0 ? (
              <>
                {" "}·{" "}
                <span style={{ color: "var(--saffron)" }}>
                  {skippedCount} skipped
                </span>
              </>
            ) : null}
          </div>

          <div
            style={{
              marginTop: 28,
              display: "grid",
              gap: 12,
              textAlign: "left",
            }}
          >
            {questions.map((q, i) => {
              const picked = answerMap.get(q.id);
              // Spec 146 — `picked` is now `number | null | undefined`.
              // null = explicit "skipped" from the new client contract;
              // undefined = legacy submission predating spec 146.
              // Both count as wrong, but neither is "correct".
              const wasAnswered = picked !== undefined && picked !== null;
              const isCorrect = wasAnswered && picked === q.correctIndex;
              return (
                <div
                  key={q.id}
                  style={{
                    background: "var(--paper)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-2)",
                    padding: 12,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: isCorrect ? "var(--lichen-soft)" : "var(--rust-soft)",
                        color: isCorrect ? "var(--lichen)" : "var(--rust)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        fontWeight: 700,
                        fontFamily: "var(--mono)",
                      }}
                      aria-label={isCorrect ? "Correct" : "Incorrect"}
                    >
                      {isCorrect ? "✓" : "×"}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>
                        {i + 1}. {q.prompt}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--ink-3)",
                          marginTop: 6,
                        }}
                      >
                        {wasAnswered ? (
                          <>
                            Your answer:{" "}
                            <span style={{ color: "var(--ink)" }}>
                              {q.options[picked as number] ??
                                `(option ${picked})`}
                            </span>
                          </>
                        ) : (
                          <em>Skipped</em>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--ink-3)",
                          marginTop: 2,
                        }}
                      >
                        Correct:{" "}
                        <span style={{ color: "var(--lichen)" }}>
                          {q.options[q.correctIndex] ?? `(option ${q.correctIndex})`}
                        </span>
                      </div>
                      {q.explanation ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--ink-2)",
                            marginTop: 8,
                            background: "var(--paper-2)",
                            padding: "8px 10px",
                            borderRadius: "var(--r-2)",
                          }}
                        >
                          {q.explanation}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 24,
              display: "flex",
              gap: 8,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <Link href={`/quizzes/${slug}`} className="btn">
              Retake
            </Link>
            {/* Spec 159 — link to the per-user attempts history. The
                history page is server-rendered and scopes to the
                current user, so this link is safe to surface
                unconditionally for any logged-in viewer. */}
            <Link
              href={`/quizzes/${slug}/history`}
              className="btn btn-ghost"
              data-testid="quiz-result-history-link"
            >
              View history
            </Link>
            <Link href="/dashboard" className="btn btn-primary">
              Continue
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
