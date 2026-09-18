// Governance test for spec 137 — Mobile detail-page chrome.
//
// Workflow Run 12 (final frontend parity) — closes the
// LMS GML Frontend/mobile-details.jsx common-chrome surface. The
// wrapper at apps/web/src/components/shells/MobileDetailFrame.tsx is
// adopted on five major mobile detail pages (mentorship pairing,
// observation cycle, repo school / class / teacher).
//
// Files under audit:
//
//   1. apps/web/src/components/shells/MobileDetailFrame.tsx
//      — 44x44 back arrow, centered title with ellipsis truncation,
//        env(safe-area-inset-top) for the notch, optional sticky-save
//        bar at the bottom with env(safe-area-inset-bottom).
//   2. apps/web/src/components/shells/index.ts
//      — re-exports MobileDetailFrame + MobileDetailFrameProps.
//   3. The five adopting pages — each imports getDeviceType +
//      MobileDetailFrame and renders the frame on the mobile branch.
//
// Plus the five spec-kit files under specs/137-mobile-details-chrome/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const FRAME_PATH = "apps/web/src/components/shells/MobileDetailFrame.tsx";
const SHELLS_INDEX = "apps/web/src/components/shells/index.ts";
const MENTORSHIP_PAGE = "apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx";
const OBSERVATION_PAGE = "apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx";
const REPO_SCHOOL_PAGE = "apps/web/src/app/(authenticated)/repo/school/[id]/page.tsx";
const REPO_CLASS_PAGE = "apps/web/src/app/(authenticated)/repo/class/[id]/page.tsx";
const REPO_TEACHER_PAGE = "apps/web/src/app/(authenticated)/repo/teacher/[id]/page.tsx";
const SPEC_DIR = "specs/137-mobile-details-chrome";

const ADOPTING_PAGES = [
  MENTORSHIP_PAGE,
  OBSERVATION_PAGE,
  REPO_SCHOOL_PAGE,
  REPO_CLASS_PAGE,
  REPO_TEACHER_PAGE,
];

test("spec 137 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile-details chrome spec`,
    );
  }
});

test("spec 137 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /MobileDetailFrame\.tsx/,
    "plan.md must call out the new MobileDetailFrame component in CREATED",
  );
  assert.match(
    src,
    /mentorship\/\[pairingId\]/,
    "plan.md must list the mentorship adoption under EDITED",
  );
  assert.match(
    src,
    /observation\/\[cycleId\]/,
    "plan.md must list the observation adoption under EDITED",
  );
  assert.match(
    src,
    /repo\/school\/\[id\]/,
    "plan.md must list the repo school adoption under EDITED",
  );
});

test("spec 137 — MobileDetailFrame.tsx exists with the documented prop contract", () => {
  assert.ok(existsSync(resolve(root, FRAME_PATH)), `${FRAME_PATH} must exist`);
  const src = read(FRAME_PATH);
  // Named export so adopting pages can import { MobileDetailFrame }.
  assert.match(
    src,
    /export function MobileDetailFrame\b/,
    "MobileDetailFrame must be a named exported function",
  );
  // Props type also exported so callers can compose with TypeScript.
  assert.match(
    src,
    /export type MobileDetailFrameProps/,
    "MobileDetailFrame must export MobileDetailFrameProps for downstream typing",
  );
  // The four documented props must all be in the prop type.
  assert.match(src, /title:\s*string/, "props must include a string title");
  assert.match(src, /backHref:\s*string/, "props must include a string backHref");
  assert.match(
    src,
    /stickyAction\?:\s*ReactNode/,
    "props must include an optional stickyAction ReactNode",
  );
  assert.match(
    src,
    /children:\s*ReactNode/,
    "props must include the children ReactNode",
  );
});

