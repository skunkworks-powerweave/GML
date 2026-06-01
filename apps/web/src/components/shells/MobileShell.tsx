// Mobile shell: top app bar + content + bottom tabs. Used for viewport ≤ 768px.
// Floating ? button + sheet overlay land in spec 032.
//
// Spec 125 — the BottomTabs subcomponent has become an async server component
// (it calls `getTranslations()`). RSC handles awaiting async children at the
// render boundary; this wrapper stays a plain sync function so the spec 026
// "export function MobileShell" contract still matches.

import type { ReactNode } from "react";
import type { RoleName } from "@gml/shared/auth/roles";
import { BottomTabs } from "@/components/nav/BottomTabs";
import { ConfidentialityFooter } from "@/components/ConfidentialityFooter";
import { MobileHelpFAB } from "@/components/MobileHelpFAB";

type MobileShellProps = {
  user: { id: string; name?: string | null; email?: string | null; role: RoleName; image?: string | null };
  title?: string;
  activeTab?: string;
  children: ReactNode;
};

export function MobileShell({ user, title, activeTab, children }: MobileShellProps) {
  return (
    <div style={{ minHeight: "100dvh", background: "var(--paper)", paddingBottom: 80 }}>
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
        <span
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
          }}
          title={user.email ?? ""}
        >
          {(user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase()}
        </span>
      </header>
      <main style={{ padding: "16px" }}>{children}</main>
      <ConfidentialityFooter user={{ name: user.name, email: user.email }} compact />
      <MobileHelpFAB />
      <BottomTabs role={user.role} activeTab={activeTab} />
    </div>
  );
}
