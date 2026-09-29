// /admin/grading/rubrics/[id] — one observation rubric: its name, scale and
// criteria, whether observers score new observations with it (the default),
// switching it off, and deleting it -- refused while any observation has
// been scored against it.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { uuidOrNotFound } from "@/lib/ids";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import { SubmitButton } from "@/components/SubmitButton";
import { rubricDetail, scaleOptions } from "@/lib/grading/admin";
import { ActionForm } from "../../_ui/action-form";
import { CriteriaEditor } from "../../_ui/criteria-editor";
import {
  deleteRubricAction,
  saveCriteriaAction,
  saveRubricDetailsAction,
  setDefaultRubricAction,
  setRubricActiveAction,
} from "../../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("grading");
  return { title: t("rubric.metaTitle") };
}

const fieldLabel = { display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" } as const;

export default async function GradingRubricPage({ params }: { params: Promise<{ id: string }> }) {
  const id = uuidOrNotFound((await params).id);
  await requireRole(["programme_admin", "super_admin"]);
  const t = await getTranslations("grading");
  const rubric = await rubricDetail(db, id);
  if (!rubric) notFound();
  const scales = await scaleOptions(db, "observation");
  // The rubric's own scale may have been switched off since: still offer it.
  if (rubric.gradingScaleId && rubric.scaleName && !scales.some((s) => s.id === rubric.gradingScaleId)) {
    scales.push({ id: rubric.gradingScaleId, name: rubric.scaleName, isDefault: false });
  }

  const body = (
    <main>
      <div className="page-header">
        <Link href="/admin/grading" className="btn btn-sm btn-ghost" style={{ marginBottom: 6, marginLeft: -8 }}>
          {t("rubric.back")}
        </Link>
        <div className="label">{t("rubric.eyebrow")}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{rubric.name}</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {rubric.isDefault ? <span className="chip chip-lichen">{t("rubric.isDefault")}</span> : null}
          <span className={rubric.active ? "chip" : "chip chip-rust"}>{rubric.active ? t("admin.active") : t("admin.inactive")}</span>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 24, maxWidth: 820 }}>
        <section aria-labelledby="criteria-heading" className="card" style={{ padding: 14, display: "grid", gap: 10 }}>
          <h2 id="criteria-heading" style={{ fontSize: 16 }}>{t("rubric.criteriaHeading")}</h2>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>{t("rubric.criteriaHelp")}</p>
          {rubric.scoredCycles > 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: "var(--saffron)" }}>{t("rubric.scoredNote", { count: rubric.scoredCycles })}</p>
          ) : null}
          <CriteriaEditor
            rubricId={rubric.id}
            initial={rubric.criteria.map((c) => ({
              id: c.id,
              title: c.title,
              description: c.description,
              maxScore: c.maxScore,
              scored: c.scored,
            }))}
            action={saveCriteriaAction}
          />
        </section>

        <section aria-labelledby="details-heading" className="card" style={{ padding: 14, display: "grid", gap: 10 }}>
          <h2 id="details-heading" style={{ fontSize: 16 }}>{t("rubric.detailsHeading")}</h2>
          <ActionForm action={saveRubricDetailsAction} style={{ display: "grid", gap: 10, maxWidth: 480 }}>
            <input type="hidden" name="rubricId" value={rubric.id} />
            <label style={fieldLabel}>
              {t("form.name")}
              <input className="text" name="name" required maxLength={160} defaultValue={rubric.name} />
            </label>
            <label style={fieldLabel}>
              {t("form.description")}
              <textarea className="text" name="description" rows={2} defaultValue={rubric.description ?? ""} />
            </label>
            <label style={fieldLabel}>
              {t("form.scale")}
              <select className="text" name="gradingScaleId" defaultValue={rubric.gradingScaleId ?? ""}>
                <option value="">{t("form.defaultObservationScale")}</option>
                {scales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <SubmitButton className="btn btn-sm">{t("form.save")}</SubmitButton>
            </div>
          </ActionForm>
        </section>

        <section aria-labelledby="use-heading" className="card" style={{ padding: 14, display: "grid", gap: 12 }}>
          <h2 id="use-heading" style={{ fontSize: 16 }}>{t("rubric.useHeading")}</h2>
          {rubric.isDefault ? (
            <p style={{ margin: 0, fontSize: 13 }}>{t("rubric.defaultExplain")}</p>
          ) : rubric.active ? (
            <ActionForm action={setDefaultRubricAction}>
              <input type="hidden" name="rubricId" value={rubric.id} />
              <p style={{ margin: "0 0 6px", fontSize: 13 }}>{t("rubric.makeDefaultExplain")}</p>
              <SubmitButton className="btn btn-sm">{t("rubric.makeDefault")}</SubmitButton>
            </ActionForm>
          ) : null}
          <ActionForm action={setRubricActiveAction}>
            <input type="hidden" name="rubricId" value={rubric.id} />
            <input type="hidden" name="active" value={rubric.active ? "0" : "1"} />
            <p style={{ margin: "0 0 6px", fontSize: 13 }}>
              {rubric.active
                ? rubric.isDefault
                  ? t("rubric.deactivateDefaultExplain")
                  : t("rubric.deactivateExplain")
                : t("rubric.activateExplain")}
            </p>
            <SubmitButton className="btn btn-sm">{rubric.active ? t("scale.deactivate") : t("scale.activate")}</SubmitButton>
          </ActionForm>
        </section>

        <section aria-labelledby="delete-heading" className="card" style={{ padding: 14, display: "grid", gap: 8 }}>
          <h2 id="delete-heading" style={{ fontSize: 16 }}>{t("rubric.deleteHeading")}</h2>
          {rubric.scoredCycles > 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }} data-testid="rubric-delete-refused">
              {t("errors.rubric_scored", { cycles: rubric.scoredCycles })}
            </p>
          ) : (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>{t("rubric.deleteOpen")}</summary>
              <ActionForm action={deleteRubricAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="rubricId" value={rubric.id} />
                <p style={{ margin: "0 0 6px", fontSize: 13 }}>{t("rubric.deleteWarning", { count: rubric.criteria.length })}</p>
                <SubmitButton className="btn btn-sm" style={{ color: "var(--rust)" }}>
                  {t("rubric.deleteConfirm")}
                </SubmitButton>
              </ActionForm>
            </details>
          )}
        </section>
      </div>
    </main>
  );

  return (await getDeviceType()) === "mobile" ? (
    <MobileDetailFrame title={rubric.name} backHref="/admin/grading">
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}
