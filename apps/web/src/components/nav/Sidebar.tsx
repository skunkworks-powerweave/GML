// Desktop sidebar. 1:1 ports `shell.jsx::Sidebar`. Reads NAV_BY_ROLE, renders
// grouped sections with optional gate badges and counts.
//
// Spec 125 — section headings and item labels translate via next-intl. Each
// nav entry's `id` is mapped (via ITEM_KEY) to a translation key under
// `nav.*`; section literals map (via SECTION_KEY) to `navSection.*`. Missing
// keys fall through to the original English label so the chrome stays
// readable while translation work catches up.
//
// Spec 128 — count badges (the `5` on "My mentees" etc) now come from the
// authenticated layout's `loadNavCounts()` call and arrive as the `counts`
// prop. The sidebar merges them into the static NAV_BY_ROLE config via
// `applyNavCounts` so a nav row with an id in the merge map gets its live
// number, and any row without a live mapping keeps the prototype number (or
// none). When counts is missing the static prototype numbers still render —
// chrome stays readable in degraded mode.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { NAV_BY_ROLE } from "@/config/nav";
import { applyNavCounts, type NavCounts } from "@/lib/chrome-counts";
import type { RoleName } from "@gml/shared/auth/roles";
import { NetworkStatus } from "./NetworkStatus";
import { Icon } from "./Icon";

type SidebarProps = {
  role: RoleName;
  /** Slug of the currently active route's nav id (best-effort highlight). */
  activeId?: string;
  /** Spec 128 — live count badges keyed by nav item id. Optional; falls back
   * to NAV_BY_ROLE's static prototype numbers when absent. */
  counts?: NavCounts;
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

/**
 * Nav item id → `nav.*` key. Items not in the map fall back to item.label.
 *
 * FOUR IDS ARE DELIBERATELY ABSENT: observation, mentorship, rtt and videos.
 *
 * NAV_BY_ROLE reuses those ids across roles with DIFFERENT labels by design --
 * `videos` is "Video library" for an admin and "Pending review" for a mentor;
 * `observation` is "Classroom Observation", "Observation cycles" or "My
 * observations" depending on who is looking. This map is keyed by id alone, so
 * whichever single translation existed overwrote all of them: a mentor's
 * sidebar said "Video library" and "Mentorship" instead of "Pending review" and
 * "My mentees". Not a translation bug -- it showed the wrong label in English
 * too, which is how it went unnoticed in a programme whose default locale is
 * English.
 *
 * Falling back to item.label restores the role-specific wording everywhere.
 * The cost is that those four are not translated: fixing that properly needs
 * per-role keys in the dictionaries (nav.videos.mentor and so on), which is a
 * content change across en/hi/bo, not a code change. Showing the right label
 * untranslated beats showing the wrong one in three languages.
 */
const ITEM_KEY: Record<string, string> = {
  "dashboard": "dashboard",
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

export async function Sidebar({ role, activeId, counts }: SidebarProps) {
  // Static config + live counts merge. When `counts` is absent (layout opted
  // out, or the chrome is rendered outside the authenticated route group),
  // applyNavCounts is a no-op and the prototype's seed numbers remain.
  const baseSections = NAV_BY_ROLE[role] ?? NAV_BY_ROLE.teacher;
  const sections = counts ? applyNavCounts(baseSections, counts) : baseSections;
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
                  {/* `> 0`, not `!= null`. A count badge showing 0 is noise at
                      best, and on "Forms & quizzes" it was actively wrong: that
                      badge counts the viewer's own in-flight autosave DRAFTS
                      (chrome-counts.ts pendingForms), so a super_admin with no
                      half-finished form saw a black "0" pill that reads as
                      "there are no forms" -- next to a catalogue holding ten.
                      BottomTabs already used `> 0`; the two shells disagreed. */}
                  {typeof item.count === "number" && item.count > 0 ? (
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

      {/* Network status -- a real probe, not a green dot. See NetworkStatus.tsx. */}
      <NetworkStatus
        labelOnline={tStatus("online")}
        labelOffline={tStatus("offline")}
        labelChecking={tStatus("checking")}
        hintOnline={tStatus("onlineHint")}
        hintOffline={tStatus("offlineHint")}
        hintChecking={tStatus("checkingHint")}
      />
    </aside>
  );
}
