// Desktop sidebar. 1:1 ports `shell.jsx::Sidebar`. Reads NAV_BY_ROLE, renders
// grouped sections with optional gate badges and counts.
//
// Spec 125 — section headings and item labels translate via next-intl. Each
// nav entry's `id` is mapped (via ITEM_KEY) to a translation key under
// `nav.*`; section literals map (via SECTION_KEY) to `navSection.*`. Missing
// keys fall through to the original English label so the chrome stays
// readable while translation work catches up.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { NAV_BY_ROLE } from "@/config/nav";
import type { RoleName } from "@gml/shared/auth/roles";
import { Icon } from "./Icon";

type SidebarProps = {
  role: RoleName;
  /** Slug of the currently active route's nav id (best-effort highlight). */
  activeId?: string;
};

/** Section heading literal → `navSection.*` key. */
const SECTION_KEY: Record<string, string> = {
  "Programme": "programme",
  "My work": "myWork",
  "My learning": "myLearning",
  "Repository": "repository",
  "Data": "data",
  "System": "system",
  "Resources": "resources",
};

/** Nav item id → `nav.*` key. Items not in the map fall back to item.label. */
const ITEM_KEY: Record<string, string> = {
  "dashboard": "dashboard",
  "observation": "observation",
  "mentorship": "mentorship",
  "rtt": "rtt",
  "videos": "videos",
  "repo": "repoHome",
  "repo-schools": "schools",
  "repo-subjects": "subjects",
  "repo-outlines": "outlines",
  "repo-sessions": "sessions",
  "repo-resources": "resources",
  "tbl-teachers": "teachers",
  "tbl-schools": "schools",
  "tbl-mentors": "mentors",
  "tbl-pairings": "pairings",
  "tbl-attendance": "attendance",
  "audit": "audit",
  "gates": "gates",
  "forms": "forms",
  "settings": "settings",
  "uploads": "uploads",
};

export async function Sidebar({ role, activeId }: SidebarProps) {
  const sections = NAV_BY_ROLE[role] ?? NAV_BY_ROLE.teacher;
  const tNav = await getTranslations("nav");
  const tSection = await getTranslations("navSection");
  const tStatus = await getTranslations("status");
  const tBrand = await getTranslations("brand");

  return (
    <aside
      className="sidebar"
      style={{
        width: 248,
        height: "100dvh",
        borderRight: "1px solid var(--line)",
        background: "var(--paper)",
        position: "sticky",
        top: 0,
        overflowY: "auto",
        padding: "16px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {/* Brand */}
      <div style={{ padding: "4px 8px 4px" }}>
        <div
          style={{
            fontFamily: "var(--serif)",
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--ink)",
          }}
        >
          {tBrand("name")}
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {tBrand("subtitle")} · {role.replace("_", " ")}
        </div>
      </div>

      {sections.map((section) => {
        const sectionKey = SECTION_KEY[section.section];
        const sectionLabel = sectionKey ? tSection(sectionKey) : section.section;
        return (
        <div key={section.section}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-4)",
              padding: "0 8px 6px",
            }}
          >
            {sectionLabel}
          </div>
          <nav style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {section.items.map((item) => {
              const isActive = activeId === item.id;
              const itemKey = ITEM_KEY[item.id];
              const itemLabel = itemKey ? tNav(itemKey) : item.label;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  data-help-anchor={`nav-${item.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "6px 8px",
                    borderRadius: "var(--r-2)",
                    color: isActive ? "var(--ink)" : "var(--ink-2)",
                    background: isActive ? "var(--card-hi)" : "transparent",
                    fontSize: 13,
                    fontWeight: isActive ? 500 : 400,
                    textDecoration: "none",
                    border: isActive ? "1px solid var(--line)" : "1px solid transparent",
                  }}
                >
                  <Icon name={item.icon} size={14} />
                  <span style={{ flex: 1 }}>{itemLabel}</span>
                  {item.gate ? (
                    <span
                      title={`Section gate: ${item.gate}`}
                      style={{
                        fontSize: 9,
                        padding: "1px 5px",
                        background: "var(--saffron-soft)",
                        color: "var(--ink-2)",
                        borderRadius: 4,
                        fontFamily: "var(--mono)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      gate
                    </span>
                  ) : null}
                  {item.count != null ? (
                    <span
                      style={{
                        fontSize: 11,
                        padding: "1px 6px",
                        background: "var(--ink)",
                        color: "var(--paper)",
                        borderRadius: 999,
                        fontFamily: "var(--mono)",
                      }}
                    >
                      {item.count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
        </div>
        );
      })}

      {/* Network status — cosmetic per v2 plan (no PWA / offline queue) */}
      <div
        style={{
          marginTop: "auto",
          padding: "8px 8px 4px",
          fontSize: 11,
          color: "var(--ink-3)",
          borderTop: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--lichen)",
            display: "inline-block",
          }}
        />
        {tStatus("online")}
      </div>
    </aside>
  );
}
