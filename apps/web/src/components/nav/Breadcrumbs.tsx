"use client";

// The breadcrumb trail in the topbar.
//
// ── WHY IT WAS ALWAYS AN EM-DASH ─────────────────────────────────────────────
//
// Topbar has accepted a `breadcrumbs: string[]` prop since it was written, and
// renders `—` when the array is empty. It was empty on every page of the
// application, because the only thing that renders a Topbar is DesktopShell,
// the only thing that renders DesktopShell is the authenticated layout, and the
// layout never passed the prop. So a whole trail component, styled down to the
// separator colour and the weight of the final crumb, had never once drawn a
// crumb. The em-dash was not a placeholder for missing data; it WAS the feature.
//
// ── WHY THIS IS A CLIENT COMPONENT ───────────────────────────────────────────
//
// The obvious fix -- have each page pass its own crumbs -- cannot work through
// a layout: a layout renders around its children and cannot read anything from
// them, and it never receives the pathname either. Threading the trail down
// from every page would mean touching ~40 pages and would rot the first time
// someone adds one. `usePathname()` derives it from the URL instead, so a new
// route gets a trail without anyone remembering to wire one.
//
// An explicit `breadcrumbs` prop still wins where it is passed, so a page that
// wants to name the thing being looked at ("Tsering Dolma" rather than
// "Teacher") can still do so.

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Segment → label. Covers every first- and second-level route in
 * app/(authenticated). A segment not listed here is title-cased, which is
 * usually right ("whatsapp-log" would be the exception, hence its entry).
 */
const SEGMENT_LABEL: Record<string, string> = {
  dashboard: "Dashboard",
  observation: "Classroom Observation",
  mentorship: "Mentorship",
  rtt: "RTT Phases",
  videos: "Video library",
  forms: "Forms",
  quizzes: "Quizzes",
  inbox: "Inbox",
  uploads: "Uploads",
  settings: "Settings",
  repo: "Repository",
  admin: "Admin",

  // admin/*
  audit: "Audit log",
  data: "Data tables",
  gates: "Section gates",
  users: "Users",
  "system-settings": "System settings",
  "transcode-jobs": "Transcode jobs",
  "whatsapp-log": "WhatsApp log",

  // repo/* and rtt/*
  class: "Class",
  mentor: "Mentor",
  mentors: "Mentors",
  outline: "Course outline",
  outlines: "Course outlines",
  resource: "Resource",
  resources: "Resources",
  school: "School",
  schools: "Schools",
  session: "Session",
  sessions: "Sessions",
  students: "Students",
  subject: "Subject",
  subjects: "Subjects",
  teacher: "Teacher",
  teachers: "Teachers",
  online: "Online sessions",
  "teach-back": "Teach-back",
};

/**
 * Every page under app/(authenticated), dynamic segments as [param]: a crumb
 * links only when its path matches one. tests/behaviour/breadcrumbs.test.ts
 * compares this list with the directory tree, so a route added without it
 * fails there rather than rendering a crumb that 404s or hides a real page.
 *
 * It replaces a guess from the shape of the NEXT segment ("a uuid follows, so
 * this is not a page"), which was wrong both ways: /admin/data, /quizzes and
 * /rtt/online were linked and have no page, while /videos, /observation,
 * /mentorship, /admin/forms, /admin/quizzes and the /repo/class/<id> and
 * /repo/resource/<id> "Details" crumbs are pages and were plain text.
 */
export const ROUTABLE: readonly string[] = [
  "/admin",
  "/admin/audit",
  "/admin/data/[entity]",
  "/admin/forms",
  "/admin/forms/[id]",
  "/admin/gates",
  "/admin/quizzes",
  "/admin/quizzes/[id]",
  "/admin/system-settings",
  "/admin/transcode-jobs",
  "/admin/users",
  "/admin/whatsapp-log",
  "/dashboard",
  "/forms",
  "/forms/[slug]",
  "/forms/[slug]/thanks",
  "/inbox",
  "/mentorship",
  "/mentorship/[pairingId]",
  "/mentorship/[pairingId]/responses",
  "/observation",
  "/observation/[cycleId]",
  "/observation/new",
  "/quizzes/[slug]",
  "/quizzes/[slug]/history",
  "/quizzes/[slug]/result/[submissionId]",
  "/repo",
  "/repo/class/[id]",
  "/repo/class/[id]/learners",
  "/repo/mentor/[id]",
  "/repo/mentors",
  "/repo/outline/[id]",
  "/repo/outlines",
  "/repo/resource/[id]",
  "/repo/resource/[id]/view",
  "/repo/resources",
  "/repo/school/[id]",
  "/repo/schools",
  "/repo/session/[id]",
  "/repo/sessions",
  "/repo/students",
  "/repo/subject/[id]",
  "/repo/subjects",
  "/repo/teacher/[id]",
  "/repo/teachers",
  "/rtt",
  "/rtt/online/asynchronous",
  "/rtt/online/synchronous",
  "/rtt/progress",
  "/rtt/subject/[id]",
  "/rtt/teach-back",
  "/settings",
  "/uploads",
  "/videos",
  "/videos/[id]",
];

const ROUTE_PATTERNS = ROUTABLE.map((r) => new RegExp(`^${r.replace(/\[[^\]]+\]/g, "[^/]+")}$`));

function isPage(path: string): boolean {
  return ROUTE_PATTERNS.some((re) => re.test(path));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function titleCase(segment: string): string {
  return segment
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

type Crumb = { label: string; href: string | null };

export function buildCrumbs(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const out: Crumb[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const href = "/" + segments.slice(0, i + 1).join("/");
    // Linked only if that path is a page (ROUTABLE): `/repo/teacher` and
    // `/admin/users` look alike in a URL but only one of them is a page, and
    // linking blind manufactures 404s in the chrome.
    const link = isPage(href) ? href : null;

    // An id is not a name. The raw uuid is noise, and dropping it silently
    // would make /repo/teacher/<id> read as though it were the teacher LIST.
    // A plain "Details" crumb instead: never ungrammatical, whatever the parent
    // segment is ("Teacher > Details", "Quizzes > Details").
    if (UUID_RE.test(seg) || /^\d+$/.test(seg)) {
      out.push({ label: "Details", href: link });
      continue;
    }

    out.push({ label: SEGMENT_LABEL[seg] ?? titleCase(seg), href: link });
  }

  // The page you are already on is not somewhere to navigate to.
  if (out.length > 0) out[out.length - 1].href = null;
  return out;
}

export function Breadcrumbs() {
  const pathname = usePathname() ?? "";
  const crumbs = buildCrumbs(pathname);

  if (crumbs.length === 0) {
    return <span style={{ color: "var(--ink-3)" }}>—</span>;
  }

  return (
    <>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        const text = (
          <span
            style={{
              color: last ? "var(--ink)" : "var(--ink-3)",
              fontWeight: last ? 500 : 400,
            }}
            // Marks the current page for a screen reader, which otherwise hears
            // a run of links with no indication of where it is.
            aria-current={last ? "page" : undefined}
          >
            {c.label}
          </span>
        );
        return (
          <span key={`${i}-${c.label}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {i > 0 ? (
              <span aria-hidden="true" style={{ color: "var(--ink-4)" }}>
                ›
              </span>
            ) : null}
            {c.href ? (
              <Link href={c.href} style={{ textDecoration: "none" }}>
                {text}
              </Link>
            ) : (
              text
            )}
          </span>
        );
      })}
    </>
  );
}
