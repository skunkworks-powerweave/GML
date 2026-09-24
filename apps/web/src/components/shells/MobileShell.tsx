// Mobile shell: top app bar + content + bottom tabs. Used for viewport ≤ 768px.
// Floating ? button + sheet overlay land in spec 032.
//
// Spec 125 — the BottomTabs subcomponent has become an async server component
// (it calls `getTranslations()`). RSC handles awaiting async children at the
// render boundary; this wrapper stays a plain sync function so the spec 026
// "export function MobileShell" contract still matches.

import type { ReactNode } from "react";
import Link from "next/link";
import type { RoleName } from "@gml/shared/auth/roles";
import { signOut } from "@/auth";
import { SignOutButton } from "@/components/nav/SignOutButton";
import { BottomTabs } from "@/components/nav/BottomTabs";
import { ConfidentialityFooter } from "@/components/ConfidentialityFooter";
import { MobileHelpFAB } from "@/components/MobileHelpFAB";
import type { NavCounts } from "@/lib/chrome-counts";
import { MAIN_CONTENT_ID, SkipLink } from "./SkipLink";

type MobileShellProps = {
  user: { id: string; name?: string | null; email?: string | null; role: RoleName; image?: string | null };
  title?: string;
  activeTab?: string;
  /** Spec 128 — live nav counts forwarded to BottomTabs. */
  navCounts?: NavCounts;
  /** Spec 128 — unread notifications count; drives the inbox-tab dot. */
  unreadCount?: number;
  children: ReactNode;
};

export function MobileShell({
  user,
  title,
  activeTab,
  navCounts,
  unreadCount,
  children,
}: MobileShellProps) {
  return (
    <div style={{ minHeight: "100dvh", background: "var(--paper)", paddingBottom: 80 }}>
      {/* Skips the header's account controls. A phone with a keyboard or a
          switch device tabs through them otherwise. */}
      <SkipLink />
      <header
        style={{
          padding: "14px 16px 10px",
          borderBottom: "1px solid var(--line)",
          background: "var(--paper)",
          position: "sticky",
          top: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>GML LMS</div>
          {title ? <h1 style={{ fontFamily: "var(--serif)", fontSize: 18, fontWeight: 600, marginTop: 2 }}>{title}</h1> : null}
        </div>
        {/* ACCOUNT CONTROLS. These did not exist on mobile at all.
            The avatar was an inert <span> and BottomTabs carries no settings
            tab, so a user on a phone could not sign out, could not change
            their interface language and could not reach /settings by any route
            other than typing the URL. Teachers in this programme are the most
            phone-heavy group in it, and shared classroom handsets make
            "cannot sign out" a real access-control problem rather than an
            inconvenience. The desktop Topbar has had all three since spec 169.

            The avatar is now the link to /settings, which is where the
            language picker and the password change live; sign-out sits beside
            it, using the same client island as the Topbar so the device-local
            QuickFind recents are wiped before the session ends. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Link
            href="/settings"
            aria-label="Your settings"
            data-testid="mobile-settings-link"
            title={user.email ?? ""}
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "var(--ink)",
              color: "var(--paper)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            {(user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase()}
          </Link>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <SignOutButton
              title={`Sign out ${user.email ?? ""}`.trim()}
              style={{
                padding: "5px 10px",
                border: "1px solid var(--line)",
                borderRadius: 999,
                background: "var(--card-hi)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Sign out
            </SignOutButton>
          </form>
        </div>
      </header>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ padding: "16px" }}>
        {children}
      </main>
      <ConfidentialityFooter user={{ name: user.name, email: user.email }} compact />
      <MobileHelpFAB />
      <BottomTabs
        role={user.role}
        activeTab={activeTab}
        counts={navCounts}
        unreadCount={unreadCount}
      />
    </div>
  );
}
