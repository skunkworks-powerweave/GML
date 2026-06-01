// /forms/[slug] — universal feedback-form runner. Spec 074 (Phase 8).
//
// Slug format: `${kind}-${audience}-${version}`. There is no `slug` column on
// `feedback_forms`; the route resolves the URL through the existing
// (kind, audience, version) unique index. See specs/074-forms-runner/research.md.
//
// The runner is a server component; the only client surface is <FormRenderer>
// (spec 072), which owns autosave + field rendering. `submitFormAction` is a
// top-level `"use server"` action this file owns; it inserts into
// `feedback_responses`, deletes the matching draft, and fires `form.submit`
// audit, then redirects to /forms/[slug]/thanks.

import { redirect } from "next/navigation";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import {
  feedbackForms,
  feedbackResponses,
  formDrafts,
  type FeedbackForm,
} from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { FormRenderer } from "@/components/forms/FormRenderer";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Slug parsing — `${kind}-${audience}-${version}`.
//
// `kind` is a fixed enum (baseline | progress_1 | progress_2 | final).
// `audience` is a fixed enum (mentor | mentee).
// `version` is free-form (e.g. "1", "schoolvisit-1", "endline-1") and may
//   itself contain dashes — so we split on the first two dashes only.
// ---------------------------------------------------------------------------

type FeedbackKind = "baseline" | "progress_1" | "progress_2" | "final";
type FeedbackAudience = "mentor" | "mentee";

const KINDS: readonly FeedbackKind[] = ["baseline", "progress_1", "progress_2", "final"] as const;
const AUDIENCES: readonly FeedbackAudience[] = ["mentor", "mentee"] as const;

function parseSlug(
  slug: string,
): { kind: FeedbackKind; audience: FeedbackAudience; version: string } | null {
  // progress_1-mentor-1 → ["progress_1", "mentor", "1"]
  // baseline-mentor-schoolvisit-1 → ["baseline", "mentor", "schoolvisit-1"]
  const firstDash = slug.indexOf("-");
  if (firstDash < 0) return null;
  const kindRaw = slug.slice(0, firstDash);
  const rest = slug.slice(firstDash + 1);
  const secondDash = rest.indexOf("-");
  if (secondDash < 0) return null;
  const audienceRaw = rest.slice(0, secondDash);
  const versionRaw = rest.slice(secondDash + 1);
  if (!KINDS.includes(kindRaw as FeedbackKind)) return null;
  if (!AUDIENCES.includes(audienceRaw as FeedbackAudience)) return null;
  if (versionRaw.length === 0) return null;
  return {
    kind: kindRaw as FeedbackKind,
    audience: audienceRaw as FeedbackAudience,
    version: versionRaw,
  };
}

// ---------------------------------------------------------------------------
// Schema shape — feedback_forms.schema is `jsonb`. The seed scripts
// (packages/db/src/scripts/seed_forms_*.ts) write objects shaped like this.
// We don't validate exhaustively here; we render whatever the renderer is
// happy to take.
// ---------------------------------------------------------------------------

type FormSchemaShape = {
  title?: string;
  hindiTitle?: string;
  description?: string;
  fields?: Array<{
    name: string;
    kind: string;
    label?: string;
    hindiLabel?: string;
    required?: boolean;
    options?: string[];
    min?: number;
    max?: number;
    helpText?: string;
  }>;
  // schoolvisit/endline carry a "purpose" key in addition to kind+audience.
  purpose?: string;
};

function readSchema(form: FeedbackForm): FormSchemaShape {
  const raw = form.schema as unknown;
  if (raw && typeof raw === "object") return raw as FormSchemaShape;
  return {};
}

// ---------------------------------------------------------------------------
// Server action — wired into FormRenderer via `action={submitFormAction}`.
// Catalogue links must pass `?pairingId=...` so the response carries the
// schema-mandated FK; missing pairingId redirects back to the same slug with
// `?error=missing_pairing`.
// ---------------------------------------------------------------------------

