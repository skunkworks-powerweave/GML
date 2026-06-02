// Governance test for spec 138 — Mobile repo card-list (Workflow Run 12,
// FINAL frontend parity closure).
//
// Closes the LMS GML Frontend/mobile-repo.jsx::MobRepoIndex (lines 117-142)
// pattern by adding a generic <MobileRepoCardList /> component and
// adopting it conditionally on the seven repo index pages whose desktop
// renderers use 7+-column tables.
//
// Files under audit:
//
//   1. apps/web/src/components/repo/MobileRepoCardList.tsx (CREATED)
//      — generic card-list renderer. Pure server component. Each item is
//        a Next.js <Link>, full-card tap target, optional Hindi name under
//        the title, optional chip top-right, 1-3 secondary lines.
//   2-8. Seven repo index pages (EDITED) — each imports getDeviceType +
//        MobileRepoCardList, branches the render path on `device === "mobile"`,
//        and hides the existing `<table className="t">` desktop wrapper via
//        display: none + aria-hidden on mobile.
//
// Plus the five spec-kit files under specs/138-mobile-repo-card-list/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const COMPONENT_PATH = "apps/web/src/components/repo/MobileRepoCardList.tsx";
const SPEC_DIR = "specs/138-mobile-repo-card-list";

const ADOPTED_PAGES = [
  "apps/web/src/app/(authenticated)/repo/schools/page.tsx",
  "apps/web/src/app/(authenticated)/repo/teachers/page.tsx",
  "apps/web/src/app/(authenticated)/repo/mentors/page.tsx",
  "apps/web/src/app/(authenticated)/repo/subjects/page.tsx",
  "apps/web/src/app/(authenticated)/repo/sessions/page.tsx",
  "apps/web/src/app/(authenticated)/repo/resources/page.tsx",
  "apps/web/src/app/(authenticated)/repo/outlines/page.tsx",
];

test("spec 138 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile-repo-card-list spec`,
    );
  }
});

test("spec 138 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /MobileRepoCardList\.tsx/,
    "plan.md must call out the new MobileRepoCardList component in CREATED",
  );
  // All seven adopted pages must be enumerated in EDITED so the diff
  // intent is documented (matches the touched-files audit).
  for (const slug of ["schools", "teachers", "mentors", "subjects", "sessions", "resources", "outlines"]) {
    assert.match(
      src,
      new RegExp(`/repo/${slug}/page\\.tsx`),
      `plan.md must enumerate the ${slug} page edit`,
    );
  }
});

test("spec 138 — MobileRepoCardList.tsx exists and exports MobileRepoCardList", () => {
  assert.ok(existsSync(resolve(root, COMPONENT_PATH)), `${COMPONENT_PATH} must exist`);
  const src = read(COMPONENT_PATH);
  assert.match(
    src,
    /export function MobileRepoCardList/,
    "MobileRepoCardList must be a named export so server pages can import it",
  );
});

