// Spec 072 — Per-user form-draft autosave API.
//
//   GET     /api/form-drafts/[id]?scope=template|cycle  → returns the draft row
//   PUT     /api/form-drafts/[id]?scope=template|cycle  → upserts the row
//   DELETE  /api/form-drafts/[id]?scope=template|cycle  → removes the row
//
// All operations are scoped to the authenticated user. A template draft is
// also scoped to the PAIRING it is about (`&pairingId=`), because a mentor
// fills the same form once per mentee; see lib/forms/drafts.ts. The DB has
// partial-unique indices on (user_id, template_id, pairing_id) -- NULLS NOT
// DISTINCT -- and (user_id, observation_cycle_id), so the onConflict targets
// compose cleanly.
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
import { actorFrom, type Actor } from "@/lib/visibility";
import { pairingDraftAccess, templateDraftWhere } from "@/lib/forms/drafts";

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

async function requireSession(): Promise<Actor | null> {
  return actorFrom(await auth());
}

/**
 * The pairing a template draft is about, from `?pairingId=`, or null for a
 * form opened without one. A response is returned instead when the caller may
 * not keep a draft about that pairing: 403 while the mentorship section is
 * locked, 404 for a pairing that is malformed, absent or someone else's.
 */
async function draftPairing(req: Request, actor: Actor): Promise<string | null | NextResponse> {
  const pairingId = new URL(req.url).searchParams.get("pairingId");
  if (!pairingId) return null;
  const access = await pairingDraftAccess(db, actor, pairingId);
  if (access === "locked") return NextResponse.json({ error: "section_locked" }, { status: 403 });
  if (access === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  return pairingId;
}

export async function GET(req: Request, ctx: RouteCtx) {
  const actor = await requireSession();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = actor.id;
  const scope = parseScope(req);
  if (!scope) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  const { id } = await ctx.params;
  const pairingId = scope === "template" ? await draftPairing(req, actor) : null;
  if (pairingId instanceof NextResponse) return pairingId;

  const where =
    scope === "template"
      ? templateDraftWhere(userId, id, pairingId)
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
  const actor = await requireSession();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = actor.id;
  const scope = parseScope(req);
  if (!scope) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  const { id } = await ctx.params;
  const pairingId = scope === "template" ? await draftPairing(req, actor) : null;
  if (pairingId instanceof NextResponse) return pairingId;

  // Spec 154 (audit-closure MEDIUM) — the pre-fix shape was
  // `await req.json().catch(() => ({}))` which silently collapsed malformed
  // payloads into an empty body and then routed them through the Zod schema.
  // For the existing draft writers (a fetch from the client always sends a
  // well-formed payload) the empty-object path triggered the validation
  // branch below and the user saw a generic 400. But the swallow also hid
  // genuine client bugs (truncated requests, content-encoding mismatches)
  // behind that same 400. We now surface the parse failure as its own
  // explicit `invalid_json` token so the client / observability tooling
  // can distinguish a wire-level failure from a schema-level one.
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_json", message: String(err) },
      { status: 400 },
    );
  }
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
      .values({ userId, templateId: id, pairingId, responses, updatedAt: now })
      .onConflictDoUpdate({
        // Partial-unique index `form_drafts_user_template_pairing_uq` covers
        // (user_id, template_id, pairing_id) NULLS NOT DISTINCT WHERE
        // template_id IS NOT NULL, so a draft with no pairing is found too.
        // Drizzle accepts the column list + a `targetWhere` predicate.
        target: [formDrafts.userId, formDrafts.templateId, formDrafts.pairingId],
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
    metadata: { scope, pairingId, fieldCount: Object.keys(responses).length },
  });

  return NextResponse.json({ ok: true, updatedAt: now.toISOString() });
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const actor = await requireSession();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = actor.id;
  const scope = parseScope(req);
  if (!scope) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  const { id } = await ctx.params;
  const pairingId = scope === "template" ? await draftPairing(req, actor) : null;
  if (pairingId instanceof NextResponse) return pairingId;

  const where =
    scope === "template"
      ? templateDraftWhere(userId, id, pairingId)
      : and(eq(formDrafts.userId, userId), eq(formDrafts.observationCycleId, id));

  const deleted = await db.delete(formDrafts).where(where).returning({ id: formDrafts.id });

  void recordAudit({
    action: "form.draft.clear",
    entityType: "form_drafts",
    entityId: id,
    metadata: { scope, pairingId, removed: deleted.length },
  });

  if (deleted.length === 0) {
    return NextResponse.json({ ok: true, removed: 0 }, { status: 404 });
  }
  return NextResponse.json({ ok: true, removed: deleted.length });
}
