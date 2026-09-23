// Topbar (desktop). Breadcrumbs + bell + queue indicator + lang picker + user pill.
// 1:1 port from `shell.jsx::Topbar`. ⌘K Quick-Find (028), Help (029), FTUX (030)
// are explicitly cut from v2; their slots stay empty visually.
//
// Spec 125 — the bell aria-label, sign-out title and language picker labels
// pull their copy from next-intl `getTranslations()` so the chrome renders in
// the user's UI language. Pure server-side translation: no 'use client'.
//
// Spec 128 — three pieces of chrome that were previously hardcoded are now
// wired to real backend data:
//   1. The bell is a Link href="/inbox" with the live unread notifications
//      count rendered as a chip (`99+` past 99).
//   2. A new queue indicator chip surfaces the the job queue transcode queue depth
//      ("N processing · K waiting · M failed") and hides when all zero.
//   3. Counts arrive as props from `(authenticated)/layout.tsx`, which calls
//      the React.cache'd loaders in `@/lib/chrome-counts`.
//
// Spec 155 — the language picker is now a real switcher. The summary chip
// reflects the user's CURRENT locale (EN / हि / བོ) and clicking a row PUTs
// to /api/user-prefs with `{ uiLanguage }` then reloads the document so the
// NextIntlClientProvider in (authenticated)/layout.tsx re-mounts with the
// new messages bundle. See `./LanguagePicker.tsx` for the client island.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { signOut } from "@/auth";
import { formatBellBadge, formatQueueLabel, type QueueDepth } from "@/lib/chrome-counts";
import type { RoleName } from "@gml/shared/auth/roles";
import type { Locale } from "@/i18n/config";
import { Breadcrumbs } from "./Breadcrumbs";
import { Icon } from "./Icon";
import LanguagePicker from "./LanguagePicker";
import { SignOutButton } from "./SignOutButton";

type TopbarProps = {
  user: { name?: string | null; email?: string | null; role: RoleName; image?: string | null };
  breadcrumbs?: string[];
  /** Spec 128 — unread notifications count. Defaults to 0 → bell shows no chip. */
  unreadCount?: number;
  /** Spec 128 — transcode queue depth. Defaults to empty → chip hidden. */
  queueDepth?: QueueDepth;
  /**
   * Spec 155 — current UI locale (from `user_prefs.uiLanguage`, normalised in
   * the authenticated layout). The LanguagePicker island reads this to render
   * the active chip and mark the currently-selected option.
   */
  locale?: Locale;
};

const ROLE_LABEL: Record<RoleName, string> = {
  super_admin: "Super Admin",
  programme_admin: "Programme Admin",
  mentor: "Mentor",
  observer: "Observer",
  teacher: "Teacher",
};

function initials(name?: string | null, email?: string | null): string {
  const src = name ?? email ?? "?";
  const parts = src.replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.|Mohd\.)\s+/i, "").trim().split(/\s+/);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

export async function Topbar({
  user,
  breadcrumbs = [],
  unreadCount = 0,
  queueDepth,
  locale = "en",
}: TopbarProps) {
  const tAction = await getTranslations("action");
  const tLanguage = await getTranslations("language");
  const bellBadge = formatBellBadge(unreadCount);
  const queueLabel = queueDepth ? formatQueueLabel(queueDepth) : null;
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 18px",
        borderBottom: "1px solid var(--line)",
        background: "var(--paper)",
        position: "sticky",
        top: 0,
        zIndex: 10,
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Breadcrumbs. An explicit list still wins; otherwise they are derived
          from the URL, because the layout that renders this cannot see the page
          below it and so never supplied any. See Breadcrumbs.tsx. */}
      <nav
        aria-label="Breadcrumb"
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-2)" }}
      >
        {breadcrumbs.length === 0 ? (
          <Breadcrumbs />
        ) : (
          breadcrumbs.map((crumb, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 ? <span aria-hidden="true" style={{ color: "var(--ink-4)" }}>›</span> : null}
              <span
                style={{ color: i === breadcrumbs.length - 1 ? "var(--ink)" : "var(--ink-3)", fontWeight: i === breadcrumbs.length - 1 ? 500 : 400 }}
                aria-current={i === breadcrumbs.length - 1 ? "page" : undefined}
              >
                {crumb}
              </span>
            </span>
          ))
        )}
      </nav>

      {/* Right cluster */}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        {/* Queue indicator — surfaces the job queue transcode queue depth (spec 128).
            Hidden when active/waiting/failed are all zero so the chrome stays
            quiet on idle systems. */}
        {queueLabel ? (
          <span
            data-testid="topbar-queue-indicator"
            title="Transcode queue depth"
            style={{
              padding: "4px 8px",
              borderRadius: 999,
              border: "1px solid var(--line)",
              background: "var(--card-hi)",
              color: "var(--ink-2)",
              fontSize: 11,
              fontFamily: "var(--mono)",
              letterSpacing: "0.02em",
            }}
          >
            {queueLabel}
          </span>
        ) : null}

        {/* Bell — wired to real notifications.unread (spec 128). Renders as a
            Link to /inbox; chip shows '99+' past 99 (formatBellBadge).
            data-help-anchor='topbar-help' is the FTUX (spec 123) coach-mark target. */}
        <Link
          href="/inbox"
          aria-label={tAction("notifications")}
          data-help-anchor="topbar-help"
          data-testid="topbar-bell"
          style={{
            position: "relative",
            background: "transparent",
            border: "1px solid transparent",
            padding: 6,
            borderRadius: "var(--r-2)",
            color: "var(--ink-2)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            textDecoration: "none",
          }}
        >
          <Icon name="chat" size={16} />
          {bellBadge ? (
            <span
              data-testid="topbar-bell-badge"
              style={{
                position: "absolute",
                top: -2,
                right: -4,
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 999,
                background: "var(--saffron)",
                color: "var(--paper)",
                fontSize: 9,
                fontWeight: 600,
                fontFamily: "var(--mono)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >
              {bellBadge}
            </span>
          ) : null}
        </Link>

        {/* Spec 155 — real language picker (client island). The button label
            reflects the user's CURRENT locale and selecting an option PUTs
            to /api/user-prefs then reloads the document so the
            NextIntlClientProvider re-mounts with the new messages bundle.
            See `./LanguagePicker.tsx` for the implementation. */}
        <LanguagePicker current={locale} ariaLabel={tLanguage("pickerLabel")} />

        {/* User pill */}
        {/* Spec 169 — the submit button is a 'use client' SignOutButton
            island so the device-local QuickFind recents (spec 121) are
            cleared from localStorage BEFORE the server-action signOut
            fires. The wipe is best-effort and never blocks sign-out. */}
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <SignOutButton
            title={`${tAction("signOut")} ${user.email ?? ""}`.trim()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 10px 4px 4px",
              border: "1px solid var(--line)",
              borderRadius: 999,
              background: "var(--card-hi)",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "var(--ink)",
                color: "var(--paper)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--sans)",
              }}
            >
              {initials(user.name, user.email)}
            </span>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", fontSize: 11 }}>
              <span style={{ color: "var(--ink)", fontWeight: 500 }}>{user.name ?? user.email}</span>
              <span style={{ color: "var(--ink-3)" }}>{ROLE_LABEL[user.role]}</span>
            </span>
          </SignOutButton>
        </form>
      </div>
    </header>
  );
}
