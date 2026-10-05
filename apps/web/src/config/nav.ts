// Role-aware navigation map. Ported 1:1 from `LMS GML Frontend/shell.jsx::NAV_BY_ROLE`
// (desktop) and `mobile-shell.jsx::TABS_BY_ROLE` (mobile bottom tabs).
//
// Adding a new route = adding a NavItem here. The Sidebar + BottomTabs
// components render entirely from this config; no role-branching in JSX.
//
// NO LABEL IS WRITTEN HERE. Every item and tab names its `nav.*` key and every
// section its `navSection.*` key; the chrome renders them in the user's
// language. English literals used to sit beside the keys as fallbacks, and the
// items without a key rendered them in Hindi and Bhoti sidebars too.

import type { RoleName } from "@gml/shared/auth/roles";

export type NavItem = {
  id: string;
  /**
   * The item's `nav.*` translation key. Named per item, not derived from the
   * id: observation, mentorship, rtt and videos carry different labels for
   * different roles ("Video library" / "Pending review", "Mentorship" / "My
   * mentees"), so an id-keyed map cannot hold them.
   */
  labelKey: string;
  icon: string;
  href: string;
  /** Section-gate slug. Visiting this route prompts for the gate password if not unlocked. */
  gate?: "mentorship" | "observation" | "admin" | "tkt" | "ttt";
  /** Count badge (mentor sees "5 mentees", etc.). Static for now; spec 057 wires real counts. */
  count?: number;
};

export type NavSection = {
  /** The heading's `navSection.*` translation key. */
  section: string;
  items: NavItem[];
};

/**
 * Desktop sidebar groups. Match `shell.jsx::NAV_BY_ROLE` exactly.
 */
