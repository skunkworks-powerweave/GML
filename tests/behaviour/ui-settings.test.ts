// /settings, followed from the controls a user actually touches: does what she
// picks take effect? See _ui.ts for mount() and the rendering harness.
//
// ── F125: the language choice ────────────────────────────────────────────────
//
// On a phone, Settings is the ONLY language control (the mobile shell has no
// topbar picker). Its pills fed a 400 ms debounced save that PUT the delta and
// showed "Saved" -- and then nothing: no router.refresh(), no reload. The
// menus, tabs and skip link are rendered by the shared (authenticated) layout,
// which the App Router does not re-render on a soft navigation, so the chrome
// stayed in the old language on every page until a hard reload. And a tap on
// a bottom tab inside the 400 ms window unmounted the form, whose effect
// cleanup cancelled the pending save: the choice was silently lost.
//
// Executed: the real SettingsForm through its own handlers, against a stubbed
// fetch and the app-router context next/navigation's useRouter reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { h, render, mount, textOf, withAppRouter, openingTags, attr } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

// Nothing here writes to Postgres, but the form's module graph imports
// @gml/db (settings/actions.ts -> lib/audit.ts), which refuses to load without
// a DATABASE_URL.
const skip = needsDatabase();

type El = { type: unknown; props: Record<string, unknown> };

/** Every element in a mounted tree, child components included (unexpanded). */
function allElements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) allElements(n, out);
  else if (node && typeof node === "object" && "props" in (node as object)) {
    out.push(node as El);
    allElements((node as El).props.children, out);
  }
  return out;
}

const DEFAULTS = {
  density: "regular",
  fontScale: "regular",
  highContrast: false,
  reducedMotion: false,
  showWatermark: true,
  uiLanguage: "en",
} as const;

type Put = { url: string; body: Record<string, unknown>; keepalive: boolean };

/** Mount the form with a recording fetch and router; always restores both. */
async function withSettingsForm(
  body: (ctx: { m: ReturnType<typeof mount>; puts: Put[]; router: string[] }) => Promise<void>,
  initial: Record<string, unknown> = {},
  /** How long the stubbed PUT takes to answer: a 2G link, when it matters. */
  delayMs = 0,
): Promise<void> {
  const { SettingsForm } = await import("../../apps/web/src/app/(authenticated)/settings/settings-form.tsx");
  const puts: Put[] = [];
  const router: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    puts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")), keepalive: init?.keepalive === true });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const { AppRouterContext } = createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "next/dist/shared/lib/app-router-context.shared-runtime",
  ) as { AppRouterContext: { _currentValue: unknown } };
  const previous = AppRouterContext._currentValue;
  AppRouterContext._currentValue = (withAppRouter(null, router) as { props: { value: unknown } }).props.value;
  try {
    const m = mount(SettingsForm as (p: unknown) => unknown, {
      initial: { ...DEFAULTS, ...initial },
      email: "audit-x@gml.local",
      roleLabel: "Observer",
      roleChipKind: "",
    });
    await body({ m, puts, router });
  } finally {
    globalThis.fetch = realFetch;
    AppRouterContext._currentValue = previous;
  }
}

const settle = () => new Promise((r) => setImmediate(r));

function clickText(m: ReturnType<typeof mount>, text: string): unknown {
  const el = allElements(m.tree).find((e) => typeof e.props.onClick === "function" && textOf(e).includes(text));
  assert.ok(el, `no clickable control reads "${text}"`);
  return (el.props.onClick as () => unknown)();
}

test("F125: picking a language in Settings saves it at once and re-renders the chrome in it", { skip }, async () => {
  await withSettingsForm(async ({ m, puts, router }) => {
    clickText(m, "हिन्दी");
    // Synchronously -- before any timer: a tab tapped straight after cannot
    // cancel a save that has already been sent.
    assert.equal(puts.length, 1, "the language must be PUT on the tap itself, not after a debounce an unmount can cancel");
    m.unmount();
    await settle();
    await settle();
    assert.equal(puts[0].url, "/api/user-prefs");
    assert.equal(puts[0].body.uiLanguage, "hi");
    assert.ok(
      router.includes("refresh"),
      "after the save the router must refresh, or the shared layout's menus stay in the old language until a hard reload",
    );
  });
});

