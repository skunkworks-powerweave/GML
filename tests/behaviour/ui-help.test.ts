// The help system, followed from the controls a user actually has on each
// device: the top bar's ? button on a computer, the ? FAB on a phone. See _ui.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { h, render, withAppRouter, withIntl, openingTags, elements, attr, mount, hostElements, textOf, withFakeWindow, SRC_DIR } from "./_ui.js";
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
  const html = await render(withAppRouter(await withIntl(h(Topbar, { user: USER, locale: "en" }), "en")));
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

// ── F128: the first-run tour on a phone ──────────────────────────────────────
//
// The tour's targets are sidebar anchors, and a phone renders no sidebar, so
// every step but the last fell back to a caption at {top:100, left:100} -- in
// a box 360px wide, on a 375px screen: x = 100..460. "Next" sat at x = 385..443,
// entirely off the screen, inside a fixed overlay that cannot be scrolled, so a
// first sign-in on a phone could only Skip. With a target found (the ? FAB,
// last step), `innerWidth - 380` went negative below 392px and clipped the
// caption on the left instead.
//
// Executed: the real FTUXTour, mounted with its effects against a stand-in
// window and document of a given size, walked with its own Next button.

type Box = { left: number; top: number; width: number; height: number };

/** Mount the tour in a `vw` x `vh` window whose anchors are `anchors`. */
function tourAt(vw: number, vh: number, anchors: Record<string, Box>) {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  g.window = { innerWidth: vw, innerHeight: vh, addEventListener() {}, removeEventListener() {} };
  g.document = {
    querySelector(sel: string) {
      const box = anchors[sel];
      return box ? { getBoundingClientRect: () => box } : null;
    },
  };
  const restore = () => {
    g.window = saved.window;
    g.document = saved.document;
  };
  return { restore };
}

function caption(tree: unknown): { style: Record<string, number>; next?: () => void } {
  const els = hostElements(tree);
  const cap = els.find((e) => e.props.className === "ftux-caption");
  assert.ok(cap, "the tour must render its caption");
  const next = els.find((e) => e.type === "button" && /Next/.test(textOf(e)));
  return { style: cap.props.style as Record<string, number>, next: next?.props.onClick as (() => void) | undefined };
}

/** The caption must lie wholly inside the viewport, 12px clear of each edge. */
function assertInside(style: Record<string, number>, vw: number, vh: number, where: string) {
  const width = style.width ?? 360; // the CSS width, when the style sets none
  assert.ok(style.left >= 12, `${where}: caption starts at x=${style.left}, off the left edge`);
  assert.ok(style.left + width <= vw - 12, `${where}: caption spans x=${style.left}..${style.left + width} on a ${vw}px screen -- its Next button is off the right edge`);
  assert.ok(style.top >= 12, `${where}: caption starts at y=${style.top}`);
  assert.ok(typeof style.maxHeight === "number" && style.top + style.maxHeight <= vh - 12, `${where}: caption may run past the bottom (top ${style.top}, maxHeight ${style.maxHeight})`);
}

test("F128: on a phone with no tour target, the caption and its Next button are on screen", async () => {
  const { FTUXTour } = await import("../../apps/web/src/components/ftux/FTUXTour.tsx");
  for (const [vw, vh] of [[320, 640], [360, 780], [375, 812], [390, 844], [412, 915], [1280, 800]] as const) {
    const env = tourAt(vw, vh, {});
    try {
      const m = mount(FTUXTour as (p: unknown) => unknown, { role: "mentor", ftuxSeenAt: null }, { effects: true });
      m.rerender();
      assertInside(caption(m.tree).style, vw, vh, `${vw}x${vh}, step 1`);
      m.unmount();
    } finally {
      env.restore();
    }
  }
});

