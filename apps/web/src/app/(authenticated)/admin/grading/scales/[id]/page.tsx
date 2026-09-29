// /admin/grading/scales/[id] — one grade scale: its name, its bands (with the
// gaps and overlaps they leave), whether it is the default for what it
// grades, switching it off, and deleting it (refused while anything names it).

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
import { scaleDetail, scaleUsage } from "@/lib/grading/admin";
import { scaleProblems } from "@/lib/grading/bands";
import { formatRanges } from "@/lib/grading/format";
import { ActionForm } from "../../_ui/action-form";
import { BandsEditor } from "../../_ui/bands-editor";
import {
  deleteScaleAction,
  saveBandsAction,
  saveScaleDetailsAction,
  setDefaultScaleAction,
  setScaleActiveAction,
} from "../../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("grading");
  return { title: t("scale.metaTitle") };
}

const fieldLabel = { display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" } as const;

export default async function GradingScalePage({ params }: { params: Promise<{ id: string }> }) {
  const id = uuidOrNotFound((await params).id);
  await requireRole(["programme_admin", "super_admin"]);
  const t = await getTranslations("grading");
  const scale = await scaleDetail(db, id);
  if (!scale) notFound();
  const usage = await scaleUsage(db, id);
  const inUse = usage.assessments + usage.quizzes + usage.rubrics;
  const problems = scale.bands.length ? scaleProblems(scale.bands) : null;
  const kind = t(`kinds.${scale.appliesTo}`);

  const body = (
    <main>
      <div className="page-header">
        <Link href="/admin/grading" className="btn btn-sm btn-ghost" style={{ marginBottom: 6, marginLeft: -8 }}>
          {t("scale.back")}
        </Link>
        <div className="label">{t("scale.eyebrow", { kind })}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{scale.name}</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {scale.isDefault ? <span className="chip chip-lichen">{t("scale.isDefault", { kind })}</span> : null}
          <span className={scale.active ? "chip" : "chip chip-rust"}>{scale.active ? t("admin.active") : t("admin.inactive")}</span>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 24, maxWidth: 820 }}>
        <section aria-labelledby="bands-heading" className="card" style={{ padding: 14, display: "grid", gap: 10 }}>
          <h2 id="bands-heading" style={{ fontSize: 16 }}>{t("scale.bandsHeading")}</h2>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>{t("scale.bandsHelp")}</p>
          {problems ? (
            problems.gaps.length || problems.overlaps.length ? (
              <div role="note" data-testid="saved-problems" style={{ fontSize: 13, color: "var(--saffron)", display: "grid", gap: 4 }}>
                {problems.gaps.length ? <span>{t("scale.gaps", { list: formatRanges(problems.gaps) })}</span> : null}
                {problems.overlaps.length ? <span>{t("scale.overlaps", { list: formatRanges(problems.overlaps) })}</span> : null}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: "var(--lichen)" }}>{t("scale.complete")}</p>
            )
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "var(--saffron)" }}>{t("scale.noBands")}</p>
          )}
          <BandsEditor
            scaleId={scale.id}
            initial={scale.bands.map((b) => ({ label: b.label, minPct: b.minPct, maxPct: b.maxPct, isPass: b.isPass }))}
            action={saveBandsAction}
          />
        </section>

        <section aria-labelledby="details-heading" className="card" style={{ padding: 14, display: "grid", gap: 10 }}>
          <h2 id="details-heading" style={{ fontSize: 16 }}>{t("scale.detailsHeading")}</h2>
          <ActionForm action={saveScaleDetailsAction} style={{ display: "grid", gap: 10, maxWidth: 480 }}>
            <input type="hidden" name="scaleId" value={scale.id} />
            <label style={fieldLabel}>
              {t("form.name")}
              <input className="text" name="name" required maxLength={120} defaultValue={scale.name} />
            </label>
            <label style={fieldLabel}>
              {t("form.description")}
              <textarea className="text" name="description" rows={2} defaultValue={scale.description ?? ""} />
            </label>
            <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)" }}>{t("scale.kindFixed", { kind })}</p>
            <div>
              <SubmitButton className="btn btn-sm">{t("form.save")}</SubmitButton>
            </div>
          </ActionForm>
        </section>

        <section aria-labelledby="use-heading" className="card" style={{ padding: 14, display: "grid", gap: 12 }}>
          <h2 id="use-heading" style={{ fontSize: 16 }}>{t("scale.useHeading")}</h2>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }} data-testid="scale-usage">
            {t("scale.usage", usage)}
          </p>
          {scale.isDefault ? (
            <p style={{ margin: 0, fontSize: 13 }}>{t("scale.defaultExplain", { kind })}</p>
          ) : scale.active ? (
            <ActionForm action={setDefaultScaleAction}>
              <input type="hidden" name="scaleId" value={scale.id} />
              <p style={{ margin: "0 0 6px", fontSize: 13 }}>{t("scale.makeDefaultExplain", { kind })}</p>
              <SubmitButton className="btn btn-sm">{t("scale.makeDefault")}</SubmitButton>
            </ActionForm>
          ) : null}
          <ActionForm action={setScaleActiveAction}>
            <input type="hidden" name="scaleId" value={scale.id} />
            <input type="hidden" name="active" value={scale.active ? "0" : "1"} />
            <p style={{ margin: "0 0 6px", fontSize: 13 }}>
              {scale.active ? (scale.isDefault ? t("scale.deactivateDefaultExplain") : t("scale.deactivateExplain")) : t("scale.activateExplain")}
            </p>
            <SubmitButton className="btn btn-sm">{scale.active ? t("scale.deactivate") : t("scale.activate")}</SubmitButton>
          </ActionForm>
        </section>

        <section aria-labelledby="delete-heading" className="card" style={{ padding: 14, display: "grid", gap: 8 }}>
          <h2 id="delete-heading" style={{ fontSize: 16 }}>{t("scale.deleteHeading")}</h2>
          {inUse > 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>{t("errors.scale_in_use", usage)}</p>
          ) : (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>{t("scale.deleteOpen")}</summary>
              <ActionForm action={deleteScaleAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="scaleId" value={scale.id} />
                <p style={{ margin: "0 0 6px", fontSize: 13 }}>{t("scale.deleteWarning", { count: scale.bands.length })}</p>
                <SubmitButton className="btn btn-sm" style={{ color: "var(--rust)" }}>
                  {t("scale.deleteConfirm")}
                </SubmitButton>
              </ActionForm>
            </details>
          )}
        </section>
      </div>
    </main>
  );

  return (await getDeviceType()) === "mobile" ? (
    <MobileDetailFrame title={scale.name} backHref="/admin/grading">
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}
