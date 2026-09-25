// The rest of the chrome, in the user's language. See _ui.ts.
//
// ── THE DEFECT (F134) ────────────────────────────────────────────────────────
//
// i18n/config.ts promises that global chrome is translated, and the sidebar
// and tabs are. These pieces were English literals in every locale:
//   - the breadcrumb trail (Breadcrumbs' own SEGMENT_LABEL map, and "Details"),
//     and the trail's landmark name "Breadcrumb";
//   - the phone header's "Sign out" button and its title, and the avatar
//     link's accessible name "Your settings" -- although the desktop topbar's
//     sign-out title was already translated;
//   - the ? button's accessible name "Help" on a phone;
//   - the role: the sidebar printed the raw slug ("RTT · teacher") and the
//     topbar pill its own English ROLE_LABEL map.
// And in Bhoti the bottom tabs set Tibetan -- tall stacked glyphs -- at 10px.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { h, render, request, resetRequest, withAppRouter, withIntl, openingTags, elements, attr, SRC_DIR } from "./_ui.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

beforeEach(() => resetRequest());

type Strings = Record<string, string>;
const USER = { id: "u1", name: "Tsering Dolma", email: "t@example.org", role: "teacher" as const };
const ns = (locale: "en" | "hi" | "bo", name: string) => loadMessages(locale)[name] as unknown as Strings;

/** A translator over one namespace of a real bundle, as useTranslations gives. */
const crumbT = (locale: "en" | "hi" | "bo") => (key: string) => {
  const v = ns(locale, "crumb")[key];
  if (typeof v !== "string") throw new Error(`missing crumb.${key}`);
  return v;
};

/** Every static segment of every page under app/(authenticated). */
function staticSegments(dir = join(SRC_DIR, "app", "(authenticated)")): Set<string> {
  const out = new Set<string>();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (!name.startsWith("[")) out.add(name);
    for (const s of staticSegments(p)) out.add(s);
  }
  return out;
}

const UUID = "0c7ce1a2-12e4-4839-8f46-a57bfad08006";

test("F134: every breadcrumb label is a crumb.* translation, in Hindi and Bhoti too", async () => {
  const { buildCrumbs } = await import("../../apps/web/src/components/nav/Breadcrumbs.tsx");
  const wrong: string[] = [];
  for (const seg of staticSegments()) {
    for (const locale of ["en", "hi", "bo"] as const) {
      const [crumb] = buildCrumbs(`/${seg}`, crumbT(locale));
      if (!Object.values(ns(locale, "crumb")).includes(crumb.label)) wrong.push(`${locale}: /${seg} reads "${crumb.label}"`);
    }
  }
  assert.deepEqual(wrong, [], "segments whose crumb is not from the bundle (an English literal or a title-cased slug)");
  const hi = buildCrumbs(`/repo/class/${UUID}/learners`, crumbT("hi")).map((c) => c.label);
  const t = ns("hi", "crumb");
  assert.deepEqual(hi, [t.repo, t.class, t.details, t.learners]);
});

test("F134: the rendered trail and its landmark name are in the user's language", async () => {
  const { Breadcrumbs } = await import("../../apps/web/src/components/nav/Breadcrumbs.tsx");
  const { PathnameContext } = createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "next/dist/shared/lib/hooks-client-context.shared-runtime",
  ) as { PathnameContext: import("react").Context<string | null> };
  const html = await render(
    await withIntl(h(PathnameContext.Provider, { value: `/admin/users/${UUID}` }, h(Breadcrumbs)), "hi"),
  );
  const t = ns("hi", "crumb");
  for (const label of [t.admin, t.users, t.details]) assert.ok(html.includes(label), `the trail must read "${label}"`);
  const { Topbar } = await import("../../apps/web/src/components/nav/Topbar.tsx");
  request.locale = "hi";
  const top = await render(withAppRouter(await withIntl(h(Topbar, { user: USER, locale: "hi" }), "hi")));
  const trail = openingTags(top, "nav")[0];
  assert.equal(attr(trail, "aria-label"), t.trail, "the breadcrumb landmark is named in Hindi");
});

test("F134: the phone header's account controls and ? button are in the user's language", async () => {
  const { MobileShell } = await import("../../apps/web/src/components/shells/MobileShell.tsx");
  for (const locale of ["hi", "bo"] as const) {
    resetRequest();
    request.locale = locale;
    const html = await render(withAppRouter(await withIntl(h(MobileShell, { user: USER }, h("p", null, "x")), locale)));
    const action = ns(locale, "action");
    const nav = ns(locale, "nav");
    const signOut = elements(html, "button").find((b) => attr(b.open, "data-testid") === "signout-button");
    assert.ok(signOut, "the phone header has a sign-out button");
    assert.equal(signOut.text.trim(), action.signOut, `${locale}: the button reads in the user's language`);
    assert.ok((attr(signOut.open, "title") ?? "").startsWith(action.signOut), `${locale}: and so does its title`);
    const settings = openingTags(html, "a").find((t) => attr(t, "data-testid") === "mobile-settings-link");
    assert.equal(attr(settings ?? "", "aria-label"), nav.settings, `${locale}: the avatar link is named in the user's language`);
    const help = openingTags(html, "button").find((t) => attr(t, "data-help-anchor") === "topbar-help");
    assert.equal(attr(help ?? "", "aria-label"), action.help, `${locale}: the ? button is named in the user's language`);
  }
});

test("F134: the role is named in the user's language, in the sidebar and the topbar", async () => {
  const { Sidebar } = await import("../../apps/web/src/components/nav/Sidebar.tsx");
  const { Topbar } = await import("../../apps/web/src/components/nav/Topbar.tsx");
  for (const locale of ["en", "hi", "bo"] as const) {
    resetRequest();
    request.locale = locale;
    const role = ns(locale, "role");
    const side = await render(h(Sidebar, { role: "teacher" }));
    assert.ok(side.includes(role.teacher), `${locale}: the sidebar subtitle names the role as "${role.teacher}"`);
    assert.ok(!/RTT(<!-- -->)? · (<!-- -->)?teacher</.test(side), `${locale}: not the raw slug`);
    const top = await render(withAppRouter(await withIntl(h(Topbar, { user: USER, locale }), locale)));
    assert.ok(top.includes(`>${role.teacher}<`), `${locale}: the topbar names the role as "${role.teacher}"`);
  }
  assert.notEqual(ns("hi", "role").teacher, "Teacher");
});

test("F134: Tibetan tab labels are set larger than 10px", async () => {
  const { BottomTabs } = await import("../../apps/web/src/components/nav/BottomTabs.tsx");
  request.locale = "bo";
  const html = await render(h(BottomTabs, { role: "teacher" }));
  for (const tag of openingTags(html, "a")) {
    const size = Number((attr(tag, "style") ?? "").match(/font-size:(\d+(?:\.\d+)?)px/)?.[1]);
    assert.ok(size >= 12, `a Bhoti tab label is ${size}px: stacked Tibetan at 10px is not readable on a phone`);
  }
  request.locale = "en";
  const en = await render(h(BottomTabs, { role: "teacher" }));
  assert.match(attr(openingTags(en, "a")[0], "style") ?? "", /font-size:10px/, "English keeps its size: six tabs have to fit");
});
