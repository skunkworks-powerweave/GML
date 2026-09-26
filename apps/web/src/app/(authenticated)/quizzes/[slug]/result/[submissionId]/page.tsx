// /quizzes/[slug]/result/[submissionId] — quiz result screen.
// Server-renders the submission summary (score + pass/fail banner) and a
// per-question breakdown (correct/incorrect; the correct option and the
// explanation only once retaking cannot gain from them -- see revealKey).
// "Retake" links back to the runner while an attempt remains. Mirrors the JSX prototype's done-state in
// `LMS GML Frontend/forms.jsx::QuizRunner` (lines 166-200).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  quizzes,
  quizQuestions,
  quizSubmissions,
} from "@gml/db/schema";
import { auth } from "@/auth";
import { quizShownTo } from "../../quiz-scope";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Quiz results" };

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

  // WHAT THE LEARNER WAS ASKED, NOT WHAT THE QUIZ SAYS NOW.
  //
  // This page read the live quiz_questions rows, which the editor rewrites in
  // place by position -- so inserting, reordering or rewording a question on a
  // live quiz re-attached every past answer to a different question and
  // re-graded it against the current key, beside a stored score that did not
  // move. The submission carries the questions it was graded against
  // (migration 0030); the live rows are the fallback for a row without them.
  const questions =
    submission.questionSnapshot ??
    (
      await db
        .select()
        .from(quizQuestions)
        .where(eq(quizQuestions.quizId, quiz.id))
        .orderBy(asc(quizQuestions.sequence))
    ).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: Array.isArray(q.options) ? q.options : [],
      correctIndex: q.correctIndex,
      explanation: q.explanation,
    }));

  const answerMap = new Map(
    (submission.answers ?? []).map((a) => [a.questionId, a.selectedIndex] as const),
  );

  const passed = submission.passed;
  const score = submission.score;
  const threshold = quiz.passThreshold;

  // ── THE ANSWER KEY IS SHOWN ONLY WHEN IT CAN NO LONGER BE USED ────────────
  //
  // This page printed "Correct: <option>" and the explanation for every
  // question after every attempt, next to a Retake button. A learner who
  // failed -- or submitted blanks on purpose -- read the key and retook for
  // 100%, so the pass mark measured nothing and max_attempts (added so that
  // resubmitting until you pass would not turn an assessment into a
  // formality) was defeated after one try.
  //
  // So the key and the explanations wait until retaking cannot gain anything:
  // the learner has passed this quiz (on any attempt), or has used every
  // attempt a capped quiz allows. Until then they still see which of their
  // answers were wrong. Counted the same way the runner counts: submissions.
  const [mine] = await db
    .select({
      used: sql<number>`count(*)::int`,
      everPassed: sql<boolean>`coalesce(bool_or(${quizSubmissions.passed}), false)`,
    })
    .from(quizSubmissions)
    .where(and(eq(quizSubmissions.quizId, quiz.id), eq(quizSubmissions.userId, session.user.id)));
  const attemptsLeft =
    quiz.maxAttempts == null ? null : Math.max(0, quiz.maxAttempts - (mine?.used ?? 0));
  const canRetake = attemptsLeft === null || attemptsLeft > 0;
  const revealKey = Boolean(mine?.everPassed) || !canRetake;
  // Whether the quiz can be taken now: switched off, or on an RTT subject this
  // learner is no longer shown (W3-21), the runner 404s, so no Retake is
  // offered -- and the subject's page is not there to go back to.
  const shown = await quizShownTo(db, { id: session.user.id, role: session.user.role }, quiz);
  const offerRetake = canRetake && quiz.active && shown;

  // WHERE "CONTINUE" GOES (W3-22). A pass said "you may proceed to the next
  // module" while Continue went to the dashboard, which does not lead to the
  // subject either. An RTT quiz now goes back to its subject page, where the
  // modules are; a quiz on a curriculum subject has no module to promise and
  // continues to the dashboard (there is no quiz list to send it to).
  const subjectHref = quiz.rttSubjectId && shown ? `/rtt/subject/${quiz.rttSubjectId}` : null;

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
              ? subjectHref
                ? "Well done — continue with the next module on the subject page."
                : "Well done — you passed this quiz."
              : revealKey
                ? "The correct answers and explanations are shown below."
                : attemptsLeft === null
                  ? "Your wrong answers are marked below. Retake when you are ready; the correct answers are shown once you pass."
                  : `Your wrong answers are marked below. You have ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left; the correct answers are shown once you pass or use your last attempt.`}
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
                      {revealKey ? (
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
                      ) : null}
                      {revealKey && q.explanation ? (
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
            {/* Only while an attempt remains: the runner sends a learner with
                none left straight to their history. */}
            {offerRetake ? (
              <Link href={`/quizzes/${slug}`} className="btn">
                Retake
              </Link>
            ) : null}
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
            <Link href={subjectHref ?? "/dashboard"} className="btn btn-primary">
              {subjectHref ? "Back to the subject" : "Continue"}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
