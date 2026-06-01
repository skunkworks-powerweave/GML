// PUT /api/admin/forms/[id]
// Role-gated to programme_admin + super_admin. Validates that the body parses
// as JSON, updates the feedback_forms row, bumps the version, and records an
// audit entry of action `form.schema.update`.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { feedbackForms } from "@gml/db/schema";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["programme_admin", "super_admin"] as const;

/**
 * Pure version-bump helper. Exported for the governance test.
 *
 *   "1"   → "2"
 *   "2"   → "3"
 *   "1.0" → "1.1"
 *   "2.7" → "2.8"
 *   "draft-Q2" → "draft-Q2+1"  (non-numeric path)
 */
export function bumpVersion(prev: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(prev);
  if (!m) return `${prev}+1`;
  const major = Number(m[1]);
  if (m[2] === undefined) {
    return String(major + 1);
  }
  const minor = Number(m[2]);
  return `${major}.${minor + 1}`;
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasAnyRole(session.user.role, [...ALLOWED_ROLES])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const raw = await req.text();
  if (!raw.trim()) {
    return NextResponse.json(
      { error: "empty_body", message: "Request body is empty." },
      { status: 400 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return NextResponse.json(
      { error: "invalid_json", message: (e as Error).message },
      { status: 400 },
    );
  }

  // Load existing row to compute the next version + record prev in audit metadata.
  const [existing] = await db
    .select({ id: feedbackForms.id, version: feedbackForms.version })
    .from(feedbackForms)
    .where(eq(feedbackForms.id, id))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const nextVersion = bumpVersion(existing.version);

  // Single-row update — schema column accepts arbitrary JSON, version is text.
  await db
    .update(feedbackForms)
    .set({ schema: parsed, version: nextVersion })
    .where(eq(feedbackForms.id, id));

  // SM-1 — audit every mutation; metadata captures the version transition so an
  // admin reviewing /admin/audit can chase regressions back to the schema.
  void recordAudit({
    action: "form.schema.update",
    entityType: "feedback_forms",
    entityId: id,
    metadata: {
      prevVersion: existing.version,
      nextVersion,
    },
  });

  return NextResponse.json({ ok: true, version: nextVersion }, { status: 200 });
}
