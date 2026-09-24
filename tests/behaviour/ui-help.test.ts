// The help system, followed from the controls a user actually has on each
// device: the top bar's ? button on a computer, the ? FAB on a phone. See _ui.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { h, render, withAppRouter, openingTags, elements, attr, mount, hostElements, withFakeWindow, SRC_DIR } from "./_ui.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

const USER = { id: "u1", name: "Tsering Dolma", email: "t@example.org", role: "teacher" as const };

/** Click a mounted component's control and report the help-open events it fired. */
function clickAndCollect(onClick: () => void, eventName: string): Array<{ topic?: string | null }> {
  return withFakeWindow((win) => {
    const seen: Array<{ topic?: string | null }> = [];
    win.addEventListener(eventName, (e) => seen.push((e as CustomEvent).detail));
    onClick();
    return seen;
  });
}

// ── Defect D5: the help system has an entry point ────────────────────────────

test("D5: tapping the mobile ? button opens the shared help panel", async () => {
  const { MobileHelpFAB } = await import("../../apps/web/src/components/MobileHelpFAB.tsx");
  const { HELP_OPEN_EVENT } = await import("../../apps/web/src/components/help/HelpPanel.tsx");
  const m = mount(MobileHelpFAB as (p: unknown) => unknown, {});
  const button = hostElements(m.tree).find((el) => el.type === "button")!;
  assert.ok(button, "the FAB must render a button");
  const events = clickAndCollect(button.props.onClick as () => void, HELP_OPEN_EVENT);
  assert.equal(events.length, 1, "on a phone the FAB is the only way into the help panel (there is no keyboard for `?`), so a tap must open it");
  assert.equal(events[0].topic ?? null, null, "it opens the browse view, not a specific topic");
});

test("D5: the desktop top bar has a help button, and it — not the notifications bell — is the tour's help anchor", async () => {
  const { Topbar } = await import("../../apps/web/src/components/nav/Topbar.tsx");
  const html = await render(withAppRouter(h(Topbar, { user: USER, locale: "en" })));
  const anchors = [...html.matchAll(/<[a-z]+\b[^>]*data-help-anchor="topbar-help"[^>]*>/g)].map((m) => m[0]);
  assert.equal(anchors.length, 1, "exactly one element may carry the anchor, or the tour's querySelector picks whichever is first");
  const bell = openingTags(html, "a").find((t) => attr(t, "data-testid") === "topbar-bell")!;
  assert.equal(attr(bell, "data-help-anchor"), null, "the bell is a link to /inbox; spotlighting it as 'Help is always here' sends users to their notifications");
  const helpButtons = elements(html, "button").filter((b) => attr(b.open, "data-help-open") !== null);
  assert.equal(helpButtons.length, 1, "the top bar must render a help button");
  assert.equal(attr(helpButtons[0].open, "aria-label"), (loadMessages("en").action as Record<string, string>).help);
  assert.ok(html.indexOf('data-help-anchor="topbar-help"') <= html.indexOf(helpButtons[0].open), "the anchor must wrap (or be) the help button");
});

test("D5: the top bar's help button opens the shared help panel", async () => {
  const { HelpButton } = await import("../../apps/web/src/components/help/HelpButton.tsx");
  const { HELP_OPEN_EVENT } = await import("../../apps/web/src/components/help/HelpPanel.tsx");
  const m = mount(HelpButton as (p: unknown) => unknown, { label: "Help" });
  const button = hostElements(m.tree).find((el) => el.type === "button")!;
  const events = clickAndCollect(button.props.onClick as () => void, HELP_OPEN_EVENT);
  assert.equal(events.length, 1);
});

test("D5: nothing the old mobile sheet said was lost when it became the panel", async () => {
  const { HELP, HELP_GROUPS, searchHelp } = await import("../../apps/web/src/lib/help.ts");
  const grouped = new Set(HELP_GROUPS.flatMap((g) => g.keys));
  for (const [needle, why] of [
    [/bottom tabs/i, "how to move around on a phone"],
    [/WhatsApp/, "the WhatsApp upload path"],
    [/stable wi-?fi/i, "direct browser upload"],
    [/confidential/i, "the confidentiality rule"],
    [/sign-in link/i, "what to do about a forgotten password"],
  ] as const) {
    const hits = Object.entries(HELP).filter(([, e]) => needle.test(`${e.title} ${e.short} ${e.long ?? ""}`));
    assert.ok(hits.length > 0, `the help dictionary must still explain ${why}`);
    assert.ok(hits.some(([k]) => grouped.has(k)), `the entry for ${why} must be listed in a HELP_GROUPS bucket so the browse view shows it`);
  }
  assert.ok(searchHelp("forgot").length > 0, "a locked-out teacher searching 'forgot' must find the sign-in help");
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test("D5: the first-run tour promises only help affordances that exist", async () => {
  const { FTUX_TOURS } = await import("../../apps/web/src/components/ftux/FTUXTour.tsx");
  const callSites = (component: string) =>
    sourceFiles(SRC_DIR)
      .filter((f) => !f.includes(join("components", "help")))
      .filter((f) => new RegExp(`<${component}[\\s>]`).test(readFileSync(f, "utf8"))).length;
  const bodies = Object.values(FTUX_TOURS as Record<string, Array<{ body: string }>>).flat().map((s) => s.body);
  if (callSites("HelpTip") === 0) {
    for (const b of bodies) assert.ok(!/underline/i.test(b), `tour copy promises underlined help words, but no page renders a HelpTip: "${b}"`);
  }
  if (callSites("HelpDot") === 0) {
    for (const b of bodies) assert.ok(!/ⓘ/.test(b), `tour copy promises ⓘ icons, but no page renders a HelpDot: "${b}"`);
  }
});
