// /admin/forms — Admin registry editor for feedback_forms.
// Ports `LMS GML Frontend/forms.jsx::FormsRegistry` (lines 3-49) into a real
// Drizzle-backed admin surface gated to programme_admin + super_admin.
// Cards link to /admin/forms/[id] (JSON schema editor with live preview).
//
// Words are in the user's language (adminData.forms); a form's title from its
// schema is data, shown as the administrator wrote it.

import Link from "next/link";
import { asc, desc } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { feedbackForms } from "@gml/db/schema";
import type { Translate } from "@/admin/labels";
import { requireRole } from "@/lib/guards";
import { formEnumLabel } from "./labels";

export const dynamic = "force-dynamic";

// Kind → chip-color family (mirrors the JSX prototype's switch).
// feedback_kind enum values from spec 020: baseline / progress_1 / progress_2 / final.
const KIND_CHIP: Record<string, string> = {
  baseline: "chip chip-indigo",
  progress_1: "chip chip-lichen",
  progress_2: "chip chip-saffron",
  final: "chip chip-rust",
};

export default async function AdminFormsIndexPage() {
  await requireRole(["programme_admin", "super_admin"]);
  const t = await getTranslations("adminData");
  const tl = t as unknown as Translate;
  const audienceTitle = (value: string) => formEnumLabel(tl, "audienceTitle", value);
  const label = (group: Parameters<typeof formEnumLabel>[1], value: string) => formEnumLabel(tl, group, value);

  const rows = await db
    .select({
      id: feedbackForms.id,
      kind: feedbackForms.kind,
      audience: feedbackForms.audience,
      version: feedbackForms.version,
      active: feedbackForms.active,
      schema: feedbackForms.schema,
    })
    .from(feedbackForms)
    .orderBy(asc(feedbackForms.kind), asc(feedbackForms.audience), desc(feedbackForms.version));

  // Best-effort: try to extract a human title from the schema JSON (FormRunner reads
  // `form.title` per the JSX prototype). Falls back to the derived kind — audience.
  const titleFor = (kind: string, audience: string, schema: unknown): string => {
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
      const title = (schema as { title?: unknown }).title;
      if (typeof title === "string" && title.trim().length > 0) return title;
    }
    return t("forms.fallbackTitle", {
      kind: label("kindTitle", kind),
      audience: label("audience", audience),
    });
  };

  return (
    <main>
      <div className="page-header">
        <div className="label">{t("common.formsAndQuizzes")}</div>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginTop: 4,
          }}
        >
          <div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>
              {t("forms.title")}
            </h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640 }}>{t("forms.intro")}</p>
          </div>
          {/* Was a dead "New-form UI lands in spec 080" chip. The quiz
              registry had no link from anywhere in the product, so this is
              also the way in to it. */}
          <Link
            href="/admin/quizzes"
            className="chip"
            style={{ textDecoration: "none" }}
            title={t("forms.toQuizzesTitle")}
          >
            {t("forms.toQuizzes")}
          </Link>
        </div>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ overflow: "hidden" }}>
          <table className="t">
            <thead>
              <tr>
                <th>{t("forms.columns.title")}</th>
                <th>{t("forms.columns.kind")}</th>
                <th>{t("forms.columns.audience")}</th>
                <th>{t("forms.columns.version")}</th>
                <th>{t("forms.columns.active")}</th>
                <th style={{ textAlign: "right" }}>{"\u00a0"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{ padding: 36, textAlign: "center", color: "var(--ink-3)" }}
                  >
                    {t("forms.empty")}
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const chipClass = KIND_CHIP[r.kind] ?? "chip";
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link
                          href={`/admin/forms/${r.id}`}
                          style={{
                            color: "var(--ink)",
                            fontFamily: "var(--serif)",
                            fontSize: 16,
                            textDecoration: "none",
                          }}
                        >
                          {titleFor(r.kind, r.audience, r.schema)}
                        </Link>
                      </td>
                      <td>
                        <span className={chipClass}>{label("kind", r.kind)}</span>
                      </td>
                      <td style={{ color: "var(--ink-2)" }}>
                        <span title={audienceTitle(r.audience)}>
                          {label("audience", r.audience)}
                        </span>
                      </td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}>
                        v{r.version}
                      </td>
                      <td>
                        <span className={r.active ? "chip chip-lichen" : "chip"}>
                          {r.active ? t("common.active") : t("common.inactive")}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/admin/forms/${r.id}`}
                          style={{
                            fontSize: 12,
                            color: "var(--indigo)",
                            textDecoration: "none",
                            fontWeight: 500,
                          }}
                        >
                          {t("forms.editSchema")}
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p
          style={{
            marginTop: 14,
            fontSize: 11,
            color: "var(--ink-3)",
            fontFamily: "var(--mono)",
            background: "var(--paper-2)",
            padding: "6px 10px",
            borderRadius: "var(--r-2)",
            display: "inline-block",
          }}
        >
          {t("forms.footer", { count: rows.length })}
        </p>
      </div>
    </main>
  );
}
