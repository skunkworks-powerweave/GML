"use client";

// MobileQuizRunner — full-screen one-question-per-screen quiz runner.
// Ports `LMS GML Frontend/mobile-runners.jsx::MobQuiz` (lines 369-467) into
// a real Next.js client component used as a drop-in replacement for
// <QuizRunner> on mobile-detected devices.
//
// Same grading contract as the desktop QuizRunner (spec 120): UI collects
// per-question answers and posts them via the `submitAction` server action.
// Scoring is server-side. On submit the action redirects to
// `/quizzes/[slug]/result/[submissionId]`.
//
// Layout differences vs desktop QuizRunner:
//   - One question per "screen" — no card wrapper, full width
//   - Progress dots at the top instead of a single bar (dot per question)
//   - Question text rendered with Crimson Pro 22px (var(--serif))
//   - 4 large A/B/C/D option buttons; min-height 56px (≥ 44 touch target)
//   - Sticky bottom action bar with Previous / Next or Submit
//   - Respects env(safe-area-inset-*) for notch devices
//
// Spec 134.

import { useState, useTransition } from "react";

export type MobileQuizRunnerQuestion = {
  id: string;
  prompt: string;
  options: string[];
};

export type MobileQuizRunnerProps = {
  slug: string;
  title: string;
  questions: MobileQuizRunnerQuestion[];
  // Server action — receives slug + answers; redirects to
  // /quizzes/[slug]/result/[id]. Drop-in same shape as QuizRunner.
  submitAction: (
    slug: string,
    answers: Array<{ questionId: string; selectedIndex: number }>,
  ) => Promise<void>;
};

