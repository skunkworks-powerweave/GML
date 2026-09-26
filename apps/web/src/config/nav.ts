// Role-aware navigation map. Ported 1:1 from `LMS GML Frontend/shell.jsx::NAV_BY_ROLE`
// (desktop) and `mobile-shell.jsx::TABS_BY_ROLE` (mobile bottom tabs).
//
// Adding a new route = adding a NavItem here. The Sidebar + BottomTabs
// components render entirely from this config; no role-branching in JSX.

import type { RoleName } from "@gml/shared/auth/roles";

export type NavItem = {
  id: string;
  label: string;
  /**
   * The nav.* translation key for `label`, where the id alone cannot say it:
   * observation, mentorship, rtt and videos carry different labels for
   * different roles, so Sidebar's id-keyed ITEM_KEY cannot hold them.
   */
  labelKey?: string;
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
        { id: "observation", label: "Classroom Observation", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
        { id: "mentorship", label: "Mentorship", labelKey: "mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "rtt", label: "RTT Phases", labelKey: "rtt", icon: "mountain", href: "/rtt" },
        { id: "videos", label: "Video library", labelKey: "videos", icon: "video", href: "/videos" },
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
        // The index of ALL 20 tables. Without it the desktop sidebar reached 5
        // of them, and classes, learners, sessions, resources, RTT content and
        // observation cycles -- the tables a fresh deployment is empty in --
        // could only be found by typing /admin. README-deploy.md section 3.2.
        { id: "tbl-all", label: "All tables", icon: "table", href: "/admin" },
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
        { id: "observation", label: "Classroom Observation", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
        { id: "mentorship", label: "Mentorship", labelKey: "mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "rtt", label: "RTT Phases", labelKey: "rtt", icon: "mountain", href: "/rtt" },
        { id: "videos", label: "Video library", labelKey: "videos", icon: "video", href: "/videos" },
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
        // See the super_admin Data section: the index of every table.
        { id: "tbl-all", label: "All tables", icon: "table", href: "/admin" },
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
        { id: "mentorship", label: "My mentees", labelKey: "myMentees", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "observation", label: "Observation cycles", labelKey: "observationCycles", icon: "eye", href: "/observation", gate: "observation" },
        // The teach-back review queue. This item linked to /videos, which has
        // no review control, so the badge pointed at nothing a mentor could do.
        { id: "teach-back", label: "Pending review", labelKey: "pendingReview", icon: "video", href: "/rtt/teach-back?status=review_pending" },
        { id: "videos", label: "Video library", labelKey: "videos", icon: "video", href: "/videos" },
      ],
    },
    {
      section: "Programme",
      items: [
        { id: "rtt", label: "RTT Phases", labelKey: "rtt", icon: "mountain", href: "/rtt" },
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
        { id: "observation", label: "Observation cycles", labelKey: "observationCycles", icon: "eye", href: "/observation", gate: "observation" },
        // Observers may review teach-backs (rtt/teach-back READ_ROLES) and had
        // no way to reach the queue.
        { id: "teach-back", label: "Pending review", labelKey: "pendingReview", icon: "video", href: "/rtt/teach-back?status=review_pending" },
        { id: "videos", label: "Video library", labelKey: "videos", icon: "video", href: "/videos" },
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
        { id: "rtt", label: "My phase", labelKey: "myPhase", icon: "mountain", href: "/rtt" },
        { id: "observation", label: "My observations", labelKey: "myObservations", icon: "eye", href: "/observation" },
        // Her pairing: its meetings, her Q1/Q4 videos and her reflections. A
        // teacher could reach it only from an inbox notification.
        { id: "mentorship", label: "Mentorship", labelKey: "mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
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
 * Give every role a link to its own settings page.
 *
 * `/settings` appeared in NAV_BY_ROLE for super_admin ONLY, so a
 * programme_admin, mentor, observer or teacher had no link to it anywhere in
 * the application. That page is where the interface language is chosen -- in a
 * programme that ships en/hi/bo -- and where the self-service password change
 * lives, so four of the five roles could reach neither except by typing the URL.
 *
 * Appended here rather than added to five separate arrays so a role added later
 * cannot be forgotten: whatever sections a role declares, it ends up with this
 * one.
 */
for (const role of Object.keys(NAV_BY_ROLE) as RoleName[]) {
  const sections = NAV_BY_ROLE[role];
  const hasSettings = sections.some((sec) => sec.items.some((i) => i.href === "/settings"));
  if (hasSettings) continue;
  sections.push({
    section: "Your account",
    items: [{ id: "settings", label: "Settings", icon: "settings", href: "/settings" }],
  });
}

export type MobileTab = {
  id: string;
  label: string;
  icon: string;
  href: string;
  gate?: NavItem["gate"];
};

/**
 * The role's whole navigation on a phone (/menu). The tab bar holds five or
 * six destinations and a phone has no sidebar, so everything else -- a
 * mentee's pairing and forms, the review queue, Forms & quizzes, the
 * repository pages -- had no mobile route at all.
 */
const MENU_TAB: MobileTab = { id: "menu", label: "Menu", icon: "menu", href: "/menu" };

/**
 * Mobile bottom tabs, after `mobile-shell.jsx::TABS_BY_ROLE`, each ending in
 * Menu. `inbox` becomes `audit` for super_admin; the teacher's Repo tab gave
 * way to Uploads and lives in Menu.
 */
export const TABS_BY_ROLE: Record<RoleName, MobileTab[]> = {
  teacher: [
    { id: "home", label: "Home", icon: "home", href: "/dashboard" },
    { id: "learn", label: "Learn", icon: "book", href: "/rtt" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation" },
    { id: "inbox", label: "Inbox", icon: "chat", href: "/inbox" },
    // /uploads was in the DESKTOP sidebar only. A phone has no sidebar, so a
    // teacher could reach her uploads page -- the only mount of the mobile
    // camera/resumable-upload runner -- solely through a dashboard to-do row
    // that appears while a cycle is awaiting a video. Teachers are the most
    // phone-heavy group in the programme. The grid in BottomTabs sizes itself
    // from tabs.length; the label renders via nav.uploads (TAB_KEY), this
    // literal is only the fallback.
    { id: "uploads", label: "Uploads", icon: "upload", href: "/uploads" },
    MENU_TAB,
  ],
  mentor: [
    { id: "home", label: "Today", icon: "home", href: "/dashboard" },
    { id: "pairings", label: "Mentees", icon: "users", href: "/mentorship", gate: "mentorship" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", label: "Repo", icon: "table", href: "/repo" },
    { id: "inbox", label: "Inbox", icon: "chat", href: "/inbox" },
    MENU_TAB,
  ],
  observer: [
    { id: "home", label: "Today", icon: "home", href: "/dashboard" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", label: "Repo", icon: "table", href: "/repo" },
    { id: "inbox", label: "Inbox", icon: "chat", href: "/inbox" },
    MENU_TAB,
  ],
  programme_admin: [
    { id: "home", label: "Home", icon: "home", href: "/dashboard" },
    { id: "data", label: "Data", icon: "table", href: "/admin" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", label: "Repo", icon: "book", href: "/repo" },
    { id: "inbox", label: "Inbox", icon: "chat", href: "/inbox" },
    MENU_TAB,
  ],
  super_admin: [
    { id: "home", label: "Home", icon: "home", href: "/dashboard" },
    { id: "data", label: "Data", icon: "table", href: "/admin" },
    { id: "observe", label: "Observe", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", label: "Repo", icon: "book", href: "/repo" },
    { id: "audit", label: "Audit", icon: "shield", href: "/admin/audit", gate: "admin" },
    MENU_TAB,
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
      const href = item.href.split("?")[0] ?? item.href; // "/rtt/teach-back?status=..." is /rtt/teach-back
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