export const NAV_BY_ROLE: Record<RoleName, NavSection[]> = {
  super_admin: [
    {
      section: "programme",
      items: [
        { id: "dashboard", labelKey: "dashboard", icon: "home", href: "/dashboard" },
        { id: "observation", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
        { id: "mentorship", labelKey: "mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "rtt", labelKey: "rtt", icon: "mountain", href: "/rtt" },
        { id: "videos", labelKey: "videos", icon: "video", href: "/videos" },
        { id: "approvals", labelKey: "approvals", icon: "check", href: "/approvals" },
        { id: "attendance", labelKey: "attendanceMarking", icon: "table", href: "/attendance" },
        { id: "student-progress", labelKey: "studentProgress", icon: "cycle", href: "/progress/students" },
      ],
    },
    {
      section: "repository",
      items: [
        { id: "repo", labelKey: "repoHome", icon: "book", href: "/repo" },
        { id: "repo-schools", labelKey: "schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", labelKey: "subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", labelKey: "outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", labelKey: "sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", labelKey: "resources", icon: "pdf", href: "/repo/resources" },
      ],
    },
    {
      section: "data",
      items: [
        { id: "tbl-teachers", labelKey: "teachers", icon: "users", href: "/admin/data/teachers" },
        { id: "tbl-schools", labelKey: "schools", icon: "school", href: "/admin/data/schools" },
        { id: "tbl-mentors", labelKey: "mentors", icon: "users", href: "/admin/data/mentors" },
        { id: "tbl-pairings", labelKey: "pairings", icon: "users", href: "/admin/data/mentor-pairings" },
        { id: "tbl-attendance", labelKey: "attendance", icon: "table", href: "/admin/data/rtt-attendance" },
        // The index of ALL 20 tables. Without it the desktop sidebar reached 5
        // of them, and classes, learners, sessions, resources, RTT content and
        // observation cycles -- the tables a fresh deployment is empty in --
        // could only be found by typing /admin. README-deploy.md section 3.2.
        { id: "tbl-all", labelKey: "allTables", icon: "table", href: "/admin" },
      ],
    },
    {
      section: "system",
      items: [
        { id: "users", labelKey: "users", icon: "users", href: "/admin/users" },
        { id: "audit", labelKey: "audit", icon: "shield", href: "/admin/audit", gate: "admin" },
        { id: "gates", labelKey: "gates", icon: "lock", href: "/admin/gates" },
        { id: "forms", labelKey: "forms", icon: "file", href: "/admin/forms" },
        { id: "grading", labelKey: "grading", icon: "table", href: "/admin/grading" },
        { id: "settings", labelKey: "settings", icon: "settings", href: "/settings" },
      ],
    },
  ],

  programme_admin: [
    {
      section: "programme",
      items: [
        { id: "dashboard", labelKey: "dashboard", icon: "home", href: "/dashboard" },
        { id: "observation", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
        { id: "mentorship", labelKey: "mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "rtt", labelKey: "rtt", icon: "mountain", href: "/rtt" },
        { id: "videos", labelKey: "videos", icon: "video", href: "/videos" },
        { id: "approvals", labelKey: "approvals", icon: "check", href: "/approvals" },
        { id: "attendance", labelKey: "attendanceMarking", icon: "table", href: "/attendance" },
        { id: "student-progress", labelKey: "studentProgress", icon: "cycle", href: "/progress/students" },
      ],
    },
    {
      section: "repository",
      items: [
        { id: "repo", labelKey: "repoHome", icon: "book", href: "/repo" },
        { id: "repo-schools", labelKey: "schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", labelKey: "subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", labelKey: "outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", labelKey: "sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", labelKey: "resources", icon: "pdf", href: "/repo/resources" },
      ],
    },
    {
      section: "data",
      items: [
        { id: "tbl-teachers", labelKey: "teachers", icon: "users", href: "/admin/data/teachers" },
        { id: "tbl-schools", labelKey: "schools", icon: "school", href: "/admin/data/schools" },
        { id: "tbl-attendance", labelKey: "attendance", icon: "table", href: "/admin/data/rtt-attendance" },
        { id: "tbl-pairings", labelKey: "pairings", icon: "users", href: "/admin/data/mentor-pairings" },
        // See the super_admin Data section: the index of every table.
        { id: "tbl-all", labelKey: "allTables", icon: "table", href: "/admin" },
      ],
    },
    {
      section: "system",
      items: [
        { id: "users", labelKey: "users", icon: "users", href: "/admin/users" },
        { id: "audit", labelKey: "audit", icon: "shield", href: "/admin/audit", gate: "admin" },
        { id: "forms", labelKey: "forms", icon: "file", href: "/admin/forms" },
        { id: "grading", labelKey: "grading", icon: "table", href: "/admin/grading" },
      ],
    },
  ],

  mentor: [
    {
      section: "myWork",
      items: [
        { id: "dashboard", labelKey: "dashboard", icon: "home", href: "/dashboard" },
        { id: "mentorship", labelKey: "myMentees", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "observation", labelKey: "observationCycles", icon: "eye", href: "/observation", gate: "observation" },
        // The teach-back review queue. This item linked to /videos, which has
        // no review control, so the badge pointed at nothing a mentor could do.
        { id: "teach-back", labelKey: "pendingReview", icon: "video", href: "/rtt/teach-back?status=review_pending" },
        { id: "approvals", labelKey: "approvals", icon: "check", href: "/approvals" },
        { id: "videos", labelKey: "videos", icon: "video", href: "/videos" },
      ],
    },
    {
      section: "programme",
      items: [
        { id: "rtt", labelKey: "rtt", icon: "mountain", href: "/rtt" },
        { id: "forms", labelKey: "forms", icon: "file", href: "/forms" },
      ],
    },
    {
      section: "repository",
      items: [
        { id: "repo", labelKey: "repoHome", icon: "book", href: "/repo" },
        { id: "repo-schools", labelKey: "schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", labelKey: "subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", labelKey: "outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", labelKey: "sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", labelKey: "resources", icon: "pdf", href: "/repo/resources" },
      ],
    },
  ],

  observer: [
    {
      section: "myWork",
      items: [
        { id: "dashboard", labelKey: "dashboard", icon: "home", href: "/dashboard" },
        { id: "observation", labelKey: "observationCycles", icon: "eye", href: "/observation", gate: "observation" },
        // Observers may review teach-backs (rtt/teach-back READ_ROLES) and had
        // no way to reach the queue.
        { id: "teach-back", labelKey: "pendingReview", icon: "video", href: "/rtt/teach-back?status=review_pending" },
        { id: "approvals", labelKey: "approvals", icon: "check", href: "/approvals" },
        { id: "videos", labelKey: "videos", icon: "video", href: "/videos" },
      ],
    },
    {
      section: "repository",
      items: [
        { id: "repo", labelKey: "repoHome", icon: "book", href: "/repo" },
        { id: "repo-schools", labelKey: "schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", labelKey: "subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", labelKey: "outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", labelKey: "sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", labelKey: "resources", icon: "pdf", href: "/repo/resources" },
      ],
    },
  ],

  teacher: [
    {
      section: "myLearning",
      items: [
        { id: "dashboard", labelKey: "dashboard", icon: "home", href: "/dashboard" },
        { id: "rtt", labelKey: "myPhase", icon: "mountain", href: "/rtt" },
        { id: "progress", labelKey: "progress", icon: "cycle", href: "/rtt/progress" },
        // gate: the observation layout asks for the section password for
        // teachers too; the menu now shows the lock that says so.
        { id: "observation", labelKey: "myObservations", icon: "eye", href: "/observation", gate: "observation" },
        // Her pairing: its meetings, her Q1/Q4 videos and her reflections. A
        // teacher could reach it only from an inbox notification.
        { id: "mentorship", labelKey: "mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
        { id: "uploads", labelKey: "uploads", icon: "upload", href: "/uploads" },
      ],
    },
    {
      // Her own records (teaching-records design, 2026-09-28).
      section: "myTeaching",
      items: [
        { id: "teaching-classes", labelKey: "classes", icon: "school", href: "/teaching/classes" },
        { id: "teaching-students", labelKey: "students", icon: "users", href: "/teaching/students" },
        { id: "teaching-plans", labelKey: "lessonPlans", icon: "file", href: "/teaching/plans" },
        { id: "teaching-sessions", labelKey: "teachingSessions", icon: "cycle", href: "/teaching/sessions" },
        { id: "teaching-marks", labelKey: "marks", icon: "table", href: "/teaching/marks" },
        { id: "teaching-progress", labelKey: "studentProgress", icon: "cycle", href: "/teaching/progress" },
      ],
    },
    {
      section: "repository",
      items: [
        { id: "repo", labelKey: "repoHome", icon: "book", href: "/repo" },
        { id: "repo-schools", labelKey: "schools", icon: "school", href: "/repo/schools" },
        { id: "repo-subjects", labelKey: "subjects", icon: "book", href: "/repo/subjects" },
        { id: "repo-outlines", labelKey: "outlines", icon: "file", href: "/repo/outlines" },
        { id: "repo-sessions", labelKey: "sessions", icon: "cycle", href: "/repo/sessions" },
        { id: "repo-resources", labelKey: "resources", icon: "pdf", href: "/repo/resources" },
      ],
    },
    {
      section: "resources",
      items: [
        { id: "forms", labelKey: "forms", icon: "file", href: "/forms" },
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
    section: "yourAccount",
    items: [{ id: "settings", labelKey: "settings", icon: "settings", href: "/settings" }],
  });
}

export type MobileTab = {
  id: string;
  /** The tab's `nav.*` translation key. */
  labelKey: string;
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
const MENU_TAB: MobileTab = { id: "menu", labelKey: "menu", icon: "menu", href: "/menu" };

/**
 * Mobile bottom tabs, after `mobile-shell.jsx::TABS_BY_ROLE`, each ending in
 * Menu. `inbox` becomes `audit` for super_admin; the teacher's Repo tab gave
 * way to Uploads and lives in Menu.
 */
export const TABS_BY_ROLE: Record<RoleName, MobileTab[]> = {
  teacher: [
    { id: "home", labelKey: "dashboard", icon: "home", href: "/dashboard" },
    { id: "learn", labelKey: "rtt", icon: "book", href: "/rtt" },
    { id: "observe", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
    { id: "inbox", labelKey: "inbox", icon: "chat", href: "/inbox" },
    // /uploads was in the DESKTOP sidebar only. A phone has no sidebar, so a
    // teacher could reach her uploads page -- the only mount of the mobile
    // camera/resumable-upload runner -- solely through a dashboard to-do row
    // that appears while a cycle is awaiting a video. Teachers are the most
    // phone-heavy group in the programme. The grid in BottomTabs sizes itself
    // from tabs.length; the label is nav.uploads.
    { id: "uploads", labelKey: "uploads", icon: "upload", href: "/uploads" },
    MENU_TAB,
  ],
  mentor: [
    { id: "home", labelKey: "dashboard", icon: "home", href: "/dashboard" },
    { id: "pairings", labelKey: "mentorship", icon: "users", href: "/mentorship", gate: "mentorship" },
    { id: "observe", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", labelKey: "repo", icon: "table", href: "/repo" },
    { id: "inbox", labelKey: "inbox", icon: "chat", href: "/inbox" },
    MENU_TAB,
  ],
  observer: [
    { id: "home", labelKey: "dashboard", icon: "home", href: "/dashboard" },
    { id: "observe", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", labelKey: "repo", icon: "table", href: "/repo" },
    { id: "inbox", labelKey: "inbox", icon: "chat", href: "/inbox" },
    MENU_TAB,
  ],
  programme_admin: [
    { id: "home", labelKey: "dashboard", icon: "home", href: "/dashboard" },
    { id: "data", labelKey: "data", icon: "table", href: "/admin" },
    { id: "observe", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", labelKey: "repo", icon: "book", href: "/repo" },
    { id: "inbox", labelKey: "inbox", icon: "chat", href: "/inbox" },
    MENU_TAB,
  ],
  super_admin: [
    { id: "home", labelKey: "dashboard", icon: "home", href: "/dashboard" },
    { id: "data", labelKey: "data", icon: "table", href: "/admin" },
    { id: "observe", labelKey: "observation", icon: "eye", href: "/observation", gate: "observation" },
    { id: "repo", labelKey: "repo", icon: "book", href: "/repo" },
    { id: "audit", labelKey: "audit", icon: "shield", href: "/admin/audit", gate: "admin" },
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
