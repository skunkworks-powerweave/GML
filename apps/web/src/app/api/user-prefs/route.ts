// GET /api/user-prefs — return current user's prefs (creating defaults if missing)
// PUT /api/user-prefs — update current user's prefs (audit-on-change)

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { userPrefs } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { LOCALE_COOKIE } from "@/i18n/config";

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

  const res = NextResponse.json({ ok: true });

  // Mirror the locale into the `gml-locale` cookie. user_prefs.uiLanguage stays
  // the source of truth, but the next-intl request config (src/i18n/request.ts)
  // runs on every server render and cannot afford a DB round-trip, so it reads
  // this cookie instead. Without the mirror, changing the language would update
  // the database while every server-rendered string kept the previous locale.
  // A route handler is the right place for this: Server Components cannot write
  // cookies.
  if (patch.uiLanguage) {
    res.cookies.set(LOCALE_COOKIE, patch.uiLanguage, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      // Deliberately readable by JS: the pre-auth picker in
      // login/language-picker.tsx sets the same cookie from the client, and a
      // display language is not a secret.
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
    });
  }

  return res;
}
