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
//
// Spec 159 — Workflow Run 15 audit-closure MISS: the mobile runner mirrors
// the desktop time-limit countdown. When `timeLimitSeconds` is set on the
// quiz, a mono-font countdown chip renders in the sticky header (next to
// the "1 / N" counter). It shifts to var(--rust) under 60s. On 00:00 the
// runner auto-submits whatever state the learner has collected, via the
// same submitAction wire shape used on click — every unanswered question
// carries `selectedIndex: null` per the spec 146 grading contract.
//
// Spec 169 — Workflow Run 16 polish: thumb-friendly horizontal swipes
// jump between questions, mirroring the spec 139 pattern wired into
// MobileFormRunner. Left-swipe (→ next) advances after the same
// "selection required" gate the Next button uses; right-swipe (→ prev)
// is a free move back, clamped to step 0. Swipes are ADDITIVE — the
// Previous / Next buttons remain the canonical affordance so keyboard
// and screen-reader users have unchanged paths. Submit always happens
// via the explicit button; we never let a swipe finalise the quiz.

import { useEffect, useRef, useState, useTransition } from "react";
import { useSwipe } from "@/lib/use-swipe";

export type MobileQuizRunnerQuestion = {
  id: string;
  prompt: string;
  options: string[];
};

export type MobileQuizRunnerProps = {
  slug: string;
  title: string;
  questions: MobileQuizRunnerQuestion[];
  // Spec 159 — optional time-limit in seconds. null/undefined = untimed.
  timeLimitSeconds?: number | null;
  // Server action — receives slug + answers; redirects to
  // /quizzes/[slug]/result/[id]. Drop-in same shape as QuizRunner.
  // Spec 146: client sends ALL questions; skipped answers carry
  // `selectedIndex: null` so the server can count them as wrong (0 points)
  // instead of silently shrinking the denominator.
  submitAction: (
    slug: string,
    answers: Array<{ questionId: string; selectedIndex: number | null }>,
  ) => Promise<void>;
};

