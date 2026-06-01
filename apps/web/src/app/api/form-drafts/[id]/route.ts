// Spec 072 — Per-user form-draft autosave API.
//
//   GET     /api/form-drafts/[id]?scope=template|cycle  → returns the draft row
//   PUT     /api/form-drafts/[id]?scope=template|cycle  → upserts the row
//   DELETE  /api/form-drafts/[id]?scope=template|cycle  → removes the row
//
// All operations are scoped to the authenticated user. The DB has partial-unique
// indices on (user_id, template_id) and (user_id, observation_cycle_id), so the
// onConflict targets compose cleanly.
//
// PUT + DELETE write best-effort audit events. Audit insert failure NEVER fails
// the user-facing call — matches `recordAudit`'s existing contract.

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { formDrafts } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ScopeSchema = z.enum(["template", "cycle"]);

const PutBodySchema = z.object({
  // jsonb — we don't constrain its inner shape here; the form's own schema is
  // the contract. We just guarantee it parses to an object.
  responses: z.record(z.unknown()),
});

type RouteCtx = { params: Promise<{ id: string }> };

function parseScope(req: Request): "template" | "cycle" | null {
  const scopeParam = new URL(req.url).searchParams.get("scope");
  const parsed = ScopeSchema.safeParse(scopeParam);
  return parsed.success ? parsed.data : null;
}

async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session.user.id;
}

export async function GET(req: Request, ctx: RouteCtx) {
  const userId = await requireSession();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const scope = parseScope(req);
  if (!scope) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  const { id } = await ctx.params;

  const where =
    scope === "template"
      ? and(eq(formDrafts.userId, userId), eq(formDrafts.templateId, id))
      : and(eq(formDrafts.userId, userId), eq(formDrafts.observationCycleId, id));

  const [row] = await db.select().from(formDrafts).where(where).limit(1);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    id: row.id,
    scope,
    responses: row.responses,
    updatedAt: row.updatedAt,
  });
}

export async function PUT(req: Request, ctx: RouteCtx) {
  const userId = await requireSession();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const scope = parseScope(req);
  if (!scope) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const responses = parsed.data.responses;
  const now = new Date();

  if (scope === "template") {
    await db
      .insert(formDrafts)
      .values({ userId, templateId: id, responses, updatedAt: now })
      .onConflictDoUpdate({
        // Partial-unique index `form_drafts_user_template_uq` covers
        // (user_id, template_id) WHERE template_id IS NOT NULL. Drizzle accepts
        // the column list + a `targetWhere` predicate.
        target: [formDrafts.userId, formDrafts.templateId],
        targetWhere: sql`${formDrafts.templateId} IS NOT NULL`,
        set: { responses, updatedAt: now },
      });
  } else {
    await db
      .insert(formDrafts)
      .values({ userId, observationCycleId: id, responses, updatedAt: now })
      .onConflictDoUpdate({
        target: [formDrafts.userId, formDrafts.observationCycleId],
        targetWhere: sql`${formDrafts.observationCycleId} IS NOT NULL`,
        set: { responses, updatedAt: now },
      });
  }

  void recordAudit({
    action: "form.draft.save",
    entityType: "form_drafts",
    entityId: id,
    metadata: { scope, fieldCount: Object.keys(responses).length },
  });

  return NextResponse.json({ ok: true, updatedAt: now.toISOString() });
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const userId = await requireSession();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const scope = parseScope(req);
  if (!scope) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  const { id } = await ctx.params;

  const where =
    scope === "template"
      ? and(eq(formDrafts.userId, userId), eq(formDrafts.templateId, id))
      : and(eq(formDrafts.userId, userId), eq(formDrafts.observationCycleId, id));

  const deleted = await db.delete(formDrafts).where(where).returning({ id: formDrafts.id });

  void recordAudit({
    action: "form.draft.clear",
    entityType: "form_drafts",
    entityId: id,
    metadata: { scope, removed: deleted.length },
  });

  if (deleted.length === 0) {
    return NextResponse.json({ ok: true, removed: 0 }, { status: 404 });
  }
  return NextResponse.json({ ok: true, removed: deleted.length });
}