export async function submitFormAction(formData: FormData): Promise<void> {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const formId = String(formData.get("__formId") ?? "").trim();
  const slug = String(formData.get("__slug") ?? "").trim();
  const pairingId = String(formData.get("__pairingId") ?? "").trim();

  if (!formId || !slug) {
    redirect(`/inbox?error=invalid_form_submit`);
  }
  if (!pairingId) {
    redirect(`/forms/${slug}?error=missing_pairing`);
  }

  // Pull the form back so we know which field ids to accept. Drop unknown keys.
  const [form] = await db
    .select()
    .from(feedbackForms)
    .where(eq(feedbackForms.id, formId))
    .limit(1);
  if (!form || !form.active) {
    redirect(`/inbox?error=form_not_found`);
  }

  const schema = readSchema(form);
  const fieldIds = new Set((schema.fields ?? []).map((f) => f.name));

  const responses: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("__")) continue; // internal pairs we own
    // Strip the trailing `[]` repeated-checkbox suffix on the way in.
    const cleanKey = key.endsWith("[]") ? key.slice(0, -2) : key;
    if (!fieldIds.has(cleanKey)) continue;
    const existing = responses[cleanKey];
    if (existing === undefined) {
      responses[cleanKey] = typeof value === "string" ? value : String(value);
    } else if (Array.isArray(existing)) {
      existing.push(typeof value === "string" ? value : String(value));
    } else {
      responses[cleanKey] = [String(existing), typeof value === "string" ? value : String(value)];
    }
  }

  let newResponseId = "";
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(feedbackResponses)
      .values({
        formId: form.id,
        pairingId,
        respondentUserId: userId,
        responses,
      })
      .returning({ id: feedbackResponses.id });
    newResponseId = inserted?.id ?? "";

    // Clear the autosave draft for this user+template, if any.
    await tx
      .delete(formDrafts)
      .where(and(eq(formDrafts.userId, userId), eq(formDrafts.templateId, form.id)));
  });

  // Best-effort audit (failure does not roll back the response).
  void recordAudit({
    action: "form.submit",
    entityType: "feedback_response",
    entityId: newResponseId,
    metadata: {
      formId: form.id,
      kind: form.kind,
      audience: form.audience,
      version: form.version,
    },
  });

  redirect(`/forms/${slug}/thanks`);
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function FormRunnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ pairingId?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const { slug } = await params;
  const sp = await searchParams;
  const pairingId = (sp.pairingId ?? "").trim();
  const error = (sp.error ?? "").trim();

  const parsed = parseSlug(slug);
  if (!parsed) return <NotFoundShell slug={slug} />;

  const [form] = await db
    .select()
    .from(feedbackForms)
    .where(
      and(
        eq(feedbackForms.kind, parsed.kind),
        eq(feedbackForms.audience, parsed.audience),
        eq(feedbackForms.version, parsed.version),
        eq(feedbackForms.active, true),
      ),
    )
    .limit(1);
  if (!form) return <NotFoundShell slug={slug} />;

  const [draft] = await db
    .select({ responses: formDrafts.responses, updatedAt: formDrafts.updatedAt })
    .from(formDrafts)
    .where(and(eq(formDrafts.userId, userId), eq(formDrafts.templateId, form.id)))
    .limit(1);

  const schema = readSchema(form);
  const title = schema.title ?? `${parsed.kind.replace("_", " ")} · ${parsed.audience}`;
  const hindiTitle = schema.hindiTitle;
  const description = schema.description;

  return (
    <div>
      <div className="page-header">
        <Link
          href="/inbox"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 6, textDecoration: "none" }}
        >
          ← Inbox
        </Link>
        <div className="label">
          Form · {parsed.kind.replace("_", " ")} · {parsed.audience}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4, lineHeight: 1.2 }}>
          {title}
          {hindiTitle ? (
            <span
              style={{
                fontFamily: "var(--deva)",
                color: "var(--ink-3)",
                marginLeft: 10,
                fontSize: 20,
              }}
            >
              {hindiTitle}
            </span>
          ) : null}
        </h1>
        {description ? (
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>{description}</p>
        ) : null}

        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          <span
            className="chip"
            style={{
              fontFamily: "var(--mono)",
              background: "var(--paper-2)",
              textTransform: "uppercase",
            }}
          >
            v{form.version}
          </span>
          {draft ? (
            <span className="chip chip-lichen">
              Draft loaded · saved{" "}
              <span className="mono">
                {new Date(draft.updatedAt).toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            </span>
          ) : (
            <span className="chip">No draft yet</span>
          )}
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 760, margin: "0 auto" }}>
        {error === "missing_pairing" ? (
          <div
            style={{
              background: "var(--rust-soft)",
              color: "var(--rust)",
              border: "1px solid var(--rust)",
              borderRadius: "var(--r-2)",
              padding: 12,
              fontSize: 13,
              marginBottom: 16,
            }}
            role="alert"
          >
            This form must be opened from your inbox so we can attach the
            response to the right mentorship pairing. Head back to{" "}
            <Link href="/inbox" style={{ color: "var(--indigo)" }}>
              your inbox
            </Link>{" "}
            and click the form card.
          </div>
        ) : null}

        <section
          className="card card-hi"
          style={{
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            padding: 20,
          }}
        >
          <FormRenderer
            schema={schema}
            initialResponses={(draft?.responses as Record<string, unknown> | undefined) ?? {}}
            draftKey={{ templateId: form.id }}
            action={submitFormAction}
            formId={form.id}
            slug={slug}
            pairingId={pairingId || null}
          />
        </section>

        <footer
          style={{
            marginTop: 20,
            fontSize: 11,
            color: "var(--ink-4)",
            lineHeight: 1.5,
          }}
        >
          Your responses are saved as you type (draft) and only sealed into the
          record when you press <em>Submit</em>. Until then you can navigate
          away and return without losing what you typed.
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-route 404 — keeps the global error boundary out of it.
// ---------------------------------------------------------------------------

function NotFoundShell({ slug }: { slug: string }) {
  return (
    <div className="page-body" style={{ maxWidth: 600, margin: "60px auto", textAlign: "center" }}>
      <div className="label">Form not found</div>
      <h1 className="serif" style={{ fontSize: 26, marginTop: 6 }}>
        No active form matches this URL.
      </h1>
      <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 8 }}>
        Slug <code className="mono">{slug}</code> doesn&apos;t resolve to any
        active <code className="mono">feedback_forms</code> row. Head back to
        your{" "}
        <Link href="/inbox" style={{ color: "var(--indigo)" }}>
          inbox
        </Link>{" "}
        and open the form from there.
      </p>
    </div>
  );
}