test("F128: a target at the bottom right (the ? FAB) keeps the caption on screen, above it", async () => {
  const { FTUXTour, FTUX_TOURS } = await import("../../apps/web/src/components/ftux/FTUXTour.tsx");
  const steps = (FTUX_TOURS as Record<string, Array<{ target: string }>>).mentor;
  for (const [vw, vh] of [[360, 780], [375, 812], [1280, 800]] as const) {
    const fab = { left: vw - 58, top: vh - 128, width: 44, height: 44 };
    const env = tourAt(vw, vh, { [steps[steps.length - 1].target]: fab });
    try {
      const m = mount(FTUXTour as (p: unknown) => unknown, { role: "mentor", ftuxSeenAt: null }, { effects: true });
      for (let s = 1; s < steps.length; s += 1) {
        caption(m.tree).next!();
        m.rerender(); // the step changes; its effect measures the target
        m.rerender(); // ...and the measured rect is drawn
      }
      const { style, next } = caption(m.tree);
      assert.equal(next, undefined, "this is the last step (Got it)");
      assertInside(style, vw, vh, `${vw}x${vh}, FAB step`);
      assert.ok(style.top + style.maxHeight <= fab.top, `${vw}x${vh}: the caption must not cover the button it points at`);
      m.unmount();
    } finally {
      env.restore();
    }
  }
});

test("F128: on a phone the tour points at the bottom tabs, which carry the sidebar's anchors", async () => {
  const { BottomTabs } = await import("../../apps/web/src/components/nav/BottomTabs.tsx");
  const { FTUX_TOURS } = await import("../../apps/web/src/components/ftux/FTUXTour.tsx");
  for (const [role, expected] of [
    ["mentor", ["nav-mentorship", "nav-observation", "nav-repo"]],
    ["teacher", ["nav-rtt", "nav-observation", "nav-uploads"]],
    ["programme_admin", ["nav-repo"]],
  ] as const) {
    const html = await render(h(BottomTabs, { role }));
    const anchors = [...html.matchAll(/data-help-anchor="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(anchors).size, anchors.length, `${role}: an anchor on two tabs would spotlight whichever comes first`);
    for (const a of expected) assert.ok(anchors.includes(a), `${role}: the ${a} tab must carry its anchor`);
    const targets = (FTUX_TOURS as Record<string, Array<{ target: string }>>)[role].map((s) => s.target.match(/'([^']+)'/)![1]);
    for (const a of expected) assert.ok(targets.includes(a), `${role}: ${a} is a step of this role's tour`);
  }
});

test("F128: the tour still renders on the server, where there is no window to measure", async () => {
  // The layout mounts FTUXTour for every user who has not seen it, so its
  // first render is a server render. Reading window.innerWidth there throws
  // and takes the whole authenticated layout down with it.
  const { FTUXTour } = await import("../../apps/web/src/components/ftux/FTUXTour.tsx");
  assert.equal(typeof (globalThis as Record<string, unknown>).window, "undefined");
  const html = await render(h(FTUXTour, { role: "mentor", ftuxSeenAt: null }));
  const cap = openingTags(html, "div").find((t) => (attr(t, "class") ?? "") === "ftux-caption");
  assert.ok(cap, "the caption renders");
  assert.match(attr(cap, "style") ?? "", /visibility:hidden/, "unplaced until measured, not parked where a phone cannot show it");
});

test("every first-run tour points only at navigation its own role has", async () => {
  // The observer tour was the mentor's: its first step, "Your mentees live
  // here", pointed at a My mentees item observers do not have. And the
  // mentor's "Pending video reviews" step pointed at the Video library.
  const { FTUX_TOURS } = await import("../../apps/web/src/components/ftux/FTUXTour.tsx");
  const { NAV_BY_ROLE } = await import("../../apps/web/src/config/nav.ts");
  for (const [role, steps] of Object.entries(FTUX_TOURS)) {
    const anchors = new Set(NAV_BY_ROLE[role as keyof typeof NAV_BY_ROLE].flatMap((s) => s.items.map((i) => `nav-${i.id}`)));
    for (const s of steps) {
      const anchor = s.target.match(/data-help-anchor='([^']+)'/)?.[1];
      if (anchor === "topbar-help") continue;
      assert.ok(anchor && anchors.has(anchor), `${role}: "${s.title}" points at ${anchor}, which that role's navigation lacks`);
    }
  }
  const mentorReview = FTUX_TOURS.mentor.find((s) => /review/i.test(s.title));
  assert.match(mentorReview?.target ?? "", /nav-teach-back/, "the mentor's review step points at the review queue");
});
