// Mobile bottom tab bar. Ports `mobile-shell.jsx::MobBottomNav`.
//
// Spec 125 — tab labels translate via next-intl. Each tab id maps to a key
// under `nav.*`; tabs without an entry fall back to their English literal.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { TABS_BY_ROLE } from "@/config/nav";
import type { RoleName } from "@gml/shared/auth/roles";
import { Icon } from "./Icon";

type BottomTabsProps = {
  role: RoleName;
  activeTab?: string;
};

/** Tab id → `nav.*` translation key. */
const TAB_KEY: Record<string, string> = {
  "home": "dashboard",
  "learn": "rtt",
  "observe": "observation",
  "pairings": "mentorship",
  "repo": "repo",
  "inbox": "inbox",
  "data": "data",
  "audit": "audit",
};

export async function BottomTabs({ role, activeTab }: BottomTabsProps) {
  const tabs = TABS_BY_ROLE[role] ?? TABS_BY_ROLE.teacher;
  const tNav = await getTranslations("nav");
  return (
    <nav
      className="m-bottomnav"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20,
        display: "grid",
        gridTemplateColumns: `repeat(${tabs.length}, 1fr)`,
        background: "var(--card-hi)",
        borderTop: "1px solid var(--line)",
        boxShadow: "var(--shadow-2)",
        paddingBottom: "env(safe-area-inset-bottom, 0)",
      }}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              padding: "8px 0 10px",
              color: isActive ? "var(--ink)" : "var(--ink-3)",
              fontSize: 10,
              fontWeight: isActive ? 500 : 400,
              textDecoration: "none",
              position: "relative",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 0,
                width: 32,
                height: 3,
                borderRadius: "0 0 3px 3px",
                background: isActive ? "var(--ink)" : "transparent",
              }}
            />
            <Icon name={tab.icon} size={20} stroke={1.5} />
            <span>{TAB_KEY[tab.id] ? tNav(TAB_KEY[tab.id]) : tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
