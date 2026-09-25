// Can a user reach it, and does assistive tech know where she is? The mobile
// tab bar, the sidebar landmarks and the skip link, rendered for real. See _ui.ts.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { h, render, request, resetRequest, withAppRouter, withIntl, openingTags, elements, attr, SRC_DIR } from "./_ui.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

beforeEach(() => resetRequest());

const USER = { id: "u1", name: "Tsering Dolma", email: "t@example.org", role: "teacher" as const };

// ── Defect D6: /uploads reachable on a phone ─────────────────────────────────

test("D6: a teacher's mobile tab bar reaches /uploads, labelled in her language", async () => {
  const { TABS_BY_ROLE } = await import("../../apps/web/src/config/nav.ts");
  assert.ok(TABS_BY_ROLE.teacher.some((t) => t.href === "/uploads"), "the teacher tab bar is the only navigation on a phone");
  const { BottomTabs } = await import("../../apps/web/src/components/nav/BottomTabs.tsx");
  for (const locale of ["en", "hi", "bo"] as const) {
    resetRequest();
    request.locale = locale;
    const html = await render(h(BottomTabs, { role: "teacher" }));
    const link = elements(html, "a").find((a) => attr(a.open, "href") === "/uploads");
    assert.ok(link, `${locale}: the uploads tab must render`);
    assert.equal(link.text, (loadMessages(locale).nav as Record<string, string>).uploads, `${locale}: the tab label must come from nav.uploads, not an English literal`);
  }
});

test("D6: the rendered mobile shell for a teacher links to /uploads", async () => {
  const { MobileShell } = await import("../../apps/web/src/components/shells/MobileShell.tsx");
  const html = await render(withAppRouter(h(MobileShell, { user: USER }, h("p", null, "x"))));
  assert.ok(openingTags(html, "a").some((t) => attr(t, "href") === "/uploads"));
});

// ── Defect D7: landmarks, current page, skip link ────────────────────────────

test("D7: the mobile tab bar is a named landmark and marks the current tab", async () => {
  const { BottomTabs } = await import("../../apps/web/src/components/nav/BottomTabs.tsx");
  for (const locale of ["en", "hi"] as const) {
    resetRequest();
    request.locale = locale;
    const html = await render(h(BottomTabs, { role: "teacher", activeTab: "home" }));
    const nav = openingTags(html, "nav")[0];
    assert.equal(attr(nav, "aria-label"), (loadMessages(locale).nav as Record<string, string>).primary, `${locale}: the tab bar must be named, in the user's language`);
    const links = openingTags(html, "a");
    const current = links.filter((t) => attr(t, "aria-current") === "page");
    assert.equal(current.length, 1, "exactly one tab is the current page");
    assert.equal(attr(current[0], "href"), "/dashboard");
  }
});

test("D7: each sidebar section is a distinctly named landmark and the active item is aria-current", async () => {
  const { Sidebar } = await import("../../apps/web/src/components/nav/Sidebar.tsx");
  const html = await render(h(Sidebar, { role: "super_admin", activeId: "dashboard" }));
  const navs = openingTags(html, "nav");
  assert.ok(navs.length >= 4, "super_admin has several sections");
  const names = navs.map((t) => attr(t, "aria-label"));
  assert.ok(names.every((n) => n && n.length > 0), `every <nav> must be named, got ${JSON.stringify(names)}`);
  assert.equal(new Set(names).size, names.length, "sibling navigation landmarks must not share a name");
  const current = openingTags(html, "a").filter((t) => attr(t, "aria-current") === "page");
  assert.equal(current.length, 1);
  assert.equal(attr(current[0], "href"), "/dashboard");
});


test("D7: the desktop shell's first focusable element skips to the main content", async () => {
  const { DesktopShell } = await import("../../apps/web/src/components/shells/DesktopShell.tsx");
  const html = await render(withAppRouter(await withIntl(h(DesktopShell, { user: USER, locale: "en" }, h("p", null, "page body")), "en")));
  const firstFocusable = html.match(/<(a|button|input|select|textarea)\b[^>]*>/)![0];
  assert.equal(attr(firstFocusable, "href"), "#main-content", "a keyboard user must be able to skip the sidebar's links");
  assert.match(attr(firstFocusable, "class") ?? "", /\bskip-link\b/);
  const main = openingTags(html, "main")[0];
  assert.equal(attr(main, "id"), "main-content", "the skip link must have somewhere to land");
  assert.equal(attr(main, "tabindex"), "-1", "the landing target must accept focus so the next Tab starts inside it");
  const css = readFileSync(join(SRC_DIR, "app", "globals.css"), "utf8");
  assert.match(css, /\.skip-link:focus/, "the skip link must become visible, with its own focus style, when focused");
});

test("D7: the mobile shell's main content is a skip target too", async () => {
  const { MobileShell } = await import("../../apps/web/src/components/shells/MobileShell.tsx");
  const html = await render(withAppRouter(h(MobileShell, { user: USER }, h("p", null, "page body"))));
  const main = openingTags(html, "main")[0];
  assert.equal(attr(main, "id"), "main-content");
  const firstFocusable = html.match(/<(a|button|input|select|textarea)\b[^>]*>/)![0];
  assert.equal(attr(firstFocusable, "href"), "#main-content");
});

// ── F136: the connection status on a phone ───────────────────────────────────
//
// NetworkStatus ("Offline — not saving") was mounted only in the desktop
// Sidebar. A phone gets MobileShell, which had no indicator of any kind, so
// the phone-heavy, 2G-bound audience it was built for never saw it: a teacher
// filling a form learnt the server was unreachable only when a save failed.

test("F136: the phone shell shows the connection status in its header, translated", async () => {
  const { MobileShell } = await import("../../apps/web/src/components/shells/MobileShell.tsx");
  request.locale = "hi";
  const html = await render(withAppRouter(await withIntl(h(MobileShell, { user: USER }, h("p", null, "x")), "hi")));
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  const tags = openingTags(header, "div").filter((t) => attr(t, "data-testid") === "network-status");
  assert.equal(tags.length, 1, "the sticky header carries the indicator, so it stays in view while scrolling");
  const [tag] = tags;
  assert.equal(attr(tag, "role"), "status");
  assert.equal(attr(tag, "aria-live"), "polite");
  assert.equal(attr(tag, "data-status"), "checking", "server-rendered as checking, as on desktop");
  assert.equal(attr(tag, "title"), (loadMessages("hi").status as Record<string, string>).checkingHint);
  assert.equal(openingTags(html, "div").filter((t) => attr(t, "data-testid") === "network-status").length, 1, "once per page");
});

test("F136: the desktop sidebar keeps exactly one indicator", async () => {
  const { Sidebar } = await import("../../apps/web/src/components/nav/Sidebar.tsx");
  const html = await render(h(Sidebar, { role: "teacher" }));
  assert.equal(openingTags(html, "div").filter((t) => attr(t, "data-testid") === "network-status").length, 1);
});