// Spec 159 — format a non-negative number of seconds as MM:SS. Same helper
// shape as the desktop QuizRunner (kept inline-duplicated rather than
// extracted to a shared module: the helper is 7 lines and the duplication
// avoids introducing a cross-component dependency for a single fix).
function formatRemaining(s: number): string {
  const clamped = Math.max(0, Math.floor(s));
  const mm = Math.floor(clamped / 60)
    .toString()
    .padStart(2, "0");
  const ss = (clamped % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function MobileQuizRunner({
  slug,
  title,
  questions,
  timeLimitSeconds,
  submitAction,
}: MobileQuizRunnerProps) {
  const [idx, setIdx] = useState(0);
  // selected[questionId] = chosen option index (0-based).
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [isPending, startTransition] = useTransition();
  const [serverErr, setServerErr] = useState<string | null>(null);
  // Spec 159 — countdown state. null = untimed quiz; non-null = seconds
  // left until auto-submit. Seeded once from the prop; the useEffect
  // below ticks it down to 0 and fires the auto-submit.
  const [remaining, setRemaining] = useState<number | null>(
    typeof timeLimitSeconds === "number" ? timeLimitSeconds : null,
  );
  // Spec 159 — refs let the interval tick read the latest selection /
  // question list / submitted flag without re-arming the timer when those
  // change. submittedRef is the idempotency guard that prevents a race
  // between a 0-second tick and a manual Submit click.
  const selectedRef = useRef(selected);
  const questionsRef = useRef(questions);
  const submittedRef = useRef(false);
  // Assigned in an effect, never in the render body. Writing to a ref during
  // render is a render-phase side effect (react-hooks/refs) and is unsafe
  // under StrictMode's double render and concurrent features. No dep array
  // means this runs after every commit, preserving the "always latest"
  // contract. Safe because both refs are read only inside the countdown interval callback.
  useEffect(() => {
    selectedRef.current = selected;
    questionsRef.current = questions;
  });

  // Spec 159 — countdown effect. Empty dep array (timer mounts once and
  // tears down on unmount). Same shape as the desktop runner so the two
  // surfaces have identical auto-submit semantics.
  useEffect(() => {
    if (typeof timeLimitSeconds !== "number") return;
    const autoSubmit = () => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      const live = selectedRef.current;
      const answers = questionsRef.current.map((qq) => ({
        questionId: qq.id,
        selectedIndex: live[qq.id] === undefined ? null : live[qq.id],
      }));
      submitAction(slug, answers).catch((e: unknown) => {
        setServerErr((e as Error).message);
        submittedRef.current = false;
      });
    };
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev === null) return prev;
        const next = prev - 1;
        if (next <= 0) {
          queueMicrotask(autoSubmit);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spec 169 — named nav helpers so swipe + button share one path.
  // Hoisted above the empty-questions early return so the useSwipe
  // hook below is called unconditionally on every render (Rules of
  // Hooks). goNext mirrors the disabled state of the Next button: a
  // swipe can advance only when the current question has a selection
  // AND we are not on the last screen (the last screen's right-side
  // action is Submit, which is button-only by design — see swipe
  // wire below).
  const totalCount = questions.length;
  const isLast = totalCount > 0 && idx === totalCount - 1;
  const currentQ = totalCount > 0 ? questions[idx] : undefined;
  const selection = currentQ ? selected[currentQ.id] : undefined;
  const goNext = () => {
    if (isPending) return;
    if (totalCount === 0) return;
    if (selection === undefined) return;
    if (isLast) return;
    setIdx((i) => Math.min(totalCount - 1, i + 1));
  };
  const goPrev = () => {
    if (isPending) return;
    setIdx((i) => Math.max(0, i - 1));
  };

  // Spec 169 — swipe gestures. Left-swipe = next (gated by goNext);
  // right-swipe = previous (gated by goPrev). The hook honours the
  // same 80px / 40px / 400ms thresholds as the form runner so a
  // vertical scroll never registers as a swipe. `useSwipe` is SSR-safe
  // and a no-op on browsers without PointerEvent.
  const { ref: swipeRef, reducedMotion } = useSwipe<HTMLDivElement>(
    () => goNext(),
    () => goPrev(),
  );

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

  // After the early return above, currentQ is guaranteed non-undefined.
  const q = currentQ as MobileQuizRunnerQuestion;

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
    // Spec 159 — submittedRef guards against a race with the auto-
    // submit interval tick. If the user clicks Submit exactly at the
    // 0-second boundary we want exactly one server action, not two.
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
    <div
      ref={swipeRef}
      data-testid="mobile-quiz-runner"
      data-reduced-motion={reducedMotion ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "calc(100dvh - 120px)",
        // Allow vertical scroll natively; horizontal travel is the swipe.
        touchAction: "pan-y",
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
            style={{ display: "inline-flex", alignItems: "center", gap: 10 }}
          >
            {/* Spec 159 — countdown chip lives next to the question
                counter so it stays visible on the narrow mobile header
                without competing for the question prompt's vertical
                space. role="timer" + aria-live="polite" matches the
                desktop runner's a11y contract. */}
            {remaining !== null ? (
              <span
                data-testid="mobile-quiz-countdown"
                role="timer"
                aria-live="polite"
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background:
                    remaining < 60 ? "var(--rust-soft)" : "var(--paper-2)",
                  color: remaining < 60 ? "var(--rust)" : "var(--ink-2)",
                  border:
                    "1px solid " +
                    (remaining < 60 ? "var(--rust)" : "var(--line)"),
                }}
              >
                {formatRemaining(remaining)}
              </span>
            ) : null}
            <div
              className="mono"
              style={{ fontSize: 12, color: "var(--ink-3)" }}
            >
              {idx + 1} / {totalCount}
            </div>
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
          onClick={goPrev}
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
            onClick={goNext}
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
