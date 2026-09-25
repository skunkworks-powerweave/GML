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
// The assertion is independent of how the component chooses a key: for every
// item of every role, the English bundle must hold its (role-specific) label,
// and the rendered label must be that key's value in the locale shown.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { h, render, request, resetRequest, openingTags, attr } from "./_ui.js";
import { loadMessages, SUPPORTED_LOCALES } from "../../apps/web/src/i18n/config.ts";

beforeEach(() => resetRequest());

type Strings = Record<string, string>;

/** The nav.* (or navSection.*) keys whose English value is `label`. */
function keysFor(bundle: Strings, label: string): string[] {
  return Object.keys(bundle).filter((k) => bundle[k] === label);
}

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
        const sectionKeys = keysFor(en.navSection as Strings, section.section);
        if (sectionKeys.length === 0) wrong.add(`${role}: no navSection key holds "${section.section}"`);
        else if (!sectionKeys.some((k) => headings.includes((bundle.navSection as Strings)[k]))) {
          wrong.add(`${role}/${locale}: heading "${section.section}" is not rendered as navSection.${sectionKeys[0]}`);
        }
        for (const item of section.items) {
          const keys = keysFor(en.nav as Strings, item.label);
          const shown = items.get(item.id);
          if (keys.length === 0) {
            wrong.add(`${role}: no nav key holds "${item.label}" (${item.id})`);
            continue;
          }
          const expected = keys.map((k) => (bundle.nav as Strings)[k]);
          if (!shown || !expected.includes(shown)) {
            wrong.add(`${role}/${locale}: ${item.id} shows "${shown}", expected ${JSON.stringify(expected)}`);
          }
        }
      }
    }
  }
  assert.deepEqual([...wrong], [], "sidebar labels that are English, missing or the wrong role's wording");
});

test("F126: in English the role-specific wording survives (a mentor's videos item is 'Pending review')", async () => {
  // The regression the ITEM_KEY exclusion was guarding against.
  const { Sidebar } = await import("../../apps/web/src/components/nav/Sidebar.tsx");
  const mentor = sidebarLabels(await render(h(Sidebar, { role: "mentor" })));
  assert.equal(mentor.get("videos"), "Pending review");
  assert.equal(mentor.get("mentorship"), "My mentees");
  assert.equal(mentor.get("observation"), "Observation cycles");
  const admin = sidebarLabels(await render(h(Sidebar, { role: "super_admin" })));
  assert.equal(admin.get("videos"), "Video library");
  assert.equal(admin.get("observation"), "Classroom Observation");
  const teacher = sidebarLabels(await render(h(Sidebar, { role: "teacher" })));
  assert.equal(teacher.get("rtt"), "My phase");
  assert.equal(teacher.get("observation"), "My observations");
});
