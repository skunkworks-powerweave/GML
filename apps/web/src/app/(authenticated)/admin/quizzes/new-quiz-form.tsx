"use client";

// Create a quiz. The product had no way to do this at all -- see actions.ts.
//
// Collapsed by default so the index still reads as a list of quizzes rather
// than a form, but one click from the empty state, which is where somebody with
// no quizzes actually is.

import Link from "next/link";
import { useActionState, useState } from "react";
import { createQuizAction, type CreateQuizState } from "./actions";

const field: React.CSSProperties = {
  padding: "7px 9px",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--r-2, 6px)",
  background: "var(--card)",
  fontSize: 13,
  width: "100%",
};

/** An RTT subject a quiz can be bound to, labelled with its phase and term. */
export type QuizScopeOption = { id: string; label: string };

export function NewQuizForm({
  startOpen = false,
  subjects,
}: {
  startOpen?: boolean;
  subjects: QuizScopeOption[];
}) {
  const [open, setOpen] = useState(startOpen);
  const [state, formAction, pending] = useActionState<CreateQuizState, FormData>(
    createQuizAction,
    undefined,
  );

  if (!open) {
    return (
      <button type="button" className="chip" onClick={() => setOpen(true)} data-testid="new-quiz-open">
        + New quiz
      </button>
    );
  }

  return (
    <form
      action={formAction}
      style={{ display: "grid", gap: 8, maxWidth: 420 }}
      data-testid="new-quiz-form"
    >
      <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
        Title
        <input name="title" required minLength={2} maxLength={200} style={field} placeholder="Mid-unit check" />
      </label>

      <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
        Address (optional)
        <input name="slug" maxLength={60} style={field} placeholder="mid-unit" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
        <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
          Appears in the link learners open: /quizzes/&lt;address&gt;. Left blank, it is taken
          from the title. The RTT subject pages expect <code>mid-unit</code> and{" "}
          <code>endline</code>.
        </span>
      </label>

      <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
        Pass mark (%)
        <input name="passThreshold" type="number" min={1} max={100} defaultValue={60} style={field} />
      </label>

      {/* Required because the database requires it: quizzes_one_scope refuses
          a quiz bound to no subject, and without this field every create
          failed with a generic "try again". */}
      <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
        RTT subject
        <select name="rttSubjectId" required defaultValue="" style={field} disabled={subjects.length === 0}>
          <option value="" disabled>
            Choose the subject this quiz assesses
          </option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {subjects.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--rust)" }}>
            A quiz belongs to an RTT subject, and there are none yet. Create one in{" "}
            <Link href="/admin/data/rtt-subjects">RTT subjects</Link> first.
          </span>
        ) : null}
      </label>

      {state?.error ? (
        <span role="alert" style={{ fontSize: 11, color: "var(--rust)" }}>
          {state.error}
        </span>
      ) : null}

      <div style={{ display: "flex", gap: 6 }}>
        <button type="submit" className="btn btn-sm" disabled={pending || subjects.length === 0}>
          {pending ? "Creating…" : "Create quiz"}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
        Created inactive and empty. You add questions on the next screen, then switch it on —
        so a half-built quiz is never served to a learner.
      </span>
    </form>
  );
}