export function MobileQuizRunner({
  slug,
  title,
  questions,
  submitAction,
}: MobileQuizRunnerProps) {
  const [idx, setIdx] = useState(0);
  // selected[questionId] = chosen option index (0-based).
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [isPending, startTransition] = useTransition();
  const [serverErr, setServerErr] = useState<string | null>(null);

  if (questions.length === 0) {
    return (
      <div
        data-testid="mobile-quiz-empty"
        style={{
          padding: "40px 16px",
          textAlign: "center",
        }}
      >
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 20, margin: 0 }}>
          No questions yet
        </h2>
        <p style={{ color: "var(--ink-3)", marginTop: 8, fontSize: 13 }}>
          This quiz has no questions. Ask an admin to add some.
        </p>
      </div>
    );
  }

  const q = questions[idx];
  const totalCount = questions.length;
  const selection = selected[q.id];
  const isLast = idx === totalCount - 1;

  const onPick = (i: number) =>
    setSelected((s) => ({ ...s, [q.id]: i }));

  const onSubmit = () => {
    const answers = questions
      .filter((qq) => selected[qq.id] !== undefined)
      .map((qq) => ({ questionId: qq.id, selectedIndex: selected[qq.id]! }));
    setServerErr(null);
    startTransition(async () => {
      try {
        await submitAction(slug, answers);
      } catch (e) {
        setServerErr((e as Error).message);
      }
    });
  };

  return (
    <div
      data-testid="mobile-quiz-runner"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "calc(100dvh - 120px)",
      }}
    >
      {/* Top: progress dots + title + counter */}
      <div
        data-testid="mobile-quiz-header"
        style={{
          padding: "12px 16px 10px",
          borderBottom: "1px solid var(--line)",
          background: "var(--paper)",
          paddingTop: "calc(12px + env(safe-area-inset-top, 0))",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <div
            className="label"
            style={{ padding: 0, fontSize: 10, letterSpacing: "0.06em" }}
          >
            Quiz
          </div>
          <div
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-3)" }}
          >
            {idx + 1} / {totalCount}
          </div>
        </div>
        <h1
          style={{
            fontFamily: "var(--serif)",
            fontSize: 16,
            margin: 0,
            lineHeight: 1.3,
          }}
        >
          {title}
        </h1>
        {/* Progress dots */}
        <div
          data-testid="mobile-quiz-dots"
          style={{
            display: "flex",
            gap: 4,
            marginTop: 10,
            alignItems: "center",
          }}
        >
          {questions.map((qq, i) => {
            const answered = selected[qq.id] !== undefined;
            const active = i === idx;
            return (
              <span
                key={qq.id}
                data-testid={`mobile-quiz-dot-${i}`}
                aria-label={
                  active
                    ? `Current question ${i + 1}`
                    : answered
                      ? `Answered question ${i + 1}`
                      : `Unanswered question ${i + 1}`
                }
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: active
                    ? "var(--saffron)"
                    : answered
                      ? "var(--ink)"
                      : "var(--paper-3)",
                  transition: "background 120ms ease",
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Body: question + 4 option buttons */}
      <div
        style={{
          flex: 1,
          padding: "20px 16px 24px",
          overflowY: "auto",
        }}
      >
        <div
          className="mono"
          style={{ fontSize: 11, color: "var(--ink-3)" }}
        >
          Question {idx + 1}
        </div>
        <h2
          style={{
            fontFamily: "var(--serif)",
            fontSize: 22,
            marginTop: 6,
            lineHeight: 1.35,
          }}
        >
          {q.prompt}
        </h2>

        <div
          data-testid="mobile-quiz-options"
          style={{ display: "grid", gap: 10, marginTop: 22 }}
        >
          {q.options.map((opt, i) => {
            const isSel = selection === i;
            return (
              <button
                key={i}
                type="button"
                data-testid={`mobile-quiz-option-${i}`}
                onClick={() => onPick(i)}
                style={{
                  textAlign: "left",
                  padding: "14px 14px",
                  minHeight: 56,
                  background: isSel ? "var(--saffron)" : "var(--card-hi)",
                  color: isSel ? "var(--paper)" : "var(--ink)",
                  border:
                    "1px solid " + (isSel ? "var(--saffron)" : "var(--line)"),
                  borderRadius: 10,
                  fontSize: 14,
                  cursor: "pointer",
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  width: "100%",
                  touchAction: "manipulation",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    minWidth: 28,
                    borderRadius: "50%",
                    background: isSel ? "var(--paper)" : "var(--paper-3)",
                    color: isSel ? "var(--saffron)" : "var(--ink-3)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: "var(--mono)",
                  }}
                >
                  {String.fromCharCode(65 + i)}
                </span>
                {opt}
              </button>
            );
          })}
        </div>

        {serverErr ? (
          <div
            data-testid="mobile-quiz-error"
            style={{
              marginTop: 14,
              color: "var(--rust)",
              fontSize: 12,
              fontFamily: "var(--mono)",
            }}
          >
            {serverErr}
          </div>
        ) : null}
      </div>

      {/* Sticky bottom action bar */}
      <div
        data-testid="mobile-quiz-actions"
        style={{
          position: "sticky",
          bottom: 0,
          padding: "12px 16px",
          paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0))",
          background: "var(--paper)",
          borderTop: "1px solid var(--line)",
          display: "flex",
          gap: 8,
        }}
      >
        <button
          type="button"
          className="btn"
          data-testid="mobile-quiz-prev"
          disabled={idx === 0 || isPending}
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          style={{
            flex: 1,
            minHeight: 48,
          }}
        >
          ← Previous
        </button>
        {!isLast ? (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="mobile-quiz-next"
            disabled={selection === undefined || isPending}
            onClick={() => setIdx((i) => Math.min(totalCount - 1, i + 1))}
            style={{
              flex: 1.6,
              minHeight: 48,
            }}
          >
            Next →
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="mobile-quiz-submit"
            disabled={selection === undefined || isPending}
            onClick={onSubmit}
            style={{
              flex: 1.6,
              minHeight: 48,
            }}
          >
            {isPending ? "Submitting…" : "Submit"}
          </button>
        )}
      </div>
    </div>
  );
}
