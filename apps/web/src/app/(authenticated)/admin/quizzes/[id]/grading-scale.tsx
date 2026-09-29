// The "Grading scale" setting of the admin quiz editor: which quiz scale turns
// a result's score into a grade (shown next to pass/fail on the result and
// history pages). Blank means the default quiz scale. Saved by
// setQuizScaleAction (admin/grading/actions.ts), audited as
// grading.quiz.scale_set. Words: grading.quiz.*.
//
// A loader the page awaits, returning plain elements, rather than an async
// component in the page's tree: the editor page renders synchronously
// everywhere else, and an async child would suspend it.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { scaleOptions } from "@/lib/grading/admin";
import { resolveScale } from "@/lib/grading/scales";
import { SubmitButton } from "@/components/SubmitButton";
import { ActionForm } from "@/app/(authenticated)/admin/grading/_ui/action-form";
import { setQuizScaleAction } from "@/app/(authenticated)/admin/grading/actions";

export async function quizGradingScale(quizId: string, current: string | null) {
  const t = await getTranslations("grading");
  const options = await scaleOptions(db, "quiz");
  const defaultScale = options.find((s) => s.isDefault);
  // The quiz's own scale, even if it has been switched off since it was chosen.
  if (current && !options.some((s) => s.id === current)) {
    const named = await resolveScale(db, "quiz", current);
    if (named && named.id === current) options.push({ id: named.id, name: named.name, isDefault: false });
  }

  return (
    <section
      aria-labelledby="quiz-scale-heading"
      data-testid="quiz-grading-scale"
      style={{ border: "1px solid var(--line)", borderRadius: "var(--r-2)", padding: "12px 14px", display: "grid", gap: 8 }}
    >
      <h2 id="quiz-scale-heading" style={{ fontSize: 14 }}>{t("quiz.editorHeading")}</h2>
      <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
        {t.rich("quiz.editorHelp", { link: (chunks) => <Link href="/admin/grading">{chunks}</Link> })}
      </p>
      <ActionForm action={setQuizScaleAction} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
        <input type="hidden" name="quizId" value={quizId} />
        <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)", minWidth: 220, flex: "1 1 220px" }}>
          {t("quiz.scaleLabel")}
          <select className="text" name="gradingScaleId" defaultValue={current ?? ""}>
            <option value="">
              {defaultScale ? t("quiz.useDefault", { name: defaultScale.name }) : t("quiz.useDefaultNone")}
            </option>
            {options
              .filter((s) => !s.isDefault)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            {defaultScale ? <option value={defaultScale.id}>{t("quiz.always", { name: defaultScale.name })}</option> : null}
          </select>
        </label>
        <SubmitButton className="btn btn-sm">{t("form.save")}</SubmitButton>
      </ActionForm>
    </section>
  );
}
