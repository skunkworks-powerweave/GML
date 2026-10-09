// Desktop sidebar. 1:1 ports `shell.jsx::Sidebar`. Reads NAV_BY_ROLE, renders
// grouped sections with optional gate badges and counts.
//
// Spec 125 — section headings and item labels translate via next-intl. Each
// nav entry names its `nav.*` key (NavItem.labelKey) and each section its
// `navSection.*` key, in config/nav.ts. There is no English fallback: an item
// without a key used to render its English literal in every locale.
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
import { NetworkStatusServer } from "./NetworkStatusServer";
import { ActiveNavLink } from "./ActiveNavLink";
import { Icon } from "./Icon";

type SidebarProps = {
  role: RoleName;
  /** Slug of the currently active route's nav id (best-effort highlight). */
  activeId?: string;
  /** Spec 128 — live count badges keyed by nav item id. Optional; falls back
   * to NAV_BY_ROLE's static prototype numbers when absent. */
  counts?: NavCounts;
  /**
   * An administrator-set password must be replaced before anything else, and
   * until it is the proxy sends every page to Settings. The menu stays (it is
   * the map of what is coming) but is dimmed, under a note that says why and
   * links to the form.
   */
  locked?: boolean;
};

export async function Sidebar({ role, activeId, counts, locked = false }: SidebarProps) {
  // Static config + live counts merge. When `counts` is absent (layout opted
  // out, or the chrome is rendered outside the authenticated route group),
  // applyNavCounts is a no-op and the prototype's seed numbers remain.
  const baseSections = NAV_BY_ROLE[role] ?? NAV_BY_ROLE.teacher;
  const sections = counts ? applyNavCounts(baseSections, counts) : baseSections;
  const tNav = await getTranslations("nav");
  const tSection = await getTranslations("navSection");
  const tBrand = await getTranslations("brand");
  const tRole = await getTranslations("role");
  const tGate = await getTranslations("gate");
  const t = await getTranslations("home");

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
          {/* The role by name, in the user's language -- this printed the
              raw slug ("teacher", "super admin") in every locale. */}
          {tBrand("subtitle")} · {tRole(role)}
        </div>
      </div>

      {locked ? (
        <Link
          href="/settings#change-password"
          id="nav-locked-note"
          data-testid="nav-locked"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            padding: "8px 10px",
            background: "var(--saffron-soft)",
            border: "1px solid oklch(0.82 0.08 60)",
            borderRadius: "var(--r-2)",
            color: "var(--ink)",
            fontSize: 12,
            lineHeight: 1.4,
            textDecoration: "none",
          }}
        >
          <Icon name="lock" size={14} />
          <span>{t("chrome.menuLocked")}</span>
        </Link>
      ) : null}

      {sections.map((section) => {
        const sectionLabel = tSection(section.section);
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
          {/* Named by its (translated) section heading. Unnamed, a
              super_admin heard four identical "navigation" landmarks. */}
          <nav aria-label={sectionLabel} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {section.items.map((item) => {
              // Its own key, not one looked up by id: NAV_BY_ROLE reuses ids
              // with different labels per role (`videos` is "Video library"
              // for an admin, "Pending review" for a mentor), and an id-keyed
              // map once gave a mentor the admin's wording.
              const itemLabel = tNav(item.labelKey);
              // Locked: dimmed, and stated as unavailable with the note as the
              // reason -- a screen reader heard a plain link that went nowhere.
              // Settings itself stays as it is: it is where the note sends you.
              const itemLocked = locked && item.href !== "/settings";
              return (
                <ActiveNavLink
                  key={item.id}
                  role={role}
                  id={item.id}
                  kind="sidebar"
                  serverActive={activeId === item.id}
                  href={item.href}
                  data-help-anchor={`nav-${item.id}`}
                  aria-disabled={itemLocked || undefined}
                  aria-describedby={itemLocked ? "nav-locked-note" : undefined}
                  // The current page is stated (aria-current), not only drawn
                  // with a background and a border.
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "6px 8px",
                    position: "relative",
                    borderRadius: "var(--r-2)",
                    color: "var(--ink-2)",
                    background: "transparent",
                    fontSize: 13,
                    fontWeight: 400,
                    textDecoration: "none",
                    border: "1px solid transparent",
                    opacity: itemLocked ? 0.5 : undefined,
                  }}
                  activeStyle={{ color: "var(--ink)", background: "var(--card-hi)", fontWeight: 500, border: "1px solid var(--line)" }}
                >
                  <Icon name={item.icon} size={14} />
                  <span style={{ flex: 1 }}>{itemLabel}</span>
                  {item.gate ? (
                    // The tooltip names the section as the gate page does
                    // (gate.<slug>Title). It was English in every locale, and
                    // gave the raw slug: "Section gate: mentorship".
                    <span
                      title={`${tGate("title")}: ${tGate(`${item.gate}Title`)}`}
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
                      {t("chrome.gateBadge")}
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
                </ActiveNavLink>
              );
            })}
          </nav>
        </div>
        );
      })}

      {/* Network status -- a real probe, not a green dot. See NetworkStatus.tsx. */}
      <NetworkStatusServer variant="sidebar" />
    </aside>
  );
}
