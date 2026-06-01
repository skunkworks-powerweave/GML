// Mobile bottom tab bar. Ports `mobile-shell.jsx::MobBottomNav`.

import Link from "next/link";
import { TABS_BY_ROLE } from "@/config/nav";
import type { RoleName } from "@gml/shared/auth/roles";
import { Icon } from "./Icon";

type BottomTabsProps = {
  role: RoleName;
  activeTab?: string;
};

export function BottomTabs({ role, activeTab }: BottomTabsProps) {
  const tabs = TABS_BY_ROLE[role] ?? TABS_BY_ROLE.teacher;
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
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
