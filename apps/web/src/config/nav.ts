// Role-aware navigation map. Ported 1:1 from `LMS GML Frontend/shell.jsx::NAV_BY_ROLE`
// (desktop) and `mobile-shell.jsx::TABS_BY_ROLE` (mobile bottom tabs).
//
// Adding a new route = adding a NavItem here. The Sidebar + BottomTabs
// components render entirely from this config; no role-branching in JSX.

import type { RoleName } from "@gml/shared/auth/roles";

export type NavItem = {
  id: string;
  label: string;
  icon: string;
  href: string;
  /** Section-gate slug. Visiting this route prompts for the gate password if not unlocked. */
  gate?: "mentorship" | "observation" | "admin" | "tkt" | "ttt";
  /** Count badge (mentor sees "5 mentees", etc.). Static for now; spec 057 wires real counts. */
  count?: number;
};

export type NavSection = {
  section: string;
  items: NavItem[];
};

/**
 * Desktop sidebar groups. Match `shell.jsx::NAV_BY_ROLE` exactly.
 */
export const NAV_BY_ROLE: Record<RoleName, NavSection[]> = {
  super_admin: [
    {
      section: "Programme",
      items: [
        { id: "dashboard", label: "Dashboard", icon: "home", href: "/dashboard" },
        { id: "observation", label: "Classroom Observation", icon: "eye", href: "/observation", gate: "observation" },
        { id: "mentorship", label: "Mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "rtt", label: "RTT Phases", icon: "mountain", href: "/rtt" },
        { id: "videos", label: "Video library", icon: "video", href: "/videos" },
      ],
    },
    {
      section: "Repository",
      items: [
        { id: "repo", label: "Home", icon: "book", href: "/repo" },
        { id: "repo-schools", label: "Schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", label: "Subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", label: "Course outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", label: "Sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", label: "Reading material", icon: "pdf", href: "/repo/resources" },
      ],
    },
    {
      section: "Data",
      items: [
        { id: "tbl-teachers", label: "Teachers", icon: "users", href: "/admin/data/teachers" },
        { id: "tbl-schools", label: "Schools", icon: "school", href: "/admin/data/schools" },
        { id: "tbl-mentors", label: "Mentors", icon: "users", href: "/admin/data/mentors" },
        { id: "tbl-pairings", label: "Pairings", icon: "users", href: "/admin/data/mentor-pairings" },
        { id: "tbl-attendance", label: "Attendance", icon: "table", href: "/admin/data/rtt-attendance" },
      ],
    },
    {
      section: "System",
      items: [
        { id: "users", label: "Users", icon: "users", href: "/admin/users" },
        { id: "audit", label: "Audit log", icon: "shield", href: "/admin/audit", gate: "admin" },
        { id: "gates", label: "Section gates", icon: "lock", href: "/admin/gates" },
        { id: "forms", label: "Forms & quizzes", icon: "file", href: "/admin/forms" },
        { id: "settings", label: "Settings", icon: "settings", href: "/settings" },
      ],
    },
  ],

  programme_admin: [
    {
      section: "Programme",
      items: [
        { id: "dashboard", label: "Dashboard", icon: "home", href: "/dashboard" },
        { id: "observation", label: "Classroom Observation", icon: "eye", href: "/observation", gate: "observation" },
        { id: "mentorship", label: "Mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "rtt", label: "RTT Phases", icon: "mountain", href: "/rtt" },
        { id: "videos", label: "Video library", icon: "video", href: "/videos" },
      ],
    },
    {
      section: "Repository",
      items: [
        { id: "repo", label: "Home", icon: "book", href: "/repo" },
        { id: "repo-schools", label: "Schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", label: "Subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", label: "Course outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", label: "Sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", label: "Reading material", icon: "pdf", href: "/repo/resources" },
      ],
    },
    {
      section: "Data",
      items: [
        { id: "tbl-teachers", label: "Teachers", icon: "users", href: "/admin/data/teachers" },
        { id: "tbl-schools", label: "Schools", icon: "school", href: "/admin/data/schools" },
        { id: "tbl-pairings", label: "Pairings", icon: "users", href: "/admin/data/mentor-pairings" },
      ],
    },
    {
      section: "System",
      items: [
        { id: "users", label: "Users", icon: "users", href: "/admin/users" },
        { id: "audit", label: "Audit log", icon: "shield", href: "/admin/audit", gate: "admin" },
        { id: "forms", label: "Forms & quizzes", icon: "file", href: "/admin/forms" },
      ],
    },
  ],

  mentor: [
    {
      section: "My work",
      items: [
        { id: "dashboard", label: "Dashboard", icon: "home", href: "/dashboard" },
        { id: "mentorship", label: "My mentees", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "observation", label: "Observation cycles", icon: "eye", href: "/observation", gate: "observation" },
        { id: "videos", label: "Pending review", icon: "video", href: "/videos" },
      ],
    },
    {
      section: "Programme",
      items: [
        { id: "rtt", label: "RTT Phases", icon: "mountain", href: "/rtt" },
        { id: "forms", label: "Forms & quizzes", icon: "file", href: "/forms" },
      ],
    },
    {
      section: "Repository",
      items: [
        { id: "repo", label: "Home", icon: "book", href: "/repo" },
        { id: "repo-schools", label: "Schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", label: "Subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", label: "Course outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", label: "Sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", label: "Reading material", icon: "pdf", href: "/repo/resources" },
      ],
    },
  ],

  observer: [
    {
      section: "My work",
      items: [
        { id: "dashboard", label: "Dashboard", icon: "home", href: "/dashboard" },
        { id: "observation", label: "Observation cycles", icon: "eye", href: "/observation", gate: "observation" },
        { id: "videos", label: "Video library", icon: "video", href: "/videos" },
      ],
    },
    {
      section: "Repository",
      items: [
        { id: "repo", label: "Home", icon: "book", href: "/repo" },
        { id: "repo-schools", label: "Schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", label: "Subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", label: "Course outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", label: "Sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", label: "Reading material", icon: "pdf", href: "/repo/resources" },
      ],
    },
  ],

  teacher: [
    {
      section: "My learning",
      items: [
        { id: "dashboard", label: "Dashboard", icon: "home", href: "/dashboard" },
        { id: "rtt", label: "My phase", icon: "mountain", href: "/rtt" },
        { id: "observation", label: "My observations", icon: "eye", href: "/observation" },
        { id: "uploads", label: "My uploads", icon: "upload", href: "/uploads" },
      ],
    },
    {
      section: "Repository",
      items: [
        { id: "repo", label: "Home", icon: "book", href: "/repo" },
        { id: "repo-schools", label: "Schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", label: "Subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", label: "Course outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", label: "Sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", label: "Reading material", icon: "pdf", href: "/repo/resources" },
      ],
    },
    {
      section: "Resources",
      items: [
        { id: "forms", label: "Forms & quizzes", icon: "file", href: "/forms" },
      ],
    },
  ],
};

/**
 * Mobile bottom tabs. Match `mobile-shell.jsx::TABS_BY_ROLE`.
 * Max 5 tabs per role. `inbox` becomes `audit` for super_admin.
 */
export type MobileTab = {
  id: string;
  label: string;
  icon: string;
  href: string;
  gate?: NavItem["gate"];
};

export const TABS_BY_ROLE: Record<RoleName, MobileTab[]> = {
  teacher: [
    { id: "home", label: "Home", icon: "home", href: "/dashboard" },
    { id: "learn", label: "Learn", icon: "book", href: "/rtt" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation" },
    { id: "repo", label: "Repo", icon: "table", href: "/repo" },
    { id: "inbox", label: "Inbox", icon: "chat", href: "/inbox" },
  ],
  mentor: [
    { id: "home", label: "Today", icon: "home", href: "/dashboard" },
    { id: "pairings", label: "Mentees", icon: "users", href: "/mentorship", gate: "mentorship" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", label: "Repo", icon: "table", href: "/repo" },
    { id: "inbox", label: "Inbox", icon: "chat", href: "/inbox" },
  ],
  observer: [
    { id: "home", label: "Today", icon: "home", href: "/dashboard" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", label: "Repo", icon: "table", href: "/repo" },
    { id: "inbox", label: "Inbox", icon: "chat", href: "/inbox" },
  ],
  programme_admin: [
    { id: "home", label: "Home", icon: "home", href: "/dashboard" },
    { id: "data", label: "Data", icon: "table", href: "/admin" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", label: "Repo", icon: "book", href: "/repo" },
    { id: "inbox", label: "Inbox", icon: "chat", href: "/inbox" },
  ],
  super_admin: [
    { id: "home", label: "Home", icon: "home", href: "/dashboard" },
    { id: "data", label: "Data", icon: "table", href: "/admin" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", label: "Repo", icon: "book", href: "/repo" },
    { id: "audit", label: "Audit", icon: "shield", href: "/admin/audit", gate: "admin" },
  ],
};

/**
 * Which nav entry does this pathname belong to?
 *
 * Both shells accept an active-item id, both forward it to their nav
 * components, and NO CALLER HAS EVER SUPPLIED ONE -- so `isActive` was false
 * for every item on every page and nothing was ever highlighted. On a product
 * whose nav spans three sections and eleven entries, "where am I" was
 * unanswerable from the chrome.
 *
 * Longest-prefix wins, which is what makes nested routes resolve correctly:
 * /repo/schools must match the `repo-schools` entry and not the `repo` one
 * that also prefixes it. A bare "/" href would prefix everything, so it is
 * excluded from prefix matching and only ever matches exactly.
 */
export function activeNavIdFor(
  role: RoleName,
  pathname: string | null | undefined,
): string | undefined {
  if (!pathname) return undefined;
  const path = pathname.split("?")[0] ?? pathname;

  let best: { id: string; len: number } | undefined;
  for (const section of NAV_BY_ROLE[role] ?? []) {
    for (const item of section.items) {
      const href = item.href;
      const matches =
        href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
      if (matches && (!best || href.length > best.len)) best = { id: item.id, len: href.length };
    }
  }
  return best?.id;
}

/** The same resolution for the mobile bottom tabs, which use their own ids. */
export function activeTabIdFor(
  role: RoleName,
  pathname: string | null | undefined,
): string | undefined {
  if (!pathname) return undefined;
  const path = pathname.split("?")[0] ?? pathname;

  let best: { id: string; len: number } | undefined;
  for (const tab of TABS_BY_ROLE[role] ?? TABS_BY_ROLE.teacher) {
    const href = tab.href;
    const matches = href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
    if (matches && (!best || href.length > best.len)) best = { id: tab.id, len: href.length };
  }
  return best?.id;
}