test("spec 137 — MobileDetailFrame.tsx renders a 44x44 back-arrow Link", () => {
  const src = read(FRAME_PATH);
  // Back-arrow Link must be present with the test id and aria-label.
  assert.match(
    src,
    /data-testid="mobile-detail-back"/,
    "back-arrow Link must carry a data-testid for e2e coverage",
  );
  assert.match(
    src,
    /aria-label="Back"/,
    "back-arrow Link must declare aria-label='Back' for screen readers",
  );
  // The touch target must be 44x44 (Apple HIG / Material Design minimum).
  // We assert the width:44 / height:44 pattern appears in the back-arrow
  // styling block. The same dimensions also apply to the right slot, so
  // the literal must appear at least twice in the file.
  const widthMatches = src.match(/width:\s*44/g) ?? [];
  const heightMatches = src.match(/height:\s*44/g) ?? [];
  assert.ok(
    widthMatches.length >= 2,
    `expected at least two width:44 declarations (back + right slot), found ${widthMatches.length}`,
  );
  assert.ok(
    heightMatches.length >= 2,
    `expected at least two height:44 declarations (back + right slot), found ${heightMatches.length}`,
  );
  // The Link uses `next/link` Href — not a button + router.back() — so
  // deep-linked entries always have a valid parent.
  assert.match(
    src,
    /import\s+Link\s+from\s+"next\/link"/,
    "MobileDetailFrame must import Link from next/link for the back arrow",
  );
  assert.match(
    src,
    /href=\{backHref\}/,
    "back-arrow Link must point at the backHref prop",
  );
});

test("spec 137 — MobileDetailFrame.tsx centers the title with ellipsis truncation", () => {
  const src = read(FRAME_PATH);
  assert.match(
    src,
    /data-testid="mobile-detail-title"/,
    "title h1 must carry a data-testid for e2e coverage",
  );
  // Truncation contract: whiteSpace nowrap + overflow hidden + textOverflow ellipsis.
  assert.match(
    src,
    /whiteSpace:\s*"nowrap"/,
    "title must set whiteSpace: 'nowrap' so it truncates instead of wrapping",
  );
  assert.match(
    src,
    /overflow:\s*"hidden"/,
    "title must set overflow: 'hidden' for ellipsis truncation",
  );
  assert.match(
    src,
    /textOverflow:\s*"ellipsis"/,
    "title must set textOverflow: 'ellipsis' to render the truncation glyph",
  );
  // Centered via grid template — 44px / 1fr / 44px so the title cell is
  // centered regardless of whether rightAction is present.
  assert.match(
    src,
    /gridTemplateColumns:\s*"44px 1fr 44px"/,
    "header must use a 44px / 1fr / 44px grid so the title stays visually centered",
  );
});

