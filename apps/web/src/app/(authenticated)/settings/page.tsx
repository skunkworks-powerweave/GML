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
import { getTranslations } from "next-intl/server";
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
// account row visually consistent with the rest of the chrome. The role's
// name is role.* in the user's language, as in the topbar.
const ROLE_COLORS: Record<string, string> = {
  super_admin: "chip-saffron",
  programme_admin: "chip-saffron",
  mentor: "chip-indigo",
  teacher: "chip-lichen",
  observer: "chip-rust",
};

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;
  const passwordRequired = session.user.mustChangePassword === true;
  const email = session.user.email ?? "—";
  const role = session.user.role ?? "teacher";
  const t = await getTranslations("home.settings");
  const tNav = await getTranslations("nav");
  const tRole = await getTranslations("role");
  const roleLabel = tRole.has(role) ? tRole(role) : role.replace(/_/g, " ");

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
        <div className="label">{tNav("settings")}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>
          {t("title")}
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4, fontSize: 13, maxWidth: 640 }}>
          {t("intro")}
        </p>
      </div>

      <div className="page-body">
        {/* A password an administrator set must be replaced first: the proxy
            sends every page here until it is, so the menu looks dead. Said at
            the TOP, where the page opens. The form's own notice sat in the
            Account card at the bottom, below the fold, and a new teacher read
            "Your preferences" and nothing else (live QA, 9 Oct 2026). */}
        {passwordRequired ? (
          <section
            aria-labelledby="password-first-title"
            data-testid="password-required-banner"
            style={{
              background: "var(--saffron-soft)",
              border: "1px solid oklch(0.82 0.08 60)",
              borderRadius: "var(--r-2)",
              padding: 14,
              marginBottom: 18,
              display: "grid",
              gap: 8,
              maxWidth: 780,
            }}
          >
            <h2 id="password-first-title" className="serif" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
              {t("passwordFirst.title")}
            </h2>
            <p style={{ fontSize: 13, margin: 0, color: "var(--ink-2)" }}>{t("passwordFirst.body")}</p>
            <div>
              <a href="#change-password" className="btn btn-primary" data-testid="password-required-go">
                {t("passwordFirst.cta")}
              </a>
            </div>
          </section>
        ) : null}

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
          <SettingsForm
            initial={initial}
            email={email}
            roleLabel={roleLabel}
            roleChipKind={ROLE_COLORS[role] ?? ""}
            passwordRequired={passwordRequired}
          />
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
          {t.rich("footer", {
            link: (chunks) => (
              <a href="/admin" style={{ color: "var(--indigo)", textDecoration: "none" }}>
                {chunks}
              </a>
            ),
          })}
        </footer>
      </div>
    </div>
  );
}
