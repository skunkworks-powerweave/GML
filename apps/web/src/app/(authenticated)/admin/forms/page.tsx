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

// Kind → colour family (mirrors the JSX prototype's switch).
// feedback_kind enum values from spec 020: baseline / progress_1 / progress_2 / final.
// All are mentor-cycle feedback variants → keep indigo as the family colour, vary depth.
const KIND_COLOR: Record<string, { bg: string; ink: string }> = {
  baseline: { bg: "var(--indigo-soft)", ink: "var(--indigo)" },
  progress_1: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  progress_2: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  final: { bg: "var(--rust-soft)", ink: "var(--rust)" },
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
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 28px" }}>
      <header style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          Forms & Quizzes
        </div>
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
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, margin: 0 }}>
              Programme forms
            </h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 6, maxWidth: 640 }}>
              Forms are defined as JSON schemas — admins compose them; teachers and mentors fill
              them. Editing a schema bumps the version and is recorded in the audit log.
            </p>
          </div>
          <span
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              fontFamily: "var(--mono)",
              padding: "4px 10px",
              borderRadius: "var(--r-2)",
              border: "1px dashed var(--line)",
              background: "var(--paper-2)",
            }}
            title="Creating new forms is gated to direct seed/SQL in v1."
          >
            New-form UI lands in spec 080
          </span>
        </div>
      </header>

      <section
        style={{
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr
              style={{
                background: "var(--paper-2)",
                textAlign: "left",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--ink-3)",
              }}
            >
              <th style={{ padding: "10px 14px", fontWeight: 600 }}>Title</th>
              <th style={{ padding: "10px 14px", fontWeight: 600 }}>Kind</th>
              <th style={{ padding: "10px 14px", fontWeight: 600 }}>Audience</th>
              <th style={{ padding: "10px 14px", fontWeight: 600 }}>Version</th>
              <th style={{ padding: "10px 14px", fontWeight: 600 }}>Active</th>
              <th style={{ padding: "10px 14px", fontWeight: 600, textAlign: "right" }}>
                &nbsp;
              </th>
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
                const color = KIND_COLOR[r.kind] ?? {
                  bg: "var(--paper-2)",
                  ink: "var(--ink-3)",
                };
                return (
                  <tr
                    key={r.id}
                    style={{
                      borderTop: "1px solid var(--hairline)",
                    }}
                  >
                    <td style={{ padding: "12px 14px" }}>
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
                    <td style={{ padding: "12px 14px" }}>
                      <span
                        style={{
                          display: "inline-block",
                          background: color.bg,
                          color: color.ink,
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontFamily: "var(--mono)",
                        }}
                      >
                        {r.kind}
                      </span>
                    </td>
                    <td style={{ padding: "12px 14px", color: "var(--ink-2)" }}>
                      <span title={AUDIENCE_LABEL[r.audience] ?? r.audience}>{r.audience}</span>
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--ink-2)",
                      }}
                    >
                      v{r.version}
                    </td>
                    <td style={{ padding: "12px 14px" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontFamily: "var(--mono)",
                          background: r.active ? "var(--lichen-soft)" : "var(--paper-2)",
                          color: r.active ? "var(--lichen)" : "var(--ink-3)",
                        }}
                      >
                        {r.active ? "active" : "inactive"}
                      </span>
                    </td>
                    <td style={{ padding: "12px 14px", textAlign: "right" }}>
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
      </section>

      <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
        {rows.length} form{rows.length === 1 ? "" : "s"} · ordered by kind, audience, version desc
      </p>
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