test("spec 138 — MobileRepoCardList is a server component (no 'use client')", () => {
  const src = read(COMPONENT_PATH);
  // The component is pure server — no state, no effects, just JSX +
  // Next.js Link. Declaring 'use client' would inflate the bundle for
  // every repo index page on mobile.
  assert.ok(
    !/^\s*["']use client["']/m.test(src),
    "MobileRepoCardList must NOT declare 'use client' — the component is server-rendered (each card is a <Link>)",
  );
  // It must import Next.js Link so the tap target routes client-side.
  assert.match(
    src,
    /import Link from "next\/link"/,
    "MobileRepoCardList must import Link from next/link so card taps route via the Next.js router",
  );
});

test("spec 138 — MobileRepoCardList card style honors the spec design tokens", () => {
  const src = read(COMPONENT_PATH);
  // Background, border, radius — direct CSS var references per the spec.
  assert.match(
    src,
    /background:\s*"var\(--card-hi\)"/,
    "card background must read from var(--card-hi)",
  );
  assert.match(
    src,
    /border:\s*"1px solid var\(--line\)"/,
    "card border must be 1px solid var(--line)",
  );
  assert.match(
    src,
    /borderRadius:\s*"var\(--r-3\)"/,
    "card border-radius must read from var(--r-3)",
  );
  // Padding 14, gap-inside 8, list-gap 12 — matches the JSX prototype.
  assert.match(
    src,
    /padding:\s*14/,
    "card padding must be 14 (matches mobile-repo.jsx::MobRepoIndex)",
  );
  assert.match(
    src,
    /gap:\s*12/,
    "list wrapper gap must be 12 (matches mobile-repo.jsx::MobRepoIndex)",
  );
  // Touch target floor — 44px minimum (Apple HIG + Material).
  assert.match(
    src,
    /minHeight:\s*44/,
    "card minHeight must be 44 for Apple HIG / Material touch-target compliance",
  );
});

test("spec 138 — MobileRepoCardList renders the primary serif title at 16px", () => {
  const src = read(COMPONENT_PATH);
  // Primary field uses the serif token at 16px / weight 600.
  assert.match(
    src,
    /fontFamily:\s*"var\(--serif\)"/,
    "primary title must use the var(--serif) font token",
  );
  assert.match(
    src,
    /fontSize:\s*16/,
    "primary title must render at 16px",
  );
});

test("spec 138 — MobileRepoCardList wraps each card in a Link with data-testid", () => {
  const src = read(COMPONENT_PATH);
  // Each card is a Link with a stable testid so downstream e2e tests can
  // pick them up without parsing inner content.
  assert.match(
    src,
    /<Link[\s\S]*?data-testid="mobile-repo-card"/,
    "each card must be a <Link> tagged with data-testid='mobile-repo-card'",
  );
  // The href flows straight from the item.
  assert.match(
    src,
    /href=\{it\.href\}/,
    "the Link must take its href from item.href",
  );
});

test("spec 138 — MobileRepoCardList surfaces optional chip + Hindi line", () => {
  const src = read(COMPONENT_PATH);
  // Chip top-right uses the existing .chip utility + optional kind class.
  assert.match(
    src,
    /className=\{`chip \$\{it\.chip\.kind \?\? ""\}`\.trim\(\)\}/,
    "chip must compose `.chip .chip-<kind>` from item.chip.kind",
  );
  // Hindi line uses the var(--deva) font token and the `deva` utility class.
  assert.match(
    src,
    /fontFamily:\s*"var\(--deva\)"/,
    "Hindi subtitle must use the var(--deva) font token",
  );
  assert.match(
    src,
    /className="deva"/,
    "Hindi subtitle must carry the .deva utility class for consistency with the desktop tables",
  );
});

test("spec 138 — MobileRepoCardList renders an empty state when items is empty", () => {
  const src = read(COMPONENT_PATH);
  // The empty branch has its own testid + a dashed-border treatment so
  // QA can spot a "no rows" view at a glance.
  assert.match(
    src,
    /items\.length === 0/,
    "MobileRepoCardList must short-circuit on items.length === 0",
  );
  assert.match(
    src,
    /border:\s*"1px dashed var\(--line\)"/,
    "empty state must use a dashed border (matches admin MobileEntityCardList pattern)",
  );
});

test("spec 138 — every adopted repo page imports getDeviceType and MobileRepoCardList", () => {
  for (const path of ADOPTED_PAGES) {
    const src = read(path);
    assert.match(
      src,
      /import\s*\{\s*getDeviceType\s*\}\s*from\s*"@\/lib\/device"/,
      `${path} must import getDeviceType from @/lib/device`,
    );
    assert.match(
      src,
      /import\s*\{\s*MobileRepoCardList\s*\}\s*from\s*"@\/components\/repo\/MobileRepoCardList"/,
      `${path} must import MobileRepoCardList from @/components/repo/MobileRepoCardList`,
    );
  }
});

test("spec 138 — every adopted page awaits getDeviceType and branches on mobile", () => {
  for (const path of ADOPTED_PAGES) {
    const src = read(path);
    assert.match(
      src,
      /const device = await getDeviceType\(\)/,
      `${path} must call await getDeviceType()`,
    );
    // The mobile branch renders the card list — match the JSX shape.
    assert.match(
      src,
      /device === "mobile" \? \(\s*\n?\s*<MobileRepoCardList/,
      `${path} must render <MobileRepoCardList /> behind a 'device === "mobile"' check`,
    );
  }
});

test("spec 138 — every adopted page hides the desktop table when device is mobile", () => {
  for (const path of ADOPTED_PAGES) {
    const src = read(path);
    // The desktop wrapper now carries a `display: none` style + aria-hidden
    // attribute when device is mobile. Both are required so screen readers
    // don't read out the duplicate table.
    assert.match(
      src,
      /device === "mobile" \? \{\s*display:\s*"none"/,
      `${path} must apply display: none to the desktop wrapper on mobile`,
    );
    assert.match(
      src,
      /aria-hidden=\{device === "mobile"\}/,
      `${path} must set aria-hidden on the desktop wrapper when device is mobile`,
    );
  }
});

test("spec 138 — every adopted page passes a testIdSuffix for the entity", () => {
  // Per-entity testIdSuffix gives downstream e2e tests a stable hook on
  // each page (e.g. `[data-testid="mobile-repo-cards-schools"]`).
  const expected = {
    schools: "schools",
    teachers: "teachers",
    mentors: "mentors",
    subjects: "subjects",
    sessions: "sessions",
    resources: "resources",
    outlines: "outlines",
  };
  for (const [slug, suffix] of Object.entries(expected)) {
    const path = `apps/web/src/app/(authenticated)/repo/${slug}/page.tsx`;
    const src = read(path);
    assert.match(
      src,
      new RegExp(`testIdSuffix="${suffix}"`),
      `${path} must pass testIdSuffix="${suffix}" so the rendered list carries a stable [data-testid]`,
    );
  }
});

test("spec 138 — adopted pages preserve their existing SQL query bodies", () => {
  // Spec 138 is a pure-UI fork. We assert that the Drizzle query roots
  // (the `db.select(...).from(...)` chain entry points) still exist on
  // every adopted page so a future regression that swaps them out would
  // trip this gate. We do NOT pin the exact SELECT shape — that's the
  // job of spec 129's filter coverage.
  for (const path of ADOPTED_PAGES) {
    const src = read(path);
    assert.match(
      src,
      /db\s*\n?\s*\.\s*select\s*\(/,
      `${path} must still issue at least one db.select(...) call (spec 138 is a UI-only fork)`,
    );
  }
});

test("spec 138 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  const allFiles = [COMPONENT_PATH, ...ADOPTED_PAGES];
  for (const path of allFiles) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
