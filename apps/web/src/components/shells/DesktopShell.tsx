// Desktop shell: sidebar + topbar + main content. Used for viewport > 768px.
// Wraps every route under app/(authenticated)/.

import type { ReactNode } from "react";
import type { RoleName } from "@gml/shared/auth/roles";
import { Sidebar } from "@/components/nav/Sidebar";
import { Topbar } from "@/components/nav/Topbar";
import { ConfidentialityFooter } from "@/components/ConfidentialityFooter";

type DesktopShellProps = {
  user: { id: string; name?: string | null; email?: string | null; role: RoleName; image?: string | null };
  breadcrumbs?: string[];
  activeNavId?: string;
  children: ReactNode;
};

export function DesktopShell({ user, breadcrumbs, activeNavId, children }: DesktopShellProps) {
  // Spec 125 — Topbar and Sidebar are now async server components (they call
  // `getTranslations()`). React renders them as ordinary children because
  // RSC understands awaiting promise children at the framework boundary; no
  // Suspense fallback is needed because the JSON bundles are bundled in.
  return (
    <div style={{ display: "grid", gridTemplateColumns: "248px 1fr", minHeight: "100dvh", background: "var(--paper)" }}>
      <Sidebar role={user.role} activeId={activeNavId} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar user={user} breadcrumbs={breadcrumbs} />
        <main style={{ flex: 1, padding: "20px 28px 80px" }}>{children}</main>
        <ConfidentialityFooter user={{ name: user.name, email: user.email }} />
      </div>
    </div>
  );
}
