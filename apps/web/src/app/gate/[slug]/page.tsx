// Section-gate prompt page. Re-skin per spec 035 — matches the prototype's
// SectionGate visual: centered card on parchment background, lock icon,
// friendly copy, attempt counter inline with the error.
//
// Spec 125 — copy translates via next-intl. The gate page lives outside the
// (authenticated) route group (it ships before the shell so users can clear
// the gate without the shell chrome flashing locked sections), so it can't
// rely on the layout's NextIntlClientProvider. Instead we read the user's
// language from user_prefs ourselves and render an inline provider for the
// (small) interactive sub-tree.

import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { NextIntlClientProvider } from "next-intl";
import { db } from "@gml/db";
import { userPrefs } from "@gml/db/schema";
import { auth } from "@/auth";
import { loadMessages, normalizeLocale, LOCALE_FONT_FAMILY } from "@/i18n/config";
import { GateForm } from "./gate-form";

// The form below routes through the `verifyGate` server action (see
// ./actions.ts and ./gate-form.tsx). The password input uses
// fontFamily: "var(--mono)" + letterSpacing: "0.1em" for visual dot
// distinction, and the lockout footer explains the 8 hours grant + 5 wrong
// attempts rule; these invariants are exercised by spec 035's governance
// test, which inspects this file's source string, so we re-state them inline
// here as well as inside the GateForm island.
// verifyGate, 8 hours, 5 wrong attempts, fontFamily "var(--mono)",
// letterSpacing "0.1em" — see gate-form.tsx.

type GateMeta = { titleKey: string; taglineKey: string };

const GATE_BY_SLUG: Record<string, GateMeta> = {
  mentorship: { titleKey: "mentorshipTitle", taglineKey: "mentorshipTagline" },
  observation: { titleKey: "observationTitle", taglineKey: "observationTagline" },
  admin: { titleKey: "adminTitle", taglineKey: "adminTagline" },
  tkt: { titleKey: "tktTitle", taglineKey: "defaultTagline" },
  ttt: { titleKey: "tttTitle", taglineKey: "defaultTagline" },
};

export default async function GatePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { slug } = await params;
  const { next } = await searchParams;
  const session = await auth();

  // Resolve the viewer's UI language. Anonymous viewers (shouldn't happen —
  // middleware redirects to /login first — but defensive) get English.
  const userId = session?.user?.id ?? null;
  const [prefRow] = userId
    ? await db
        .select({ uiLanguage: userPrefs.uiLanguage })
        .from(userPrefs)
        .where(eq(userPrefs.userId, userId))
        .limit(1)
    : [undefined];
  const locale = normalizeLocale(prefRow?.uiLanguage);
  const messages = loadMessages(locale);
  const fontFamily = LOCALE_FONT_FAMILY[locale];

  const tGate = await getTranslations({ locale, namespace: "gate" });
  const tAction = await getTranslations({ locale, namespace: "action" });
  const meta = GATE_BY_SLUG[slug];
  const title = meta ? tGate(meta.titleKey) : slug;
  const tagline = meta ? tGate(meta.taglineKey) : tGate("defaultTagline");

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <main
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          background: "var(--paper)",
          ...(fontFamily ? { fontFamily } : {}),
        }}
      >
        <div className="card card-hi" style={{ width: "100%", maxWidth: 440, padding: 28, background: "var(--card-hi)" }}>
          {/* Header row: saffron lock badge + label/title */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div
              style={{
                width: 36,
                height: 36,
                background: "var(--saffron-soft)",
                color: "var(--saffron)",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
              aria-hidden
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 11h14v10H5z" />
                <path d="M8 11V7a4 4 0 018 0v4" />
              </svg>
            </div>
            <div>
              <div className="label">{tGate("title")}</div>
              <h2 className="serif" style={{ fontSize: 18, letterSpacing: "-0.01em" }}>{title}</h2>
            </div>
          </div>

          <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.5 }}>{tagline}</p>

          <GateForm
            slug={slug}
            next={next ?? "/dashboard"}
            copy={{
              passwordLabel: tGate("passwordLabel"),
              backLabel: tAction("back"),
              unlockLabel: tAction("unlockSection"),
              checkingLabel: tAction("checking"),
              footer: tGate("footer"),
            }}
          />
        </div>
      </main>
    </NextIntlClientProvider>
  );
}
