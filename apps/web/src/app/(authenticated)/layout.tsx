// Route group layout — wraps every authenticated route with the appropriate
// shell (desktop sidebar or mobile bottom tabs) based on device detection.
// Routes outside this group (e.g. /login, /gate/[slug]) render without chrome.

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { eq } from "drizzle-orm";
import { NextIntlClientProvider } from "next-intl";
import { db } from "@gml/db";
import { userPrefs } from "@gml/db/schema";
import { auth } from "@/auth";
import { getDeviceType } from "@/lib/device";
import { DesktopShell, MobileShell } from "@/components/shells";
import AntiDownloadGuard from "@/components/AntiDownloadGuard";
import { FTUXTour } from "@/components/ftux/FTUXTour";
import { HelpPanel } from "@/components/help/HelpPanel";
import QuickFind from "@/components/quickfind/QuickFind";
import {
  loadMessages,
  normalizeLocale,
  LOCALE_FONT_FAMILY,
  LOCALE_HTML_LANG,
} from "@/i18n/config";
import {
  loadNavCounts,
  loadUnreadNotifications,
  loadQueueDepth,
} from "@/lib/chrome-counts";
import type { RoleName } from "@gml/shared/auth/roles";

// Spec 088 — every authenticated route renders the AntiDownloadGuard alongside
// the shell. The guard is a 'use client' island that attaches global keydown
// listeners (Ctrl/Cmd+S/P, PrintScreen) + a DevTools-open heuristic; it
// renders no visible chrome unless a transient "screenshots are logged" toast
// is active. Deterrence, not prevention — see component JSDoc.
//
// Spec 123 — the same user_prefs read also retrieves ftuxSeenAt; when null,
// the FTUXTour client overlay paints a role-specific coach-mark sequence on
// top of the shell. Saving completion (or skip) PUTs back into user_prefs so
// the tour never re-fires; the /settings page exposes a "Replay tour" link
// that re-arms it.
//
// Spec 125 — every authenticated route is also wrapped in NextIntlClientProvider
// so the topbar, sidebar, bottom tabs and section-gate page can call
// useTranslations() against the user's chosen UI language. The locale is read
// from user_prefs.uiLanguage (default 'en'); see `@/i18n/config` for the
// fallback strategy and font handling.
//
// Spec 122 — every authenticated route also mounts the global HelpPanel
// client island. It is invisible by default; HelpTip / HelpDot / HelpHeadbtn
// call-sites dispatch `gml:open-help` to open it, and a global `?` shortcut
// (or `Shift+/` or `⌘?`) toggles it as well. Helpdesk contact details are
// read from process.env at SSR time and passed in as plain string props so
// the client island doesn't need to import `process` directly.
//
// Spec 121 — QuickFind (⌘K / Ctrl+K) overlay is mounted globally. It listens
// for the keyboard shortcut at window-scope; when closed it renders no DOM
// (and contributes zero markup to first paint), so the only cost is the JS
// bundle for the modal itself.

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const device = await getDeviceType();
  const user = {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    role: (session.user.role ?? "teacher") as RoleName,
    image: session.user.image ?? null,
  };

  // Read the user's UI language and ftux state from user_prefs in a single
  // query. Defaults to 'en' + null for users who haven't visited /settings
  // yet — the row only exists after the first pref change, by design (spec
  // 024). A null ftuxSeenAt is exactly the signal the FTUXTour component
  // mounts on (spec 123).
  const [prefRow] = await db
    .select({ uiLanguage: userPrefs.uiLanguage, ftuxSeenAt: userPrefs.ftuxSeenAt })
    .from(userPrefs)
    .where(eq(userPrefs.userId, session.user.id))
    .limit(1);
  const locale = normalizeLocale(prefRow?.uiLanguage);
  const messages = loadMessages(locale);
  const fontFamily = LOCALE_FONT_FAMILY[locale];
  const htmlLang = LOCALE_HTML_LANG[locale];
  const ftuxSeenAt = prefRow?.ftuxSeenAt ? prefRow.ftuxSeenAt.toISOString() : null;

  // Spec 122 — helpdesk contact details for the "Talk to a person" card.
  // We fall back to existing env contracts (WHATSAPP_PHONE_NUMBER_ID,
  // SMTP_FROM) so no new env vars are required to ship this spec, but a
  // deployment may set GML_HELPDESK_PHONE / GML_HELPDESK_EMAIL to override.
  const helpdeskContact = {
    whatsappPhone:
      process.env.GML_HELPDESK_PHONE ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? null,
    email: process.env.GML_HELPDESK_EMAIL ?? process.env.SMTP_FROM ?? null,
  };

  // Spec 128 — dynamic chrome counts. Each loader is React.cache'd so calling
  // them in this layout AND from any descendant server component yields one
  // DB / Redis round-trip per request. All loaders fail-closed (empty/0) so
  // the chrome stays readable when the data source is down.
  const [navCounts, unreadCount, queueDepth] = await Promise.all([
    loadNavCounts(user.id, user.role),
    loadUnreadNotifications(user.id),
    loadQueueDepth(),
  ]);

  const content = device === "mobile" ? (
    <MobileShell user={user} navCounts={navCounts} unreadCount={unreadCount}>
      {children}
    </MobileShell>
  ) : (
    <DesktopShell
      user={user}
      navCounts={navCounts}
      unreadCount={unreadCount}
      queueDepth={queueDepth}
      locale={locale}
    >
      {children}
    </DesktopShell>
  );

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <AntiDownloadGuard />
      <FTUXTour role={user.role} ftuxSeenAt={ftuxSeenAt} />
      <QuickFind userId={user.id} />
      <div
        data-locale={locale}
        data-html-lang={htmlLang}
        style={fontFamily ? { fontFamily } : undefined}
      >
        {content}
      </div>
      <HelpPanel contact={helpdeskContact} />
    </NextIntlClientProvider>
  );
}
