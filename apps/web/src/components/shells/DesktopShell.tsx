// Desktop shell: sidebar + topbar + main content. Used for viewport > 768px.
// Wraps every route under app/(authenticated)/.
//
// Spec 128 — `navCounts`, `unreadCount`, and `queueDepth` arrive from the
// authenticated layout (the loaders are React.cache'd so a single request
// shares one round-trip). The shell forwards them to the Sidebar (counts)
// and the Topbar (unread + queue). When omitted, the chrome falls back to
// the prototype's static numbers and hidden chips.

import type { ReactNode } from "react";
import type { RoleName } from "@gml/shared/auth/roles";
import { Sidebar } from "@/components/nav/Sidebar";
import { Topbar } from "@/components/nav/Topbar";
import { ConfidentialityFooter } from "@/components/ConfidentialityFooter";
import type { NavCounts, QueueDepth } from "@/lib/chrome-counts";
import type { Locale } from "@/i18n/config";
import { MAIN_CONTENT_ID, SkipLink } from "./SkipLink";

type DesktopShellProps = {
  user: { id: string; name?: string | null; email?: string | null; role: RoleName; image?: string | null };
  breadcrumbs?: string[];
  activeNavId?: string;
  navCounts?: NavCounts;
  unreadCount?: number;
  queueDepth?: QueueDepth;
  /** Spec 155 — current UI locale, forwarded to the topbar language picker. */
  locale?: Locale;
  children: ReactNode;
};

export function DesktopShell({
  user,
  breadcrumbs,
  activeNavId,
  navCounts,
  unreadCount,
  queueDepth,
  locale,
  children,
}: DesktopShellProps) {
  // Spec 125 — Topbar and Sidebar are now async server components (they call
  // `getTranslations()`). React renders them as ordinary children because
  // RSC understands awaiting promise children at the framework boundary; no
  // Suspense fallback is needed because the JSON bundles are bundled in.
  return (
    <div style={{ display: "grid", gridTemplateColumns: "248px 1fr", minHeight: "100dvh", background: "var(--paper)" }}>
      {/* First in tab order, ahead of the sidebar. position:fixed (globals.css)
          keeps it out of the grid's column placement. */}
      <SkipLink />
      <Sidebar role={user.role} activeId={activeNavId} counts={navCounts} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar
          user={user}
          breadcrumbs={breadcrumbs}
          unreadCount={unreadCount}
          queueDepth={queueDepth}
          locale={locale}
        />
        {/* tabIndex -1: the skip link's target must take focus, so the next
            Tab starts inside the page rather than back at the sidebar. */}
        <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ flex: 1, padding: "20px 28px 80px" }}>
          {children}
        </main>
        <ConfidentialityFooter user={{ name: user.name, email: user.email }} />
      </div>
    </div>
  );
}
