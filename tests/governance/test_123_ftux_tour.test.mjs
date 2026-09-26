// Governance test for spec 123 — FTUX coach-marks revival.
//
// Verifies:
//   1. All five spec-kit files exist and the plan declares the CREATED /
//      EDITED / MIGRATED contract.
//   2. FTUXTour.tsx is a 'use client' component, accepts the (role,
//      ftuxSeenAt) prop pair, and reads role-specific step lists from the
//      FTUX_TOURS map that mirrors the JSX prototype's aliasing rule
//      (super_admin → programme_admin, observer → mentor).
//   3. The Skip / Got it buttons PUT against /api/user-prefs with a
//      ftuxSeenAt ISO string and gate on a single-fire ref so audit rows
//      stay clean.
//   4. (authenticated)/layout.tsx selects ftuxSeenAt from user_prefs and
//      mounts <FTUXTour /> above the device shell with role + ISO string.
//   5. Sidebar's data-help-anchor uses the `nav-${id}` prefix and Topbar
//      tags the bell with data-help-anchor='topbar-help' — the selector
//      contract the prototype's step list depends on.
//   6. globals.css declares the .ftux-* selectors + the ftux-pulse keyframes
//      ported 1:1 from help.jsx lines 670-705.
//   7. The Settings form renders a "Replay tour" affordance that PUTs
//      {ftuxSeenAt: null} and full-reloads the page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const FTUX_TOUR = "apps/web/src/components/ftux/FTUXTour.tsx";
const LAYOUT = "apps/web/src/app/(authenticated)/layout.tsx";
const SIDEBAR = "apps/web/src/components/nav/Sidebar.tsx";
const TOPBAR = "apps/web/src/components/nav/Topbar.tsx";
const GLOBALS = "apps/web/src/app/globals.css";
const SETTINGS_FORM = "apps/web/src/app/(authenticated)/settings/settings-form.tsx";
const SPEC_DIR = "specs/123-ftux-tour";

test("spec 123 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the FTUX revival spec`,
    );
  }
});

test("spec 123 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /components\/ftux\/FTUXTour\.tsx/,
    "plan.md must call out the new FTUXTour component in CREATED",
  );
  assert.match(
    src,
    /already exists|ftux_seen_at column already/i,
    "plan.md must note that no migration is required because user_prefs.ftux_seen_at already exists",
  );
});

test("spec 123 — FTUXTour.tsx is a 'use client' component", () => {
  const src = read(FTUX_TOUR);
  assert.match(
    src,
    /^"use client";/,
    "FTUXTour.tsx must declare 'use client' on the first line — the overlay relies on document.querySelector + window.addEventListener",
  );
});

test("spec 123 — FTUXTour reads role + ftuxSeenAt props and mirrors prototype role aliasing", () => {
  const src = read(FTUX_TOUR);
  // The two required props…
  assert.match(src, /role:\s*Role/, "FTUXTour must accept a `role: Role` prop");
  assert.match(
    src,
    /ftuxSeenAt:\s*string\s*\|\s*null/,
    "FTUXTour must accept a `ftuxSeenAt: string | null` prop",
  );
  // …and the prototype's role aliasing rule (help.jsx lines 484-485).
  assert.match(
    src,
    /FTUX_TOURS\.super_admin\s*=\s*FTUX_TOURS\.programme_admin/,
    "super_admin must alias to programme_admin (per help.jsx)",
  );
  assert.match(
    src,
    /FTUX_TOURS\.observer\s*=\s*FTUX_TOURS\.mentor/,
    "observer must alias to mentor (per help.jsx)",
  );
});

