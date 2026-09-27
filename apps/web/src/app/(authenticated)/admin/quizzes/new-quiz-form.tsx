"use client";

// Create a quiz. The product had no way to do this at all -- see actions.ts.
//
// Collapsed by default so the index still reads as a list of quizzes rather
// than a form, but one click from the empty state, which is where somebody with
// no quizzes actually is.
//
// Words: adminData.client.newQuiz, in the viewer's language.

import Link from "next/link";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("adminData.client");
  const tAction = useTranslations("action");

  if (!open) {
    return (
      <button type="button" className="chip" onClick={() => setOpen(true)} data-testid="new-quiz-open">
        {t("newQuiz.open")}
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
        {t("newQuiz.title")}
        <input
          name="title"
          required
          minLength={2}
          maxLength={200}
          style={field}
          placeholder={t("newQuiz.titlePlaceholder")}
        />
      </label>

      <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
        {t("newQuiz.address")}
        {/* i18n-ignore: the example is an address itself, lowercase ASCII as the pattern requires */}
        <input name="slug" maxLength={60} style={field} placeholder="mid-unit" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
        <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
          {t.rich("newQuiz.addressHelp", { ph: (chunks) => <>{"<"}{chunks}{">"}</> })}
        </span>
      </label>

      <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
        {t("newQuiz.passMark")}
        <input name="passThreshold" type="number" min={1} max={100} defaultValue={60} style={field} />
      </label>

      {/* Required because the database requires it: quizzes_one_scope refuses
          a quiz bound to no subject, and without this field every create
          failed with a generic "try again". */}
      <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
        {t("newQuiz.subject")}
        <select name="rttSubjectId" required defaultValue="" style={field} disabled={subjects.length === 0}>
          <option value="" disabled>
            {t("newQuiz.chooseSubject")}
          </option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {subjects.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--rust)" }}>
            {t.rich("newQuiz.noSubjects", {
              link: (chunks) => <Link href="/admin/data/rtt-subjects">{chunks}</Link>,
            })}
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
          {pending ? t("newQuiz.creating") : t("newQuiz.create")}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          {tAction("cancel")}
        </button>
      </div>

      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>{t("newQuiz.note")}</span>
    </form>
  );
}
