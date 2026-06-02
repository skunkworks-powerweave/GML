"use client";

// QuizRunner — multiple-choice quiz client component.
// Ports `LMS GML Frontend/forms.jsx::QuizRunner` (lines 157-266) into a real
// Next.js client component. Owns:
//   - Per-question A/B/C/D radio selection
//   - Progress bar + "x / y" counter
//   - Previous / Next / Submit navigation
//   - Calls `submitQuizAttempt` server action on Submit
//
// The component is intentionally dumb about scoring — grading happens entirely
// server-side via the server action passed in from the parent page. The UI only
// collects answers and redirects to the result page on submit.

import { useState, useTransition } from "react";

export type QuizRunnerQuestion = {
  id: string;
  prompt: string;
  options: string[];
};

export type QuizRunnerProps = {
  slug: string;
  title: string;
  questions: QuizRunnerQuestion[];
  // Server action — receives slug + answers; redirects to /quizzes/[slug]/result/[id].
  // Spec 146: client sends ALL questions; skipped answers carry
  // `selectedIndex: null` so the server can count them as wrong (0 points)
  // instead of silently shrinking the denominator.
  submitAction: (
    slug: string,
    answers: Array<{ questionId: string; selectedIndex: number | null }>,
  ) => Promise<void>;
};

export function QuizRunner({ slug, title, questions, submitAction }: QuizRunnerProps) {
  const [idx, setIdx] = useState(0);
  // selected[questionId] = chosen option index (0-based).
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [isPending, startTransition] = useTransition();
  const [serverErr, setServerErr] = useState<string | null>(null);

  if (questions.length === 0) {
    return (
      <div className="card card-hi" style={{ padding: 32, textAlign: "center" }}>
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
  const progressPct = ((idx + 1) / totalCount) * 100;
  const selection = selected[q.id];
  const isLast = idx === totalCount - 1;

  const onPick = (i: number) =>
    setSelected((s) => ({ ...s, [q.id]: i }));

  const onSubmit = () => {
    // Spec 146 — grading-bug fix. Send EVERY question, with
    // `selectedIndex: null` for any the learner skipped. Before this fix
    // we filtered to "answered only", which caused the server to grade
    // against a shorter list than the DB held and silently turned
    // skipped questions into a free pass on the denominator. Skipped
    // questions are now graded as wrong (0 points) — the learner had
    // the chance to answer and chose not to.
    const answers = questions.map((qq) => ({
      questionId: qq.id,
      selectedIndex: selected[qq.id] === undefined ? null : selected[qq.id],
    }));
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
    <div>
      <div className="page-header">
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <div className="label">Quiz</div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{title}</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className="chip">{totalCount} questions</span>
                <span className="chip chip-saffron">multiple choice</span>
              </span>
            </p>
          </div>
          <div className="mono" style={{ fontSize: 14, color: "var(--ink-3)" }}>
            {idx + 1} / {totalCount}
          </div>
        </div>
        <div className="bar" style={{ marginTop: 14 }}>
          <div style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", placeItems: "center" }}>
        <div
          className="card card-hi"
          style={{ width: "100%", maxWidth: 640, padding: 32 }}
        >
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
            Question {idx + 1}
          </div>
          <h2
            style={{
              fontFamily: "var(--serif)",
              fontSize: 22,
              marginTop: 8,
              lineHeight: 1.3,
            }}
          >
            {q.prompt}
          </h2>

          <div style={{ display: "grid", gap: 8, marginTop: 22 }}>
            {q.options.map((opt, i) => {
              const isSel = selection === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onPick(i)}
                  style={{
                    textAlign: "left",
                    padding: "12px 14px",
                    background: isSel ? "var(--ink)" : "var(--paper)",
                    color: isSel ? "var(--paper)" : "var(--ink)",
                    border: "1px solid " + (isSel ? "var(--ink)" : "var(--line)"),
                    borderRadius: 8,
                    fontSize: 14,
                    cursor: "pointer",
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      background: isSel ? "var(--paper)" : "var(--paper-3)",
                      color: isSel ? "var(--ink)" : "var(--ink-3)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 600,
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

          <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
            <button
              type="button"
              className="btn"
              disabled={idx === 0 || isPending}
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
            >
              ← Previous
            </button>
            {!isLast ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={selection === undefined || isPending}
                onClick={() => setIdx((i) => Math.min(totalCount - 1, i + 1))}
              >
                Next →
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={selection === undefined || isPending}
                onClick={onSubmit}
              >
                {isPending ? "Submitting…" : "Submit answers"}
              </button>
            )}
          </div>

          {serverErr ? (
            <div
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
      </div>
    </div>
  );
}
