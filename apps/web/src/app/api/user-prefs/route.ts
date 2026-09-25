// GET /api/user-prefs — return current user's prefs (creating defaults if missing)
// PUT /api/user-prefs — update current user's prefs (audit-on-change)
//
// 401 { error: "unauthenticated" } without a session; 400 { error:
// "invalid_json" } for a body that is not JSON; 400 { error:
// "validation_failed", issues: [{ path, message }] } for one that is.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { userPrefs } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { publicIssues, readJsonBody } from "@/lib/api-json";
import { LOCALE_COOKIE } from "@/i18n/config";
import { cookieLocale } from "@/i18n/resolve";

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

// No uiLanguage here: a user with no row is seeing the gml-locale cookie's
// language (i18n/resolve.ts), so that is their default -- see PUT.
const DEFAULT_PREFS = {
  density: "regular" as const,
  navStyle: "labelled" as const,
  fontScale: "regular" as const,
  highContrast: false,
  reducedMotion: false,
  showWatermark: true,
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, session.user.id)).limit(1);
  if (row) return NextResponse.json(row);
  // No row yet → return defaults
  return NextResponse.json({ userId: session.user.id, ...DEFAULT_PREFS, uiLanguage: await cookieLocale() });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Not `.catch(() => ({}))`: that read a body that was not JSON as an empty
  // patch, upserted the defaults, audited an update and answered 200 ok.
  const read = await readJsonBody(req);
  if (read.response) return read.response;
  const parse = PrefsSchema.safeParse(read.body);
  if (!parse.success) {
    return NextResponse.json({ error: "validation_failed", issues: publicIssues(parse.error) }, { status: 400 });
  }
  const patch = parse.data;
  // NULL MUST SURVIVE AS NULL.
  //
  // This read `patch.ftuxSeenAt ? new Date(...) : undefined`, and Drizzle's
  // mapUpdateSet DROPS undefined entries -- so an explicit null, which is how
  // the "Replay tour" button asks for the timestamp to be cleared, was turned
  // into "don't touch this column". The button reported success and the tour
  // never replayed. Distinguishing "absent" (leave alone) from "null" (clear)
  // is the whole contract of a PATCH-shaped endpoint.
  const ftuxSeenAt =
    patch.ftuxSeenAt === undefined
      ? undefined
      : patch.ftuxSeenAt === null
        ? null
        : new Date(patch.ftuxSeenAt);

  // Upsert.
  //
  // THE FIRST ROW KEEPS THE LANGUAGE ON SCREEN. With no row, the UI is in the
  // cookie's language (the login-page picker's); once a row exists, the row
  // decides (i18n/resolve.ts). The insert used to take uiLanguage 'en' from
  // the defaults whatever field was being saved, so the first-run tour's
  // {ftuxSeenAt} -- sent on every first sign-in -- or a Settings toggle
  // switched a user who had picked हिन्दी at sign-in to English. The cookie
  // seeds the INSERT only: the conflict branch below sets just the patch, so
  // a saved language is never overwritten by a device's cookie.
  await db
    .insert(userPrefs)
    .values({
      userId: session.user.id,
      ...DEFAULT_PREFS,
      ...patch,
      uiLanguage: patch.uiLanguage ?? (await cookieLocale()),
      ftuxSeenAt,
    })
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

  // Mirror the locale into the `gml-locale` cookie. Signed in, user_prefs is
  // what every render uses (src/i18n/resolve.ts); the cookie is what the
  // signed-out pages (/login after sign-out) fall back to, so this keeps them
  // in the language the user last chose on this device. A route handler is
  // the right place for this: Server Components cannot write cookies.
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
