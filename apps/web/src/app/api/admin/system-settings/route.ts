// GET /api/admin/system-settings — read current system_settings singleton.
// PUT /api/admin/system-settings — patch system_settings; super_admin gated; audited.
//
// Spec 124 (Workflow Run 10 frontend-parity) — closes the spec 071 deviation
// where the JSX prototype rendered a five-section admin settings panel
// (Programme, Video pipeline, Notifications, Backups & retention, status
// display) with no backing table. The schema lives in
// packages/db/src/schema/systemSettings.ts and is a singleton row pattern
// enforced by a DB CHECK constraint pinning the id to a sentinel UUID.
//
// Role gating: super_admin only. programme_admin is NOT trusted with this
// surface because the knobs here are platform-wide (video upload ceiling,
// notification category enable/disable, backup retention window) and changes
// affect every tenant of the deployment. Mirrors spec 115's gate-rotate route
// in restricting to the deployment's 1-2 super_admins.
//
// SM-1 (audit moat): every successful PUT records "system_settings.update"
// with the list of changed keys in metadata. The route uses recordAudit() in
// best-effort void form so an audit insertion failure never blocks a PUT that
// already committed.
//
// SM-4 (anti-download): videoDefaultQuality is constrained at the zod layer to
// "480p" only. The UI dropdown shows 720p/1080p as disabled options with a
// tooltip explaining spec 041's deferral. Accepting a different value would
// silently break the SM-4 quality ceiling the worker enforces.
//
// PUT errors: 400 { error: "invalid_json" } for a body that is not JSON (it
// used to be read as `{}` and reported as "empty_patch", i.e. "you sent
// nothing"); 400 { error: "validation_failed", issues: [{ path, message }] };
// 400 { error: "empty_patch" } for a valid body that changes nothing.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { systemSettings, SYSTEM_SETTINGS_ID } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { publicIssues, readJsonBody } from "@/lib/api-json";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { NOTIFICATION_KEYS } from "@/lib/notification-kinds";

export const dynamic = "force-dynamic";

// Catalogue and keys come from lib/notification-kinds.ts — one list, so the
// page cannot offer a key this route rejects.

// Allowed video qualities. Only 480p ships today (SM-4); the rest are intentionally
// rejected at the zod layer so a future drive-by edit can't quietly accept them
// without also touching the worker pipeline.
const VIDEO_QUALITIES = ["480p"] as const;

const SystemSettingsPatchSchema = z.object({
  programmeName: z.string().min(1).max(200).optional(),
  academicYear: z
    .string()
    .min(1)
    .max(16)
    .regex(/^\d{4}-\d{2}$/, "academicYear must be YYYY-YY (e.g. 2026-27)")
    .optional(),
  videoDefaultQuality: z.enum(VIDEO_QUALITIES).optional(),
  videoMaxUploadMb: z.number().int().min(10).max(2000).optional(),
  notificationsEnabled: z.array(z.enum(NOTIFICATION_KEYS)).optional(),
  backupRetentionDays: z.number().int().min(7).max(365).optional(),
});

async function readSettings() {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, SYSTEM_SETTINGS_ID))
    .limit(1);
  return row ?? null;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasAnyRole(session.user.role, ["super_admin"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const row = await readSettings();
  if (!row) {
    // No singleton row yet — the migration INSERTs it and seed.ts upserts it,
    // but a partially-bootstrapped dev DB might miss it. Surface a clear 404
    // rather than fabricating defaults — the operator should run the seed.
    return NextResponse.json({ error: "not_bootstrapped" }, { status: 404 });
  }
  return NextResponse.json(row);
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasAnyRole(session.user.role, ["super_admin"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const read = await readJsonBody(req);
  if (read.response) return read.response;
  const parsed = SystemSettingsPatchSchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: publicIssues(parsed.error) },
      { status: 400 },
    );
  }
  const patch = parsed.data;
  const changedKeys = Object.keys(patch);
  if (changedKeys.length === 0) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  await db
    .update(systemSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(systemSettings.id, SYSTEM_SETTINGS_ID));

  void recordAudit({
    action: "system_settings.update",
    entityType: "system_settings",
    entityId: SYSTEM_SETTINGS_ID,
    metadata: { keys: changedKeys, by: session.user.id },
  });

  const fresh = await readSettings();
  return NextResponse.json({ ok: true, settings: fresh });
}

export async function POST() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
export async function DELETE() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
export async function PATCH() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
