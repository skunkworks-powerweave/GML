// GET /api/user-prefs — return current user's prefs (creating defaults if missing)
// PUT /api/user-prefs — update current user's prefs (audit-on-change)

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { userPrefs } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

const PrefsSchema = z.object({
  density: z.enum(["dense", "regular", "loose"]).optional(),
  navStyle: z.enum(["labelled", "icons"]).optional(),
  fontScale: z.enum(["regular", "large", "xlarge"]).optional(),
  highContrast: z.boolean().optional(),
  reducedMotion: z.boolean().optional(),
  showWatermark: z.boolean().optional(),
  uiLanguage: z.enum(["en", "hi", "bo"]).optional(),
  ftuxSeenAt: z.string().datetime().optional().nullable(),
});

const DEFAULT_PREFS = {
  density: "regular" as const,
  navStyle: "labelled" as const,
  fontScale: "regular" as const,
  highContrast: false,
  reducedMotion: false,
  showWatermark: true,
  uiLanguage: "en" as const,
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, session.user.id)).limit(1);
  if (row) return NextResponse.json(row);
  // No row yet → return defaults
  return NextResponse.json({ userId: session.user.id, ...DEFAULT_PREFS });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parse = PrefsSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ error: "validation_failed", issues: parse.error.issues }, { status: 400 });
  }
  const patch = parse.data;
  const ftuxSeenAt = patch.ftuxSeenAt ? new Date(patch.ftuxSeenAt) : undefined;

  // Upsert
  await db
    .insert(userPrefs)
    .values({ userId: session.user.id, ...DEFAULT_PREFS, ...patch, ftuxSeenAt })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: { ...patch, ftuxSeenAt, updatedAt: new Date() },
    });

  // SM-1 audit: prefs are user-private but changes still recorded.
  void recordAudit({
    action: "user_prefs.update",
    entityType: "user_prefs",
    entityId: session.user.id,
    metadata: { keys: Object.keys(patch) },
  });

  return NextResponse.json({ ok: true });
}
