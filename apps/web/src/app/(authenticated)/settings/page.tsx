// /settings — persisted user preferences. Server component reads `user_prefs`
// for the current session and hands the initial payload to a `'use client'`
// form that delta-PUTs `/api/user-prefs` on change. 1:1 design port of the
// *user-scoped* slice of `LMS GML Frontend/forms.jsx::SettingsPage` (lines 268-341);
// admin-scoped Programme / Video pipeline / Notifications / Backups panels are
// deferred (no `system_settings` table exists yet — documented in spec 071).
//
// SM-7 reminder: the Hindi label for the language picker is rendered with
// `var(--deva)`. The user does not edit a Hindi name here.

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { userPrefs } from "@gml/db/schema";
import { auth } from "@/auth";
import { resolveUiLocale } from "@/i18n/resolve";
import { SettingsForm, type SettingsFormValues } from "./settings-form";

export const dynamic = "force-dynamic";

const DEFAULT_PREFS: SettingsFormValues = {
  density: "regular",
  fontScale: "regular",
  highContrast: false,
  reducedMotion: false,
  showWatermark: true,
  uiLanguage: "en",
};

// Role chip color tokens mirror the topbar palette (spec 027). Keeps the
// account row visually consistent with the rest of the chrome.
const ROLE_COLORS: Record<string, { chipKind: string; label: string }> = {
  super_admin: { chipKind: "chip-saffron", label: "Super admin" },
  programme_admin: { chipKind: "chip-saffron", label: "Programme admin" },
  mentor: { chipKind: "chip-indigo", label: "Mentor" },
  teacher: { chipKind: "chip-lichen", label: "Teacher" },
  observer: { chipKind: "chip-rust", label: "Observer" },
};

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;
  const email = session.user.email ?? "—";
  const role = session.user.role ?? "teacher";
  const roleStyle = ROLE_COLORS[role] ?? { chipKind: "", label: role.replace(/_/g, " ") };

  const [row] = await db
    .select()
    .from(userPrefs)
    .where(eq(userPrefs.userId, userId))
    .limit(1);

  // The language pill shows the locale the chrome around it is rendered in
  // (i18n/resolve.ts), not the row's value or the "en" default: with nothing
  // saved and Hindi picked on the login page, the pill said English under
  // Hindi menus, and tapping हिन्दी then "changed" nothing.
  const uiLanguage = await resolveUiLocale();
  const initial: SettingsFormValues = row
    ? {
        density: (row.density as SettingsFormValues["density"]) ?? "regular",
        fontScale: (row.fontScale as SettingsFormValues["fontScale"]) ?? "regular",
        highContrast: row.highContrast ?? false,
        reducedMotion: row.reducedMotion ?? false,
        showWatermark: row.showWatermark ?? true,
        uiLanguage,
      }
    : { ...DEFAULT_PREFS, uiLanguage };

  return (
    <div>
      <div className="page-header">
        <div className="label">Settings</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>
          Your preferences
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4, fontSize: 13, maxWidth: 640 }}>
          Saved to your account as you change them, and applied straight away on every device you
          sign in on.
        </p>
      </div>

      <div className="page-body">
        <section
          style={{
            display: "grid",
            // Two cards a row where they fit, one on a phone: a fixed
            // "1fr 1fr" left each card ~130px there and clipped its buttons.
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
            gap: 18,
            marginBottom: 24,
          }}
        >
          <SettingsForm initial={initial} email={email} roleLabel={roleStyle.label} roleChipKind={roleStyle.chipKind} />
        </section>

        <footer
          style={{
            fontSize: 11,
            color: "var(--ink-3)",
            borderTop: "1px solid var(--line)",
            paddingTop: 12,
            marginTop: 8,
          }}
        >
          Programme-wide settings (video pipeline, notifications, backups) live under{" "}
          <a href="/admin" style={{ color: "var(--indigo)", textDecoration: "none" }}>
            Admin
          </a>{" "}
          and require a programme admin role.
        </footer>
      </div>
    </div>
  );
}
