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
//
// Spec 159 — Workflow Run 15 audit-closure MISS: optional time-limit
// countdown. When `timeLimitSeconds` is set on the quiz, the runner shows a
// mono-font countdown banner ("08:42 remaining"). The banner shifts to
// var(--rust) under 60 seconds remaining. On 00:00 the runner submits
// whatever state it has — same wire shape as a click on the Submit button,
// but with every unanswered question carrying `selectedIndex: null` per the
// spec 146 contract. The countdown uses setInterval + a useEffect cleanup
// so navigating away tears the timer down cleanly.

import { useEffect, useRef, useState, useTransition } from "react";

export type QuizRunnerQuestion = {
  id: string;
  prompt: string;
  options: string[];
};

export type QuizRunnerProps = {
  slug: string;
  title: string;
  questions: QuizRunnerQuestion[];
  // Spec 159 — optional time-limit in seconds. null/undefined = untimed.
  timeLimitSeconds?: number | null;
  // Server action — receives slug + answers; redirects to /quizzes/[slug]/result/[id].
  // Spec 146: client sends ALL questions; skipped answers carry
  // `selectedIndex: null` so the server can count them as wrong (0 points)
  // instead of silently shrinking the denominator.
  submitAction: (
    slug: string,
    answers: Array<{ questionId: string; selectedIndex: number | null }>,
  ) => Promise<void>;
};

// Spec 159 — format a non-negative number of seconds as MM:SS for the
// countdown banner. Clamped at 0 (no negative-time flash if a tick fires
// after the auto-submit has already redirected). The pad is fine for
// timers up to 99:59 (5999 s); the DB CHECK caps the field at 7200s so
// the worst case is 120:00 which renders without surprise.
function formatRemaining(s: number): string {
  const clamped = Math.max(0, Math.floor(s));
  const mm = Math.floor(clamped / 60)
    .toString()
    .padStart(2, "0");
  const ss = (clamped % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function QuizRunner({
  slug,
  title,
  questions,
  timeLimitSeconds,
  submitAction,
}: QuizRunnerProps) {
  const [idx, setIdx] = useState(0);
  // selected[questionId] = chosen option index (0-based).
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [isPending, startTransition] = useTransition();
  const [serverErr, setServerErr] = useState<string | null>(null);
  // Spec 159 — countdown state. null = untimed quiz; non-null = seconds
  // left until auto-submit. We seed it from the prop once (the useEffect
  // dep array is intentionally [] so a parent re-render does NOT reset
  // the timer mid-attempt).
  const [remaining, setRemaining] = useState<number | null>(
    typeof timeLimitSeconds === "number" ? timeLimitSeconds : null,
  );
  // Spec 159 — a ref so the interval tick can call the latest selection
  // map / submit path without re-arming the timer when those change.
  const selectedRef = useRef(selected);
  const submittedRef = useRef(false);
  const questionsRef = useRef(questions);
  // Assigned in an effect, never in the render body. Writing to a ref during
  // render is a render-phase side effect (react-hooks/refs) and is unsafe
  // under StrictMode's double render and concurrent features. No dep array
  // means this runs after every commit, preserving the "always latest"
  // contract. Safe because both refs are read only inside the countdown interval callback.
  useEffect(() => {
    selectedRef.current = selected;
    questionsRef.current = questions;
  });

  // Spec 159 — countdown effect. Mounted ONCE on first render; reads the
  // initial `timeLimitSeconds` prop. Ticks once per second; when remaining
  // hits 0 it fires the auto-submit (idempotent via submittedRef so a
  // race between the tick and a manual click can't double-submit). The
  // cleanup function clears the interval so navigating away tears the
  // timer down. Empty dep array is intentional: we don't want a parent
  // re-render to reset the timer mid-attempt.
  useEffect(() => {
    if (typeof timeLimitSeconds !== "number") return;
    // Auto-submit closure — reads from refs so it always sees the latest
    // selection map and the latest question list, even though the effect
    // captured the initial values.
    const autoSubmit = () => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      const live = selectedRef.current;
      const answers = questionsRef.current.map((qq) => ({
        questionId: qq.id,
        selectedIndex: live[qq.id] === undefined ? null : live[qq.id],
      }));
      // Fire-and-forget: same shape as the manual onSubmit but without
      // the useTransition wrapper (we're already inside an interval
      // callback, not a render path).
      submitAction(slug, answers).catch((e: unknown) => {
        setServerErr((e as Error).message);
        submittedRef.current = false; // permit retry if the server bounced
      });
    };
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev === null) return prev;
        const next = prev - 1;
        if (next <= 0) {
          // Defer the submit to a microtask so React finishes this state
          // update before the redirect fires. `queueMicrotask` is enough —
          // we don't need setTimeout's macrotask delay.
          queueMicrotask(autoSubmit);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Spec 159 — mark submittedRef so the auto-submit tick can't fire
    // a second submit if the user happens to click Submit exactly at
    // the 0-second boundary.
    if (submittedRef.current) return;
    submittedRef.current = true;
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
        submittedRef.current = false;
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
        {/* Spec 159 — countdown banner. Only renders when the quiz has a
            time limit. The banner shifts to var(--rust) under 60s
            remaining so the learner has a clear last-minute cue. The
            data-testid attribute makes the banner scrapable by the
            governance test (and any future Playwright integration). */}
        {remaining !== null ? (
          <div
            data-testid="quiz-countdown"
            role="timer"
            aria-live="polite"
            style={{
              marginTop: 12,
              padding: "8px 12px",
              background:
                remaining < 60 ? "var(--rust-soft)" : "var(--paper-2)",
              border:
                "1px solid " +
                (remaining < 60 ? "var(--rust)" : "var(--line)"),
              borderRadius: "var(--r-2)",
              fontFamily: "var(--mono)",
              fontSize: 13,
              color: remaining < 60 ? "var(--rust)" : "var(--ink)",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              Time remaining
            </span>
            <span style={{ fontWeight: 600 }}>
              {formatRemaining(remaining)}
            </span>
          </div>
        ) : null}
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