test("spec 123 — FTUXTour PUTs ftuxSeenAt to /api/user-prefs and renders nothing when seen", () => {
  const src = read(FTUX_TOUR);
  // The PUT endpoint…
  assert.match(
    src,
    /fetch\(\s*["']\/api\/user-prefs["']/,
    "FTUXTour must call fetch('/api/user-prefs', …) to persist completion",
  );
  // …with a PUT method…
  assert.match(
    src,
    /method:\s*["']PUT["']/,
    "completion must persist via HTTP PUT (matches the existing API contract)",
  );
  // …and a `ftuxSeenAt` ISO timestamp in the body.
  assert.match(
    src,
    /ftuxSeenAt:\s*new Date\(\)\.toISOString\(\)/,
    "completion body must set ftuxSeenAt to the current ISO timestamp",
  );
  // The dismissed-state guard short-circuits render.
  assert.match(
    src,
    /if\s*\(\s*dismissed\s*\)\s*return\s*null/,
    "FTUXTour must render null once dismissed so the overlay disappears immediately",
  );
});

test("spec 123 — FTUXTour gates the PUT against double-fire", () => {
  const src = read(FTUX_TOUR);
  assert.match(
    src,
    /savedRef\.current\s*=\s*true/,
    "FTUXTour must set savedRef.current = true after the first finish call so audit rows stay clean on double-click",
  );
  assert.match(
    src,
    /if\s*\(\s*savedRef\.current\s*\)\s*return/,
    "FTUXTour must short-circuit the second finish call",
  );
});

test("spec 123 — FTUXTour ports the prototype's ftux-* class names", () => {
  const src = read(FTUX_TOUR);
  for (const cls of ["ftux-root", "ftux-backdrop", "ftux-ring", "ftux-caption", "ftux-dots", "ftux-dot"]) {
    assert.match(
      src,
      new RegExp(`["'\`]${cls}`),
      `FTUXTour must render the .${cls} className so help.jsx's lines 670-705 CSS hooks engage`,
    );
  }
});

test("spec 123 — (authenticated)/layout.tsx selects ftuxSeenAt and mounts <FTUXTour>", () => {
  const src = read(LAYOUT);
  // The layout used to run its own `select({ uiLanguage, ftuxSeenAt })`. It
  // now takes the whole row from the per-request resolver that also decides
  // the UI language (i18n/resolve.ts, F124), so the invariant is: ftuxSeenAt
  // comes from that row, and the resolver reads user_prefs. Rendered for real
  // in tests/behaviour/ui-locale-source.test.ts.
  assert.match(src, /await viewerPrefs\(\)/, "layout must take user_prefs from the shared viewerPrefs() resolver");
  assert.match(src, /prefRow\?\.ftuxSeenAt/, "layout must derive ftuxSeenAt from that row");
  assert.match(read("apps/web/src/i18n/resolve.ts"), /\.from\(userPrefs\)/, "the resolver must read user_prefs");
  // The component must be mounted with the right props.
  assert.match(
    src,
    /<FTUXTour\s+role=\{user\.role\}\s+ftuxSeenAt=\{ftuxSeenAt\}\s+whatsapp=\{whatsappPhoneForUsers\(\) !== null\}\s*\/>/,
    "layout must mount <FTUXTour role={user.role} ftuxSeenAt={ftuxSeenAt} whatsapp={...} /> (FR-33)",
  );
  // Imports
  assert.match(
    src,
    /import\s+\{\s*FTUXTour\s*\}\s+from\s+["']@\/components\/ftux\/FTUXTour["']/,
    "layout must import FTUXTour from @/components/ftux/FTUXTour",
  );
});

test("spec 123 — Sidebar emits data-help-anchor with the nav- prefix", () => {
  const src = read(SIDEBAR);
  assert.match(
    src,
    /data-help-anchor=\{`nav-\$\{item\.id\}`\}/,
    "Sidebar must render data-help-anchor={`nav-${item.id}`} so the prototype's selectors resolve",
  );
});

// This test was titled "Topbar tags the BELL with data-help-anchor='topbar-help'"
// and the bell -- a link to /inbox -- is where the anchor sat: the tour's
// "Help is always here" step spotlit the notifications. Corrected in the
// 2026-09 freeze (fix brief D_ui #5): the anchor belongs on the help control.
// The rendered markup (exactly one anchor, not on the bell) is checked in
// tests/behaviour/ui-navigation.test.ts.
test("spec 123 — Topbar tags its HELP control, not the bell, with data-help-anchor='topbar-help'", () => {
  const src = read(TOPBAR);
  assert.match(
    src,
    /data-help-anchor=["']topbar-help["'][^>]*>\s*<HelpButton\b/,
    "Topbar must put data-help-anchor='topbar-help' on the element wrapping <HelpButton> so the FTUX 'Help is always here' step resolves to help",
  );
  const bell = src.match(/<Link\b[^>]*data-testid="topbar-bell"[^>]*>/);
  assert.ok(bell, "the bell link must still render");
  assert.doesNotMatch(bell[0], /data-help-anchor/, "the notifications bell must not carry the help anchor");
  assert.doesNotMatch(
    read("apps/web/src/components/help/HelpHeadbtn.tsx"),
    /data-help-anchor=["']topbar-help["']/,
    "HelpHeadbtn is a per-page-header button; hardcoding the anchor there would add a second match for every page that mounts one",
  );
});

test("spec 123 — globals.css declares the ftux selectors + the pulse keyframes", () => {
  const src = read(GLOBALS);
  for (const sel of [".ftux-root", ".ftux-backdrop", ".ftux-ring", ".ftux-caption", ".ftux-dots", ".ftux-dot"]) {
    const escaped = sel.replace(/\./g, "\\.");
    assert.match(
      src,
      new RegExp(escaped),
      `globals.css must declare the ${sel} selector`,
    );
  }
  assert.match(
    src,
    /@keyframes\s+ftux-pulse/,
    "globals.css must declare the @keyframes ftux-pulse animation",
  );
});

test("spec 123 — Settings form renders a Replay tour button that PUTs ftuxSeenAt: null", () => {
  const src = read(SETTINGS_FORM);
  assert.match(
    src,
    /Replay tour/,
    "Settings form must include a 'Replay tour' affordance",
  );
  assert.match(
    src,
    /ftuxSeenAt:\s*null/,
    "Replay must PUT {ftuxSeenAt: null} so the overlay re-arms on next render",
  );
  assert.match(
    src,
    /window\.location\.reload\(\)/,
    "Replay must reload the page so the server-side user_prefs read picks up the cleared timestamp",
  );
});

test("spec 123 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [FTUX_TOUR, LAYOUT, SIDEBAR, TOPBAR, SETTINGS_FORM]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
