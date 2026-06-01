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
const ROLE_COLORS: Record<string, { bg: string; ink: string; label: string }> = {
  super_admin: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "Super admin" },
  programme_admin: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "Programme admin" },
  mentor: { bg: "var(--indigo-soft)", ink: "var(--indigo)", label: "Mentor" },
  teacher: { bg: "var(--lichen-soft)", ink: "var(--lichen)", label: "Teacher" },
  observer: { bg: "var(--rust-soft)", ink: "var(--rust)", label: "Observer" },
};

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;
  const email = session.user.email ?? "—";
  const role = session.user.role ?? "teacher";
  const roleStyle = ROLE_COLORS[role] ?? { bg: "var(--paper-2)", ink: "var(--ink-3)", label: role.replace(/_/g, " ") };

  const [row] = await db
    .select()
    .from(userPrefs)
    .where(eq(userPrefs.userId, userId))
    .limit(1);

  const initial: SettingsFormValues = row
    ? {
        density: (row.density as SettingsFormValues["density"]) ?? "regular",
        fontScale: (row.fontScale as SettingsFormValues["fontScale"]) ?? "regular",
        highContrast: row.highContrast ?? false,
        reducedMotion: row.reducedMotion ?? false,
        showWatermark: row.showWatermark ?? true,
        uiLanguage: (row.uiLanguage as SettingsFormValues["uiLanguage"]) ?? "en",
      }
    : DEFAULT_PREFS;

  return (
    <div>
      <header style={{ marginBottom: 24 }}>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          Settings
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>
          Your preferences
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4, fontSize: 13, maxWidth: 640 }}>
          Persisted to your account. Display + accessibility tweaks apply on the next page load;
          watermark + language take effect immediately on new requests.
        </p>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 18,
          marginBottom: 24,
        }}
      >
        <SettingsForm initial={initial} email={email} roleLabel={roleStyle.label} roleBg={roleStyle.bg} roleInk={roleStyle.ink} />
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
  );
}
