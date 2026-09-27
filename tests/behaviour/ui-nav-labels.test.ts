// Every label in the navigation chrome, in the user's language. See _ui.ts.
//
// ── F126: the role-specific sidebar items ────────────────────────────────────
//
// The Sidebar picked each item's translation key from its `id` (ITEM_KEY). But
// NAV_BY_ROLE reuses ids with different labels per role -- `videos` is "Video
// library" for an admin and "Pending review" for a mentor -- so an earlier fix
// dropped observation / mentorship / rtt / videos from the map to stop the
// wrong label showing, and they fell back to the English literal. In Hindi and
// Bhoti the most important items of every role's sidebar ("My phase", "My
// observations", "My mentees", "Pending review", "RTT Phases") were English
// beside translated neighbours, although nav.myPhase, nav.pendingReview and the
// rest were already translated in all three bundles. "All tables", "Users" and
// the "Your account" heading had no key at all.
//
// Every item and section in config/nav.ts now names its own key (NavItem.
// labelKey, NavSection.section) and carries no English literal at all. So for
// every item of every role: its key must exist in the English bundle, and the
// rendered label must be that key's value in the locale shown -- the role-
// specific wording is pinned in English by the second test below.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { h, render, request, resetRequest, openingTags, attr } from "./_ui.js";
import { loadMessages, SUPPORTED_LOCALES } from "../../apps/web/src/i18n/config.ts";

beforeEach(() => resetRequest());

type Strings = Record<string, string>;

/** data-help-anchor id -> visible label, from a rendered Sidebar. */
function sidebarLabels(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*data-help-anchor="nav-([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const label = m[2].match(/<span style="flex:1">([^<]*)<\/span>/)?.[1];
    if (label !== undefined) out.set(m[1], label.replace(/&amp;/g, "&"));
  }
  return out;
}

test("F126: every sidebar item and heading, for every role, renders its own label in the user's language", async () => {
  const { NAV_BY_ROLE } = await import("../../apps/web/src/config/nav.ts");
  const { Sidebar } = await import("../../apps/web/src/components/nav/Sidebar.tsx");
  const en = loadMessages("en");
  // A Set: a missing key is reported once, not once per locale.
  const wrong = new Set<string>();
  for (const role of Object.keys(NAV_BY_ROLE) as Array<keyof typeof NAV_BY_ROLE>) {
    for (const locale of SUPPORTED_LOCALES) {
      resetRequest();
      request.locale = locale;
      const bundle = loadMessages(locale);
      const html = await render(h(Sidebar, { role }));
      const items = sidebarLabels(html);
      const headings = openingTags(html, "nav").map((t) => attr(t, "aria-label"));
      for (const section of NAV_BY_ROLE[role]) {
        if (typeof (en.navSection as Strings)[section.section] !== "string") {
          wrong.add(`${role}: no navSection key "${section.section}"`);
        } else if (!headings.includes((bundle.navSection as Strings)[section.section])) {
          wrong.add(`${role}/${locale}: heading navSection.${section.section} is not rendered in ${locale}`);
        }
        for (const item of section.items) {
          const shown = items.get(item.id);
          if (typeof (en.nav as Strings)[item.labelKey] !== "string") {
            wrong.add(`${role}: no nav key "${item.labelKey}" (${item.id})`);
            continue;
          }
          const expected = (bundle.nav as Strings)[item.labelKey];
          if (shown !== expected) {
            wrong.add(`${role}/${locale}: ${item.id} shows "${shown}", expected "${expected}"`);
          }
          if (locale !== "en" && shown === (en.nav as Strings)[item.labelKey]) {
            wrong.add(`${role}/${locale}: ${item.id} is still English ("${shown}")`);
          }
        }
      }
    }
  }
  assert.deepEqual([...wrong], [], "sidebar labels that are English, missing or the wrong role's wording");
});

test("F126: in English the role-specific wording survives (a mentor's teach-back item is 'Pending review')", async () => {
  // The regression the ITEM_KEY exclusion was guarding against.
  const { Sidebar } = await import("../../apps/web/src/components/nav/Sidebar.tsx");
  const mentor = sidebarLabels(await render(h(Sidebar, { role: "mentor" })));
  assert.equal(mentor.get("teach-back"), "Pending review");
  assert.equal(mentor.get("videos"), "Video library");
  assert.equal(mentor.get("mentorship"), "My mentees");
  assert.equal(mentor.get("observation"), "Observation cycles");
  const admin = sidebarLabels(await render(h(Sidebar, { role: "super_admin" })));
  assert.equal(admin.get("videos"), "Video library");
  assert.equal(admin.get("observation"), "Classroom Observation");
  const teacher = sidebarLabels(await render(h(Sidebar, { role: "teacher" })));
  assert.equal(teacher.get("rtt"), "My phase");
  assert.equal(teacher.get("observation"), "My observations");
});
