// The Display and Privacy settings either take effect or are not offered.
//
// ── THE DEFECT (F127) ────────────────────────────────────────────────────────
//
// /settings offered Density, Text size, High contrast, Reduced motion and
// "Watermark videos with my name". Each one saved -- PUT 200, the row changed,
// the control showed the new value -- and none did anything: the root layout
// rendered <body class="min-h-full flex flex-col"> whatever the row said, and
// nothing ever added the body.a11y-* classes globals.css defines. A low-vision
// teacher who turned on High contrast was told "Saved" and saw no change.
//
// What each control became:
//   - High contrast, Reduced motion: applied, as body classes the root layout
//     derives from the same per-request user_prefs row as the UI language
//     (i18n/resolve.ts), so portals (QuickFind, the anti-download toast)
//     are covered too, and on the first paint -- no client-side flash.
//   - Density: removed. globals.css has no density rules at all.
//   - Text size: removed. Nearly every size in the app is an inline px value
//     a body font-size cannot reach; CSS zoom can, but it also multiplies
//     vw/vh (checked in Chrome 152: 100dvh under zoom 1.2 draws 120% of the
//     viewport), which pushes the help panel, QuickFind and the upload modal
//     -- all sized in vw -- off a phone's screen. Doing it properly is a
//     px-to-rem change across the app, not a settings fix.
//   - Watermark: removed, and stated as always on. Honouring it would let a
//     viewer switch off the viewer-identifying overlay (SM-4) just before
//     screen-recording; the player has always drawn it regardless.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render, request, openingTags, attr } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();

async function bodyClasses(): Promise<string[]> {
  const { default: RootLayout } = await import("../../apps/web/src/app/layout.tsx");
  const html = await render(h(RootLayout, null, h("p", null, "x")));
  return (attr(openingTags(html, "body")[0] ?? "", "class") ?? "").split(/\s+/).filter(Boolean);
}

async function withPrefs(
  prefs: { high_contrast?: boolean; reduced_motion?: boolean } | null,
  body: () => Promise<void>,
): Promise<void> {
  await withClient(async (c) => {
    const f = fixture(c, tag("display-prefs"));
    try {
      const id = await f.user("teacher");
      if (prefs) {
        await c.query(
          `INSERT INTO user_prefs (user_id, high_contrast, reduced_motion) VALUES ($1, $2, $3)`,
          [id, prefs.high_contrast ?? false, prefs.reduced_motion ?? false],
        );
      }
      actAs(id, "teacher");
      await body();
    } finally {
      await f.cleanup();
    }
  });
}

test("F127: High contrast and Reduced motion reach every page the user opens", { skip }, async () => {
  await withPrefs({ high_contrast: true, reduced_motion: true }, async () => {
    const cls = await bodyClasses();
    assert.ok(cls.includes("a11y-high-contrast"), `body must carry a11y-high-contrast, got ${JSON.stringify(cls)}`);
    assert.ok(cls.includes("a11y-reduced-motion"), `body must carry a11y-reduced-motion, got ${JSON.stringify(cls)}`);
    assert.ok(cls.includes("flex"), "the layout's own classes stay");
  });
  await withPrefs({ high_contrast: true }, async () => {
    const cls = await bodyClasses();
    assert.ok(cls.includes("a11y-high-contrast"));
    assert.ok(!cls.includes("a11y-reduced-motion"), "only what was turned on");
  });
});

test("F127: nothing saved, or signed out, the page is unchanged", { skip }, async () => {
  await withPrefs(null, async () => {
    assert.deepEqual((await bodyClasses()).filter((c) => c.startsWith("a11y-")), []);
  });
  await withPrefs({}, async () => {
    assert.deepEqual((await bodyClasses()).filter((c) => c.startsWith("a11y-")), []);
  });
  request.session = null; // the login page
  assert.deepEqual((await bodyClasses()).filter((c) => c.startsWith("a11y-")), []);
});
