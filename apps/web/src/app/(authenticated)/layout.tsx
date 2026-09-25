// Route group layout — wraps every authenticated route with the appropriate
// shell (desktop sidebar or mobile bottom tabs) based on device detection.
// Routes outside this group (e.g. /login, /gate/[slug]) render without chrome.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { auth } from "@/auth";
import { getDeviceType } from "@/lib/device";
import { assertEnv } from "@/lib/env";
import { DesktopShell, MobileShell } from "@/components/shells";
import { DeviceSync } from "@/components/DeviceSync";
import AntiDownloadGuard from "@/components/AntiDownloadGuard";
import { FTUXTour } from "@/components/ftux/FTUXTour";
import { HelpPanel } from "@/components/help/HelpPanel";
import QuickFind from "@/components/quickfind/QuickFind";
import { loadMessages, LOCALE_FONT_FAMILY, LOCALE_HTML_LANG } from "@/i18n/config";
import { viewerPrefs } from "@/i18n/resolve";
import {
  loadNavCounts,
  loadUnreadNotifications,
  loadQueueDepth,
} from "@/lib/chrome-counts";
import type { RoleName } from "@gml/shared/auth/roles";
import { activeNavIdFor, activeTabIdFor } from "@/config/nav";

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
// useTranslations() against the user's chosen UI language. The locale is
// user_prefs.uiLanguage, resolved once per request by `@/i18n/resolve`; see
// `@/i18n/config` for the fallback strategy and font handling.
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

  // The user's UI language and ftux state, from the one per-request user_prefs
  // read (i18n/resolve.ts) that i18n/request.ts and the root layout use too --
  // so the strings, <html lang>, this wrapper's lang and font, the provider's
  // messages and the picker's "current" cannot name different languages. The
  // row only exists after the first pref change (spec 024); until then the
  // locale is the pre-auth cookie's and ftuxSeenAt is null, which is exactly
  // the signal the FTUXTour component mounts on (spec 123).
  const { locale, prefs: prefRow } = await viewerPrefs();
  const messages = loadMessages(locale);
  const fontFamily = LOCALE_FONT_FAMILY[locale];
  const htmlLang = LOCALE_HTML_LANG[locale];
  const ftuxSeenAt = prefRow?.ftuxSeenAt ? prefRow.ftuxSeenAt.toISOString() : null;

  // Helpdesk contact details for the "Talk to a person" card.
  //
  // Spec 169 — the GML_* values are validated by assertEnv() before they reach
  // the UI. A set-but-invalid value (typo, missing `+`, stray whitespace) is
  // logged SEVERE in production and surfaced as `null`, so the affordance hides
  // rather than rendering a broken wa.me / mailto link.
  //
  // The SMTP_FROM fallback that used to sit on `email` is GONE. Outbound email
  // moved to Supabase, so SMTP_FROM is set nowhere in this application's
  // environment and the fallback could never be satisfied -- it read as a
  // working default while always resolving to null.
  //
  // The WHATSAPP_PHONE_NUMBER_ID fallback is gone for a different reason: it
  // was never a phone number. It is Meta's opaque account identifier for the
  // Cloud API -- fifteen digits, which is why it survived every "is this
  // numeric" check -- and rendering it into a wa.me link sent anyone who
  // clicked the helpdesk contact to an account that does not exist. Compose
  // still passes the variable because the WEBHOOK needs it; the UI must not
  // treat it as dialable.
  const envSummary = assertEnv();
  const helpdeskContact = {
    whatsappPhone: envSummary.helpdeskPhone.value ?? null,
    email: envSummary.helpdeskEmail.value ?? null,
  };

  // Spec 128 — dynamic chrome counts. Each loader is React.cache'd so calling
  // them in this layout AND from any descendant server component yields one
  // DB / Redis round-trip per request. All loaders fail-closed (empty/0) so
  // the chrome stays readable when the data source is down.
  const [navCounts, unreadCount, queueDepth] = await Promise.all([
    loadNavCounts(user.id, user.role),
    loadUnreadNotifications(user.id),
    loadQueueDepth(user.role),
  ]);

  // WHICH NAV ITEM IS CURRENT.
  //
  // Both shells have always accepted an active-item id and forwarded it to
  // Sidebar / BottomTabs, and no caller ever supplied one -- so `isActive` was
  // false for every item on every page and nothing in the chrome ever showed
  // where the user was. A layout cannot read the URL, which is why it was never
  // wired; proxy.ts now sets x-pathname on every request, so it can.
  const pathname = (await headers()).get("x-pathname");

  const content = device === "mobile" ? (
    <MobileShell
      user={user}
      navCounts={navCounts}
      unreadCount={unreadCount}
      activeTab={activeTabIdFor(user.role, pathname)}
    >
      {children}
    </MobileShell>
  ) : (
    <DesktopShell
      user={user}
      navCounts={navCounts}
      unreadCount={unreadCount}
      queueDepth={queueDepth}
      locale={locale}
      activeNavId={activeNavIdFor(user.role, pathname)}
    >
      {children}
    </DesktopShell>
  );

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {/* Writes the gml-device cookie and watches the viewport, so shell
          selection follows the actual width rather than only the User-Agent.
          The hook behind it had zero call sites, which meant a desktop browser
          narrowed to phone width kept a shell whose column widths are inline
          styles and cannot respond. Renders nothing. */}
      <DeviceSync initial={device} />
      <AntiDownloadGuard />
      <FTUXTour role={user.role} ftuxSeenAt={ftuxSeenAt} />
      <QuickFind userId={user.id} />
      {/* THE LANGUAGE IS DECLARED, NOT JUST RECORDED. This was
          data-html-lang={htmlLang}: a data attribute, invisible to the browser
          and to assistive technology, so every Hindi and Bhoti page was read
          out as English. The root layout's <html lang> comes from the same
          resolver, so this now repeats it; it stays because the font rides on
          the same wrapper. */}
      <div
        data-locale={locale}
        lang={htmlLang}
        style={fontFamily ? { fontFamily } : undefined}
      >
        {content}
      </div>
      <HelpPanel contact={helpdeskContact} />
    </NextIntlClientProvider>
  );
}