test("F125: the tap's save is not sent a second time when the debounce fires", { skip }, async () => {
  await withSettingsForm(async ({ puts }) => {
    const { SettingsForm } = await import("../../apps/web/src/app/(authenticated)/settings/settings-form.tsx");
    const m = mount(
      SettingsForm as (p: unknown) => unknown,
      { initial: DEFAULTS, email: "x@gml.local", roleLabel: "Observer", roleChipKind: "" },
      { effects: true },
    );
    try {
      clickText(m, "हिन्दी");
      m.rerender(); // commit the new values: the debounce effect runs
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(puts.length, 1, "one tap, one PUT: on a slow link the debounce aborted the first and sent it again");
    } finally {
      m.unmount();
    }
  }, {}, 800);
});

test("F125: a change still inside the debounce window is sent when the page is left, not dropped", { skip }, async () => {
  await withSettingsForm(async ({ puts }) => {
    const { SettingsForm } = await import("../../apps/web/src/app/(authenticated)/settings/settings-form.tsx");
    const m = mount(
      SettingsForm as (p: unknown) => unknown,
      { initial: DEFAULTS, email: "x@gml.local", roleLabel: "Observer", roleChipKind: "" },
      { effects: true },
    );
    const toggle = allElements(m.tree).find((e) => e.props.label === "High contrast");
    assert.ok(toggle, "the High contrast row must render");
    (toggle.props.onChange as (v: boolean) => void)(true);
    m.rerender(); // the debounce timer is now pending
    assert.equal(puts.length, 0, "not yet: the debounce is still running");
    m.unmount(); // a bottom-tab tap 150ms later
    await settle();
    assert.equal(puts.length, 1, "leaving the page must not cancel the save");
    assert.deepEqual(puts[0].body, { highContrast: true });
    assert.equal(puts[0].keepalive, true, "keepalive, or the browser may cancel it with the page");
  });
});

test("F125: picking the language already in use sends nothing and refreshes nothing", { skip }, async () => {
  await withSettingsForm(async ({ m, puts, router }) => {
    clickText(m, "English");
    await settle();
    assert.equal(puts.length, 0);
    assert.deepEqual(router, []);
  });
});

// ── F127: Display and Privacy controls that did nothing ─────────────────────
//
// Density, Text size and the watermark switch saved and had no effect
// anywhere (see ui-display-prefs.test.ts for why each was removed rather than
// wired). High contrast and Reduced motion now apply, as body classes the
// root layout renders -- so their save must re-render the page, as the
// language's does, or they too would wait for a hard reload.

test("F127: Settings offers no control that does nothing", { skip }, async () => {
  const { SettingsForm } = await import("../../apps/web/src/app/(authenticated)/settings/settings-form.tsx");
  const html = await render(
    withAppRouter(h(SettingsForm, { initial: DEFAULTS, email: "x@gml.local", roleLabel: "Observer", roleChipKind: "" })),
  );
  const groups = openingTags(html, "div").filter((t) => attr(t, "role") === "radiogroup").map((t) => attr(t, "aria-label"));
  assert.ok(!groups.includes("Density"), "Density has no CSS behind it");
  assert.ok(!groups.includes("Text size"), "Text size changed no rendered size");
  const switches = openingTags(html, "button").filter((t) => attr(t, "role") === "switch").map((t) => attr(t, "aria-label"));
  assert.deepEqual(switches.sort(), ["High contrast", "Reduced motion"], "only the switches that take effect");
  assert.match(html, /data-testid="watermark-always-on"/, "the watermark is stated, not offered as a switch the player ignores");
});

test("F127: saving High contrast re-renders the page so it applies at once", { skip }, async () => {
  await withSettingsForm(async ({ puts, router }) => {
    const { SettingsForm } = await import("../../apps/web/src/app/(authenticated)/settings/settings-form.tsx");
    const m = mount(
      SettingsForm as (p: unknown) => unknown,
      { initial: DEFAULTS, email: "x@gml.local", roleLabel: "Observer", roleChipKind: "" },
      { effects: true },
    );
    try {
      const toggle = allElements(m.tree).find((e) => e.props.label === "High contrast");
      (toggle!.props.onChange as (v: boolean) => void)(true);
      m.rerender();
      await new Promise((r) => setTimeout(r, 450));
      await settle();
      assert.deepEqual(puts.map((p) => p.body), [{ highContrast: true }]);
      assert.ok(router.includes("refresh"), "the body classes are rendered by the root layout: without a refresh, nothing changes until a reload");
    } finally {
      m.unmount();
    }
  });
});
