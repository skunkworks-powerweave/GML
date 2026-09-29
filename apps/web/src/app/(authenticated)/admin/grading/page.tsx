// /admin/grading — grade scales and observation rubrics.
//
// Programme admins and super admins define the scales that turn a percentage
// into a grade (students' test marks, quiz results, observation totals) and
// the rubrics observers score. This index lists both, marks the default of
// each kind, and creates new ones; each opens its own editor:
// ./scales/[id] (bands) and ./rubrics/[id] (criteria). The writes are
// ./actions.ts over lib/grading/admin.ts. Words: grading.admin.*.

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { GRADING_TARGETS } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { listRubrics, listScales, scaleOptions } from "@/lib/grading/admin";
import { SubmitButton } from "@/components/SubmitButton";
import { ActionForm } from "./_ui/action-form";
import { createRubricAction, createScaleAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("grading");
  return { title: t("admin.metaTitle") };
}

const fieldLabel = { display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" } as const;

export default async function GradingAdminPage({ searchParams }: { searchParams?: Promise<{ deleted?: string }> }) {
  await requireRole(["programme_admin", "super_admin"]);
  const t = await getTranslations("grading");
  const sp = searchParams ? await searchParams : {};
  const [scales, rubrics, observationScales] = await Promise.all([listScales(db), listRubrics(db), scaleOptions(db, "observation")]);

  return (
    <main>
      <div className="page-header">
        <div className="label">{t("admin.eyebrow")}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{t("admin.title")}</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 6, fontSize: 13, lineHeight: 1.5, maxWidth: 720 }}>{t("admin.intro")}</p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 28, maxWidth: 960 }}>
        {sp.deleted === "scale" || sp.deleted === "rubric" ? (
          <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--lichen)" }}>
            {sp.deleted === "scale" ? t("done.scaleDeleted") : t("done.rubricDeleted")}
          </p>
        ) : null}

        <section aria-labelledby="scales-heading" style={{ display: "grid", gap: 12 }}>
          <h2 id="scales-heading" style={{ fontSize: 17 }}>{t("admin.scalesHeading")}</h2>
          {GRADING_TARGETS.map((kind) => {
            const mine = scales.filter((s) => s.appliesTo === kind);
            return (
              <div key={kind} className="card" style={{ padding: 14 }} data-testid={`scales-${kind}`}>
                <h3 style={{ fontSize: 14, marginBottom: 4 }}>{t(`kinds.${kind}`)}</h3>
                <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--ink-3)" }}>{t(`kindHelp.${kind}`)}</p>
                {mine.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 13, color: "var(--ink-3)" }}>{t("admin.noScales")}</p>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                    {mine.map((s) => (
                      <li key={s.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        <Link href={`/admin/grading/scales/${s.id}`} style={{ fontWeight: 500 }}>
                          {s.name}
                        </Link>
                        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("admin.bandCount", { count: s.bandCount })}</span>
                        {s.isDefault ? <span className="chip chip-lichen">{t("admin.default")}</span> : null}
                        {!s.active ? <span className="chip">{t("admin.inactive")}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}

          <details className="card" style={{ padding: 14 }}>
            <summary style={{ cursor: "pointer", fontWeight: 500 }}>{t("admin.newScale")}</summary>
            <ActionForm action={createScaleAction} style={{ display: "grid", gap: 10, marginTop: 12, maxWidth: 480 }} testId="new-scale-form">
              <label style={fieldLabel}>
                {t("form.name")}
                <input className="text" name="name" required maxLength={120} />
              </label>
              <label style={fieldLabel}>
                {t("form.appliesTo")}
                <select className="text" name="appliesTo" required defaultValue="">
                  <option value="" disabled>
                    {t("form.choose")}
                  </option>
                  {GRADING_TARGETS.map((k) => (
                    <option key={k} value={k}>
                      {t(`kinds.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                {t("form.description")}
                <textarea className="text" name="description" rows={2} />
              </label>
              <div>
                <SubmitButton className="btn btn-primary btn-sm">{t("form.createScale")}</SubmitButton>
              </div>
            </ActionForm>
          </details>
        </section>

        <section aria-labelledby="rubrics-heading" style={{ display: "grid", gap: 12 }}>
          <h2 id="rubrics-heading" style={{ fontSize: 17 }}>{t("admin.rubricsHeading")}</h2>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)" }}>{t("admin.rubricsHelp")}</p>
          <div className="card" style={{ padding: 14 }} data-testid="rubrics">
            {rubrics.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: "var(--ink-3)" }}>{t("admin.noRubrics")}</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                {rubrics.map((r) => (
                  <li key={r.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <Link href={`/admin/grading/rubrics/${r.id}`} style={{ fontWeight: 500 }}>
                      {r.name}
                    </Link>
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                      {t("admin.criterionCount", { count: r.criterionCount, total: r.maxTotal })}
                    </span>
                    {r.isDefault ? <span className="chip chip-lichen">{t("admin.default")}</span> : null}
                    {!r.active ? <span className="chip">{t("admin.inactive")}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <details className="card" style={{ padding: 14 }}>
            <summary style={{ cursor: "pointer", fontWeight: 500 }}>{t("admin.newRubric")}</summary>
            <ActionForm action={createRubricAction} style={{ display: "grid", gap: 10, marginTop: 12, maxWidth: 480 }} testId="new-rubric-form">
              <label style={fieldLabel}>
                {t("form.name")}
                <input className="text" name="name" required maxLength={160} />
              </label>
              <label style={fieldLabel}>
                {t("form.description")}
                <textarea className="text" name="description" rows={2} />
              </label>
              <label style={fieldLabel}>
                {t("form.scale")}
                <select className="text" name="gradingScaleId" defaultValue="">
                  <option value="">{t("form.defaultObservationScale")}</option>
                  {observationScales.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" name="makeDefault" value="1" />
                {t("form.makeDefaultRubric")}
              </label>
              <div>
                <SubmitButton className="btn btn-primary btn-sm">{t("form.createRubric")}</SubmitButton>
              </div>
            </ActionForm>
          </details>
        </section>
      </div>
    </main>
  );
}
