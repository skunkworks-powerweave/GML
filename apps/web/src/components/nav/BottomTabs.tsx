// Mobile bottom tab bar. Ports `mobile-shell.jsx::MobBottomNav`.
//
// Spec 125 — tab labels translate via next-intl. Each tab id maps to a key
// under `nav.*`; tabs without an entry fall back to their English literal.
//
// Spec 128 — mobile bottom tabs also surface live counts when relevant. The
// `inbox` tab gets a tiny red dot when unread > 0, the `observe` tab gets a
// chip when cycles are in flight. We render a single small badge per tab
// (mobile real-estate is tight) and tolerate `counts` being absent.

import { getLocale, getTranslations } from "next-intl/server";
import { TABS_BY_ROLE } from "@/config/nav";
import type { NavCounts } from "@/lib/chrome-counts";
import type { RoleName } from "@gml/shared/auth/roles";
import { ActiveNavLink } from "./ActiveNavLink";
import { Icon } from "./Icon";

type BottomTabsProps = {
  role: RoleName;
  activeTab?: string;
  /** Spec 128 — live count badges keyed by nav id (see chrome-counts). */
  counts?: NavCounts;
  /** Spec 128 — unread notifications count; drives the inbox dot. */
  unreadCount?: number;
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
  // Without this entry the teacher's uploads tab fell through to its English
  // literal while the rest of the bar rendered in hi / bo.
  "uploads": "uploads",
  "menu": "menu",
};

/**
 * Tab id → the id of the sidebar item that leads to the same page, so the tab
 * carries the same data-help-anchor (`nav-<id>`). The first-run tour targets
 * those anchors; a phone renders no sidebar, so without them every step but
 * the last had nothing to point at. The two shells never render together, so
 * no anchor appears twice on a page. `inbox` has no sidebar item.
 */
const TAB_HELP_ANCHOR: Record<string, string> = {
  home: "dashboard",
  learn: "rtt",
  observe: "observation",
  pairings: "mentorship",
  repo: "repo",
  uploads: "uploads",
  data: "tbl-all",
  audit: "audit",
};

// id → resolver matching the same convention as the sidebar (chrome-counts.ts).
// Mobile tab ids ("observe", "pairings", "inbox") differ from sidebar nav ids
// so we keep the mapping local.
const TAB_BADGE: Record<string, (c: NavCounts, unread: number) => number | undefined> = {
  observe: (c) => c.cycles,
  pairings: (c) => c.mentees,
  inbox: (_, unread) => (unread > 0 ? unread : undefined),
};

export async function BottomTabs({ role, activeTab, counts, unreadCount = 0 }: BottomTabsProps) {
  const tabs = TABS_BY_ROLE[role] ?? TABS_BY_ROLE.teacher;
  const tNav = await getTranslations("nav");
  // Label size per script. 10px was set for every locale, which is small but
  // legible in Latin and not in Tibetan, whose stacked glyphs need both more
  // size and more line height; Devanagari's matras sit between the two.
  const locale = await getLocale();
  const label =
    locale === "bo" ? { fontSize: 12, lineHeight: 1.4 } : locale === "hi" ? { fontSize: 11, lineHeight: 1.3 } : { fontSize: 10 };
  return (
    <nav
      className="m-bottomnav"
      // Named, in the user's language: on a phone this bar is the ONLY
      // navigation, so it is the landmark a screen-reader user jumps to.
      aria-label={tNav("primary")}
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
        const badgeFn = TAB_BADGE[tab.id];
        const badgeVal = badgeFn ? badgeFn(counts ?? {}, unreadCount) : undefined;
        const badgeLabel =
          typeof badgeVal === "number" && badgeVal > 0
            ? badgeVal > 99
              ? "99+"
              : String(badgeVal)
            : null;
        return (
          <ActiveNavLink
            key={tab.id}
            role={role}
            id={tab.id}
            kind="tab"
            serverActive={activeTab === tab.id}
            href={tab.href}
            data-help-anchor={TAB_HELP_ANCHOR[tab.id] ? `nav-${TAB_HELP_ANCHOR[tab.id]}` : undefined}
            // The 3px bar and the weight change are visual only; the current
            // tab is stated by aria-current (ActiveNavLink).
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              padding: "8px 0 10px",
              color: "var(--ink-3)",
              ...label,
              fontWeight: 400,
              textDecoration: "none",
              position: "relative",
            }}
            activeStyle={{ color: "var(--ink)", fontWeight: 500 }}
          >
            {/* The bar over the current tab: globals.css draws it from the
                link's aria-current, which follows client navigation. */}
            <span
              className="m-tab-indicator"
              style={{
                position: "absolute",
                top: 0,
                width: 32,
                height: 3,
                borderRadius: "0 0 3px 3px",
              }}
            />
            <span style={{ position: "relative", display: "inline-flex" }}>
              <Icon name={tab.icon} size={20} stroke={1.5} />
              {badgeLabel != null ? (
                <span
                  data-testid={`bottomtab-badge-${tab.id}`}
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -10,
                    minWidth: 14,
                    height: 14,
                    padding: "0 4px",
                    borderRadius: 999,
                    background: tab.id === "inbox" ? "var(--saffron)" : "var(--ink)",
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
                  {badgeLabel}
                </span>
              ) : null}
            </span>
            <span>{TAB_KEY[tab.id] ? tNav(TAB_KEY[tab.id]) : tab.label}</span>
          </ActiveNavLink>
        );
      })}
    </nav>
  );
}
