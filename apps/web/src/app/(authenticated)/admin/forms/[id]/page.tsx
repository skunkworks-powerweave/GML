// /admin/forms/[id] — JSON schema editor for a single feedback_forms row.
// Server component (role gate + initial fetch); the editor + preview are
// 'use client' children imported from ./parts. Save POSTs to /api/admin/forms/[id].

import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { feedbackForms } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { FormSchemaEditor, FormSchemaPreview } from "./parts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function AdminFormDetailPage({ params }: Props) {
  await requireRole(["programme_admin", "super_admin"]);
  const { id } = await params;

  const [row] = await db
    .select()
    .from(feedbackForms)
    .where(eq(feedbackForms.id, id))
    .limit(1);

  if (!row) notFound();

  const pretty = JSON.stringify(row.schema, null, 2);
  const titleFromSchema = extractTitle(row.schema) ?? `${row.kind} · ${row.audience}`;

  return (
    <main style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 28px" }}>
      <header style={{ marginBottom: 18 }}>
        <Link
          href="/admin/forms"
          style={{
            fontSize: 12,
            color: "var(--ink-3)",
            textDecoration: "none",
            marginBottom: 6,
            display: "inline-block",
          }}
        >
          ← Forms registry
        </Link>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          Form schema · {row.kind} · {row.audience}
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
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>
              {titleFromSchema}
            </h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 6 }}>
              Edit the raw JSON below. <strong>Save</strong> validates the JSON, bumps the
              version, and records the change in the audit log.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--ink-3)",
              }}
            >
              Current version
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 22,
                color: "var(--ink)",
                marginTop: 2,
              }}
            >
              v{row.version}
            </div>
            <span
              style={{
                display: "inline-block",
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontFamily: "var(--mono)",
                marginTop: 4,
                background: row.active ? "var(--lichen-soft)" : "var(--paper-2)",
                color: row.active ? "var(--lichen)" : "var(--ink-3)",
              }}
            >
              {row.active ? "active" : "inactive"}
            </span>
          </div>
        </div>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 18,
          alignItems: "start",
        }}
      >
        <FormSchemaEditor formId={row.id} initialSchema={pretty} initialVersion={row.version} />
        <FormSchemaPreview initialSchema={pretty} />
      </section>
    </main>
  );
}

function extractTitle(schema: unknown): string | null {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const t = (schema as { title?: unknown }).title;
    if (typeof t === "string" && t.trim().length > 0) return t;
  }
  return null;
}
