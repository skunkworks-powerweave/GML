// A classroom session is called a classroom session everywhere it is listed.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// The admin table was "Classroom sessions". The repository's menu item, its
// page titles, the school, class, subject, outline and teacher pages' section
// headings and the teacher's own pages said "Sessions" or "My sessions" -- next
// to "RTT Sessions" (a training session) and a "Sessions attended" tile, which
// is ambiguous: a reader cannot tell a lesson in a classroom from a training
// webinar. (Found in the 5 Oct 2026 QA of the admin flows.)
//
// ── WHAT IS EXECUTED ───────────────────────────────────────────────────────
//
// The real bundles in all three languages: each menu item, breadcrumb, page
// title, section heading, link and empty state that names the list of classroom
// sessions carries the word the admin table already used for it in that
// language (adminData.entities.sessions.label); and the rendered menu shows it.
// The count tiles, column headers and detail rows that name the list (repo
// common.sessions) say the same, so a tile never reads "Sessions" above a card
// headed "Recent classroom sessions". Only a count inside a sentence
// ("12 sessions") is left as it was.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { h, render, request, resetRequest } from "./_ui.js";
import { loadMessages, SUPPORTED_LOCALES } from "../../apps/web/src/i18n/config.ts";

beforeEach(() => resetRequest());

/** `a.b.c` in a bundle. */
function at(bundle: unknown, path: string): string {
  const v = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], bundle);
  assert.equal(typeof v, "string", `${path} is not a string`);
  return v as string;
}

/** The admin table's name for a classroom session, as a stem every inflection contains. */
function stem(locale: (typeof SUPPORTED_LOCALES)[number]): string {
  const label = at(loadMessages(locale).adminData, "entities.sessions.label");
  // "Classroom sessions" -> "classroom session"; the Tibetan label's closing shad goes.
  return label.toLowerCase().replace(/s$/, "").replace(/[།\s]+$/, "");
}

// Each of these is a heading, title, link or empty state for the LIST of
// classroom sessions (or the page of one), in the bundle it names.
const LISTS: Array<[ns: "root" | "repo" | "teaching", path: string]> = [
  ["root", "nav.sessions"],
  ["root", "nav.teachingSessions"],
  ["root", "crumb.session"],
  ["root", "crumb.sessions"],
  ["repo", "common.sessions"],
  ["repo", "common.noSessionsYet"],
  ["repo", "common.sessionsLogged"],
  ["repo", "common.allSessions"],
  ["repo", "home.stats.sessions"],
  ["repo", "home.thisWeek"],
  ["repo", "home.noneThisWeek"],
  ["repo", "home.browseItems.sessions"],
  ["repo", "sessions.metaTitle"],
  ["repo", "sessions.title"],
  ["repo", "sessions.searchLabel"],
  ["repo", "school.sessionsTitle"],
  ["repo", "school.noSessions"],
  ["repo", "class.sessionsTitle"],
  ["repo", "subject.recentTitle"],
  ["repo", "outline.sessionsTitle"],
  ["repo", "outline.noSessions"],
  ["repo", "session.metaTitle"],
  ["repo", "session.back"],
  ["repo", "session.label"],
  ["repo", "teacher.sessionsTitle"],
  ["repo", "own.sessionsTitle"],
  ["teaching", "hub.stats.sessions"],
  ["teaching", "hub.links.sessions"],
  ["teaching", "sessions.title"],
  ["teaching", "session.metaTitle"],
  ["teaching", "session.label"],
];

test("every list and heading of classroom sessions uses the admin table's name for them, in all three languages", () => {
  const wrong: string[] = [];
  for (const locale of SUPPORTED_LOCALES) {
    const bundle = loadMessages(locale);
    const want = stem(locale);
    for (const [ns, path] of LISTS) {
      const value = at(ns === "root" ? bundle : (bundle as Record<string, unknown>)[ns], path);
      if (!value.toLowerCase().includes(want)) wrong.push(`${locale} ${ns}.${path} = "${value}" (no "${want}")`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("in English the name is 'Classroom sessions', as the admin table has it", () => {
  const en = loadMessages("en");
  assert.equal(at(en.adminData, "entities.sessions.label"), "Classroom sessions");
  assert.equal(at(en, "nav.sessions"), "Classroom sessions");
  assert.equal(at(en.repo, "sessions.title"), "Classroom sessions");
  assert.equal(at(en.repo, "school.sessionsTitle"), "Classroom sessions ({count})");
  assert.equal(at(en, "nav.teachingSessions"), "My classroom sessions");
});

test("the menu shows it: the repository's item for every role, and the teacher's own list", async () => {
  const { NAV_BY_ROLE } = await import("../../apps/web/src/config/nav.ts");
  const { Sidebar } = await import("../../apps/web/src/components/nav/Sidebar.tsx");
  const labelOf = (html: string, id: string) =>
    html.match(new RegExp(`data-help-anchor="nav-${id}"[^>]*>[\\s\\S]*?<span style="flex:1">([^<]*)</span>`))?.[1];
  for (const locale of SUPPORTED_LOCALES) {
    const bundle = loadMessages(locale).nav as Record<string, string>;
    for (const role of Object.keys(NAV_BY_ROLE) as Array<keyof typeof NAV_BY_ROLE>) {
      resetRequest();
      request.locale = locale;
      const html = await render(h(Sidebar, { role }));
      const repoItem = labelOf(html, "repo-sessions");
      if (NAV_BY_ROLE[role].some((s) => s.items.some((i) => i.id === "repo-sessions"))) {
        assert.equal(repoItem, bundle.sessions, `${role}/${locale}: the repository's sessions item`);
        assert.ok(repoItem!.toLowerCase().includes(stem(locale)), `${role}/${locale}: "${repoItem}" is not the classroom sessions name`);
      }
    }
    resetRequest();
    request.locale = locale;
    const teacher = await render(h(Sidebar, { role: "teacher" }));
    assert.equal(labelOf(teacher, "teaching-sessions"), bundle.teachingSessions, `teacher/${locale}: her own list`);
  }
});