test("spec 137 — MobileDetailFrame.tsx respects safe-area-inset env() for notch + home indicator", () => {
  const src = read(FRAME_PATH);
  // Top inset for the iOS notch / Android camera cutout.
  assert.match(
    src,
    /env\(safe-area-inset-top/,
    "header must consume env(safe-area-inset-top) so the chrome clears the notch",
  );
  // Bottom inset for the iPhone home indicator on the sticky bar.
  assert.match(
    src,
    /env\(safe-area-inset-bottom/,
    "sticky bar must consume env(safe-area-inset-bottom) so the action button floats above the home indicator",
  );
});

test("spec 137 — MobileDetailFrame.tsx renders an optional sticky bar at the bottom", () => {
  const src = read(FRAME_PATH);
  // Sticky bar must be present with the test id and conditional render
  // gated on the stickyAction prop.
  assert.match(
    src,
    /data-testid="mobile-detail-sticky"/,
    "sticky bar must carry a data-testid for e2e coverage",
  );
  // Conditional: `{stickyAction ? (...) : null}` — the bar only renders
  // when a sticky action is provided.
  assert.match(
    src,
    /\{stickyAction\s*\?/,
    "sticky bar must be conditional on the stickyAction prop (null when not provided)",
  );
  // Fixed positioning so it sticks to the bottom of the viewport.
  assert.match(
    src,
    /position:\s*"fixed"/,
    "sticky bar must use position: 'fixed' so it stays at the bottom on scroll",
  );
  // Bottom: 64 to sit above the BottomTabs (which live at bottom: 0).
  assert.match(
    src,
    /bottom:\s*64/,
    "sticky bar must sit at bottom: 64 so it clears the BottomTabs at bottom: 0",
  );
});

test("spec 137 — shells/index.ts re-exports MobileDetailFrame", () => {
  const src = read(SHELLS_INDEX);
  assert.match(
    src,
    /export\s*\{\s*MobileDetailFrame\s*\}\s*from\s*"\.\/MobileDetailFrame"/,
    "shells/index.ts must re-export MobileDetailFrame from the new file",
  );
  assert.match(
    src,
    /export type\s*\{\s*MobileDetailFrameProps\s*\}/,
    "shells/index.ts must re-export the MobileDetailFrameProps type",
  );
});

test("spec 137 — all five adopting pages import getDeviceType + MobileDetailFrame", () => {
  for (const page of ADOPTING_PAGES) {
    const src = read(page);
    assert.match(
      src,
      /import\s*\{\s*getDeviceType\s*\}\s*from\s*"@\/lib\/device"/,
      `${page} must import getDeviceType from @/lib/device for device-aware rendering`,
    );
    assert.match(
      src,
      /import\s*\{\s*MobileDetailFrame\s*\}\s*from\s*"@\/components\/shells"/,
      `${page} must import MobileDetailFrame from @/components/shells`,
    );
  }
});

test("spec 137 — all five adopting pages conditionally render MobileDetailFrame on mobile", () => {
  for (const page of ADOPTING_PAGES) {
    const src = read(page);
    // Device-aware branch: `device === "mobile" ? <MobileDetailFrame …`.
    assert.match(
      src,
      /device\s*===\s*"mobile"/,
      `${page} must branch on device === "mobile" to decide whether to wrap`,
    );
    assert.match(
      src,
      /<MobileDetailFrame\b/,
      `${page} must render <MobileDetailFrame /> on the mobile branch`,
    );
    // The wrap must include a title and backHref so both required props
    // are wired. We assert the prop names appear inside a sane window
    // after the MobileDetailFrame opening tag.
    const openIdx = src.indexOf("<MobileDetailFrame");
    assert.ok(openIdx >= 0, `${page} must contain the MobileDetailFrame open tag`);
    const window = src.slice(openIdx, openIdx + 400);
    assert.match(
      window,
      /title=/,
      `${page} must pass a title prop to MobileDetailFrame`,
    );
    assert.match(
      window,
      /backHref=/,
      `${page} must pass a backHref prop to MobileDetailFrame`,
    );
  }
});

test("spec 137 — observation page migrates the Sign-off CTA to stickyAction when canSignOff", () => {
  const src = read(OBSERVATION_PAGE);
  // The stickyAction const must reference canSignOff and the
  // signOffCycleAction so the sticky bar only appears when sign-off is
  // actually allowed.
  assert.match(
    src,
    /stickyAction\s*=/,
    "observation page must build a stickyAction const before the return",
  );
  assert.match(
    src,
    /canSignOff/,
    "stickyAction must be gated on canSignOff so it only appears in post_submitted",
  );
  assert.match(
    src,
    /stickyAction=\{stickyAction\}/,
    "observation page must pass stickyAction= to MobileDetailFrame",
  );
});

test("spec 137 — adopting pages preserve their original data-fetching above the frame", () => {
  // Spec 137's hard rule: do NOT change data-fetching, audit, or
  // role-gate logic on adopted pages. We assert the db.select calls and
  // role gates are still present after our edits — the wrap should be
  // purely cosmetic.
  const mentorshipSrc = read(MENTORSHIP_PAGE);
  // The pairing lookup moved into assertCanAccessPairing() in lib/authz.ts.
  // That is not a loss of data-fetching -- it is the same SELECT with an
  // ownership predicate attached, returning the row so the page does not pay
  // for a second round-trip. Previously this page loaded the pairing by id with
  // no ownership check at all and rendered the mentee teacher's phone number
  // into a wa.me link, so any authenticated user could read any mentee's
  // contact details from a guessed UUID.
  assert.match(
    mentorshipSrc,
    /assertCanAccessPairing\(|\.from\(mentorPairings\)/,
    "mentorship page must still resolve the pairing (directly or via assertCanAccessPairing)",
  );
  assert.match(
    mentorshipSrc,
    /hasAnyRole\(session\.user\.role/,
    "mentorship page must still gate on hasAnyRole for the canComplete decision",
  );
  const obsSrc = read(OBSERVATION_PAGE);
  // Same reasoning as the mentorship assertion above: the cycle SELECT moved
  // into assertCanAccessCycle(). This page previously never called auth() at
  // all and loaded any cycle by id, so any signed-in user could read any
  // teacher's evaluative observation.
  assert.match(
    obsSrc,
    /assertCanAccessCycle\(|\.from\(observationCycles\)/,
    "observation page must still resolve the cycle (directly or via assertCanAccessCycle)",
  );
  const repoSchoolSrc = read(REPO_SCHOOL_PAGE);
  assert.match(
    repoSchoolSrc,
    /READ_ROLES\.has\(role\)/,
    "repo school page must still enforce its READ_ROLES gate",
  );
});

test("spec 137 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [FRAME_PATH, ...ADOPTING_PAGES]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
