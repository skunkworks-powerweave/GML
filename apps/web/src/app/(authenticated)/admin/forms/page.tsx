// /admin/forms — Admin registry editor for feedback_forms.
// Ports `LMS GML Frontend/forms.jsx::FormsRegistry` (lines 3-49) into a real
// Drizzle-backed admin surface gated to programme_admin + super_admin.
// Cards link to /admin/forms/[id] (JSON schema editor with live preview).

import Link from "next/link";
import { asc, desc } from "drizzle-orm";
import { db } from "@gml/db";
import { feedbackForms } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";

export const dynamic = "force-dynamic";

// Kind → chip-color family (mirrors the JSX prototype's switch).
// feedback_kind enum values from spec 020: baseline / progress_1 / progress_2 / final.
const KIND_CHIP: Record<string, string> = {
  baseline: "chip chip-indigo",
  progress_1: "chip chip-lichen",
  progress_2: "chip chip-saffron",
  final: "chip chip-rust",
};

const AUDIENCE_LABEL: Record<string, string> = {
  mentor: "Filled by mentor",
  mentee: "Filled by mentee (teacher)",
};

export default async function AdminFormsIndexPage() {
  await requireRole(["programme_admin", "super_admin"]);

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
  // `form.title` per the JSX prototype). Falls back to the derived `${kind} · ${audience}`.
  const titleFor = (kind: string, audience: string, schema: unknown): string => {
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
      const t = (schema as { title?: unknown }).title;
      if (typeof t === "string" && t.trim().length > 0) return t;
    }
    return `${prettyKind(kind)} — ${audience}`;
  };

  return (
    <main>
      <div className="page-header">
        <div className="label">Forms & Quizzes</div>
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
              Programme forms
            </h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640 }}>
              Forms are defined as JSON schemas — admins compose them; teachers and mentors fill
              them. Editing a schema bumps the version and is recorded in the audit log.
            </p>
          </div>
          <span
            className="chip"
            title="Creating new forms is gated to direct seed/SQL in v1."
          >
            New-form UI lands in spec 080
          </span>
        </div>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ overflow: "hidden" }}>
          <table className="t">
            <thead>
              <tr>
                <th>Title</th>
                <th>Kind</th>
                <th>Audience</th>
                <th>Version</th>
                <th>Active</th>
                <th style={{ textAlign: "right" }}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{ padding: 36, textAlign: "center", color: "var(--ink-3)" }}
                  >
                    No feedback forms seeded yet. Run the migration seeder or insert via SQL.
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
                        <span className={chipClass}>{r.kind}</span>
                      </td>
                      <td style={{ color: "var(--ink-2)" }}>
                        <span title={AUDIENCE_LABEL[r.audience] ?? r.audience}>{r.audience}</span>
                      </td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}>
                        v{r.version}
                      </td>
                      <td>
                        <span className={r.active ? "chip chip-lichen" : "chip"}>
                          {r.active ? "active" : "inactive"}
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
                          Edit schema →
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
          {rows.length} form{rows.length === 1 ? "" : "s"} · ordered by kind, audience, version desc
        </p>
      </div>
    </main>
  );
}

function prettyKind(k: string): string {
  switch (k) {
    case "baseline":
      return "Baseline";
    case "progress_1":
      return "Progress (Q1 → Q2)";
    case "progress_2":
      return "Progress (Q3 → Q4)";
    case "final":
      return "Final";
    default:
      return k;
  }
}
