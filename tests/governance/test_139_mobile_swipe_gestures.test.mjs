// Governance test for spec 139 — Mobile swipe gestures
// (Workflow Run 12 final frontend-parity closure).
//
// Closes the `LMS GML Frontend/mobile-details.jsx` right-swipe-to-back
// contract by wiring a small `useSwipe` hook into the two surfaces that need
// it: the mobile detail-page chrome (MobileDetailFrame via the new
// MobileDetailSwipeRegion client wrapper) and the mobile form runner
// (MobileFormRunner from spec 133).
//
// Four files are under audit:
//
//   1. apps/web/src/lib/use-swipe.ts (CREATED)
//      — pointer-event hook with threshold defaults, reduced-motion
//        subscription, SSR safety, and an imperative variant.
//   2. apps/web/src/components/shells/MobileDetailSwipeRegion.tsx (CREATED)
//      — tiny "use client" wrapper that wires onSwipeRight to router.back()
//        with a router.push(backHref) deep-link fallback.
//   3. apps/web/src/components/shells/MobileDetailFrame.tsx (EDITED)
//      — wraps the entire frame return in MobileDetailSwipeRegion; back-arrow
//        tap target is unchanged so the gesture is purely additive.
//   4. apps/web/src/components/forms/MobileFormRunner.tsx (EDITED)
//      — imports useSwipe and wires it to goNext (left-swipe, guarded by
//        !isReview) and goPrev (right-swipe); outermost div carries the
//        returned ref and touchAction: "pan-y".
//
// Plus the five spec-kit files under specs/139-mobile-swipe-gestures/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const HOOK_PATH = "apps/web/src/lib/use-swipe.ts";
const REGION_PATH = "apps/web/src/components/shells/MobileDetailSwipeRegion.tsx";
const FRAME_PATH = "apps/web/src/components/shells/MobileDetailFrame.tsx";
const RUNNER_PATH = "apps/web/src/components/forms/MobileFormRunner.tsx";
const SPEC_DIR = "specs/139-mobile-swipe-gestures";

// ---------- Spec-kit + plan.md contract ----------

test("spec 139 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile-swipe-gestures spec`,
    );
  }
});

test("spec 139 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(src, /use-swipe\.ts/, "plan.md must call out the new useSwipe hook");
  assert.match(
    src,
    /MobileDetailSwipeRegion/,
    "plan.md must call out the new MobileDetailSwipeRegion wrapper",
  );
  assert.match(
    src,
    /MobileDetailFrame\.tsx/,
    "plan.md must call out the MobileDetailFrame edit",
  );
  assert.match(
    src,
    /MobileFormRunner\.tsx/,
    "plan.md must call out the MobileFormRunner edit",
  );
});

// ---------- use-swipe.ts hook contract ----------

test("spec 139 — use-swipe.ts exists and exports the documented surface", () => {
  assert.ok(existsSync(resolve(root, HOOK_PATH)), `${HOOK_PATH} must exist`);
  const src = read(HOOK_PATH);
  // The hook must be a client module — it owns useEffect with window access.
  assert.match(
    src,
    /^\s*["']use client["']/m,
    "use-swipe.ts must declare 'use client' — it owns window.addEventListener",
  );
  // Named exports the consumers and the governance suite depend on.
  assert.match(
    src,
    /export\s+function\s+useSwipe\b/,
    "use-swipe.ts must export a named `useSwipe` function",
  );
  assert.match(
    src,
    /export\s+function\s+attachSwipe\b/,
    "use-swipe.ts must export a named `attachSwipe` imperative variant",
  );
  // Module-level constants — exported so callers and tests can read them.
  assert.match(
    src,
    /export\s+const\s+DEFAULT_THRESHOLD_PX\s*=\s*80\b/,
    "DEFAULT_THRESHOLD_PX must be exported as the literal 80",
  );
  assert.match(
    src,
    /export\s+const\s+DEFAULT_MAX_VERTICAL_PX\s*=\s*40\b/,
    "DEFAULT_MAX_VERTICAL_PX must be exported as the literal 40",
  );
  assert.match(
    src,
    /export\s+const\s+DEFAULT_MAX_DURATION_MS\s*=\s*400\b/,
    "DEFAULT_MAX_DURATION_MS must be exported as the literal 400",
  );
});

test("spec 139 — useSwipe uses pointer events and listens to the three lifecycle events", () => {
  const src = read(HOOK_PATH);
  // Pointer events, not touch — works on touch + mouse + Playwright.
  assert.match(
    src,
    /addEventListener\(\s*"pointerdown"/,
    "useSwipe must register a `pointerdown` listener",
  );
  assert.match(
    src,
    /addEventListener\(\s*"pointerup"/,
    "useSwipe must register a `pointerup` listener (where the gesture is sampled)",
  );
  assert.match(
    src,
    /addEventListener\(\s*"pointercancel"/,
    "useSwipe must register a `pointercancel` listener so cancelled gestures reset state",
  );
  // Listeners are passive — never preventDefault, so vertical scroll stays smooth.
  assert.match(
    src,
    /\{\s*passive:\s*true\s*\}/,
    "useSwipe listeners must be registered with { passive: true } so scroll stays smooth",
  );
  // Cleanup on unmount — every addEventListener has a matching removeEventListener.
  assert.match(
    src,
    /removeEventListener\(\s*"pointerdown"/,
    "useSwipe must remove the pointerdown listener on unmount",
  );
  assert.match(
    src,
    /removeEventListener\(\s*"pointerup"/,
    "useSwipe must remove the pointerup listener on unmount",
  );
});

test("spec 139 — useSwipe enforces threshold / vertical-drift / duration rejections", () => {
  const src = read(HOOK_PATH);
  // The detection heuristic must compare horizontal travel against the threshold.
  assert.match(
    src,
    /Math\.abs\(dx\)\s*<\s*threshold/,
    "useSwipe must reject horizontal travel below the threshold",
  );
  // Vertical drift must be capped so scroll never becomes a swipe.
  assert.match(
    src,
    /Math\.abs\(dy\)\s*>\s*maxVertical/,
    "useSwipe must reject gestures with vertical drift above maxVertical",
  );
  // Duration must be capped so slow drags aren't swipes.
  assert.match(
    src,
    /dt\s*>\s*maxDuration/,
    "useSwipe must reject gestures slower than maxDuration",
  );
  // Direction dispatch — negative dx = left, positive = right.
  assert.match(
    src,
    /if\s*\(\s*dx\s*<\s*0\s*\)/,
    "useSwipe must dispatch leftRef when dx < 0",
  );
});

test("spec 139 — useSwipe subscribes to prefers-reduced-motion and returns the flag", () => {
  const src = read(HOOK_PATH);
  // matchMedia subscription for the OS-level accessibility setting.
  assert.match(
    src,
    /matchMedia\(\s*"\(prefers-reduced-motion: reduce\)"\s*\)/,
    "useSwipe must subscribe to the prefers-reduced-motion media query",
  );
  // The boolean must be returned so callers can dampen their own animations.
  assert.match(
    src,
    /reducedMotion/,
    "useSwipe must expose a `reducedMotion` value to the caller",
  );
  // Subscription must be cleaned up — addEventListener + removeEventListener pair.
  assert.match(
    src,
    /mql\.addEventListener\?\.\(\s*"change"/,
    "useSwipe must register a 'change' listener on the matchMedia object",
  );
  assert.match(
    src,
    /mql\.removeEventListener\?\.\(\s*"change"/,
    "useSwipe must unsubscribe the matchMedia 'change' listener on unmount",
  );
});

test("spec 139 — useSwipe is SSR-safe (window/document only inside useEffect)", () => {
  const src = read(HOOK_PATH);
  // The SSR guard inside the gesture-detection effect.
  assert.match(
    src,
    /typeof\s+window\s*===\s*"undefined"/,
    "useSwipe must guard against SSR (typeof window === 'undefined' early-return)",
  );
});

// ---------- MobileDetailSwipeRegion contract ----------

test("spec 139 — MobileDetailSwipeRegion.tsx exists as a client component", () => {
  assert.ok(existsSync(resolve(root, REGION_PATH)), `${REGION_PATH} must exist`);
  const src = read(REGION_PATH);
  assert.match(
    src,
    /^\s*["']use client["']/m,
    "MobileDetailSwipeRegion must declare 'use client' — it owns useRouter + useSwipe",
  );
  assert.match(
    src,
    /export\s+function\s+MobileDetailSwipeRegion\b/,
    "MobileDetailSwipeRegion must export a named function",
  );
  // Must accept a backHref prop for the deep-link fallback.
  assert.match(
    src,
    /backHref/,
    "MobileDetailSwipeRegion must accept a backHref prop",
  );
});

test("spec 139 — MobileDetailSwipeRegion wires right-swipe to router.back() with backHref fallback", () => {
  const src = read(REGION_PATH);
  // useRouter from next/navigation, not next/router (pages router is gone).
  assert.match(
    src,
    /import\s*\{\s*useRouter\s*\}\s*from\s*"next\/navigation"/,
    "MobileDetailSwipeRegion must import useRouter from next/navigation (App Router)",
  );
  // useSwipe import from the lib path alias.
  assert.match(
    src,
    /import\s*\{\s*useSwipe\s*\}\s*from\s*"@\/lib\/use-swipe"/,
    "MobileDetailSwipeRegion must import useSwipe from @/lib/use-swipe",
  );
  // The right-swipe handler must call router.back().
  assert.match(
    src,
    /router\.back\(\)/,
    "MobileDetailSwipeRegion must call router.back() on swipe-right",
  );
  // Deep-link fallback — when history is empty, push backHref.
  assert.match(
    src,
    /window\.history\.length/,
    "MobileDetailSwipeRegion must check window.history.length for the deep-link fallback",
  );
  assert.match(
    src,
    /router\.push\(backHref\)/,
    "MobileDetailSwipeRegion must call router.push(backHref) when history is empty",
  );
  // Test-friendly data attribute on the region.
  assert.match(
    src,
    /data-testid="mobile-detail-swipe-region"/,
    "MobileDetailSwipeRegion must mark the wrapper with the mobile-detail-swipe-region testid",
  );
});

// ---------- MobileDetailFrame edit ----------

test("spec 139 — MobileDetailFrame imports and wraps the frame in MobileDetailSwipeRegion", () => {
  const src = read(FRAME_PATH);
  assert.match(
    src,
    /import\s*\{\s*MobileDetailSwipeRegion\s*\}\s*from\s*"\.\/MobileDetailSwipeRegion"/,
    "MobileDetailFrame must import MobileDetailSwipeRegion from the co-located file",
  );
  assert.match(
    src,
    /<MobileDetailSwipeRegion\b/,
    "MobileDetailFrame must render <MobileDetailSwipeRegion> in its return tree",
  );
  // The wrapper must receive the same backHref the back-arrow uses so the
  // tap path and the swipe path land on the same destination.
  assert.match(
    src,
    /<MobileDetailSwipeRegion\s+backHref=\{backHref\}/,
    "MobileDetailSwipeRegion must receive the same backHref as the back-arrow Link",
  );
  // The back-arrow Link must still exist — swipes are ADDITIVE, never a replacement.
  assert.match(
    src,
    /data-testid="mobile-detail-back"/,
    "MobileDetailFrame must still render the tap-friendly back-arrow Link (additive gesture)",
  );
});

// ---------- MobileFormRunner edit ----------

test("spec 139 — MobileFormRunner imports useSwipe and wires goNext / goPrev", () => {
  const src = read(RUNNER_PATH);
  assert.match(
    src,
    /import\s*\{\s*useSwipe\s*\}\s*from\s*"@\/lib\/use-swipe"/,
    "MobileFormRunner must import useSwipe from @/lib/use-swipe",
  );
  // The hook must be invoked at the top of the component body.
  assert.match(
    src,
    /useSwipe<HTMLDivElement>/,
    "MobileFormRunner must call useSwipe<HTMLDivElement>(...) for the outer container",
  );
  // Left-swipe → goNext, guarded by isReview so the submit isn't accidentally triggered.
  assert.match(
    src,
    /if\s*\(\s*isReview\s*\)\s*return/,
    "MobileFormRunner's left-swipe callback must early-return when isReview is true (no swipe-to-submit)",
  );
  assert.match(
    src,
    /goNext\(\)/,
    "MobileFormRunner's left-swipe must call goNext()",
  );
  // Right-swipe → goPrev, naturally guarded by the goPrev() Math.max(0, ...) cap.
  assert.match(
    src,
    /goPrev\(\)/,
    "MobileFormRunner's right-swipe must call goPrev()",
  );
});

test("spec 139 — MobileFormRunner attaches the swipe ref and declares touchAction: pan-y", () => {
  const src = read(RUNNER_PATH);
  // The outer div must wear the ref and the testid the existing tests pin.
  assert.match(
    src,
    /ref=\{swipeRef\}[\s\S]{0,200}data-testid="mobile-form-runner"/,
    "MobileFormRunner's outer div must attach the swipe ref alongside the existing mobile-form-runner testid",
  );
  // touchAction: "pan-y" so vertical scroll inside the form body is preserved
  // while horizontal travel is interpreted as a swipe.
  assert.match(
    src,
    /touchAction:\s*"pan-y"/,
    "MobileFormRunner's outer div must declare touchAction: 'pan-y' so vertical scroll wins over horizontal interpretation",
  );
  // The reducedMotion flag must be surfaced as a data attribute so a future
  // CSS rule can read it (animation throttling under prefers-reduced-motion).
  assert.match(
    src,
    /data-reduced-motion=/,
    "MobileFormRunner must expose data-reduced-motion on the outer div so downstream CSS can dampen animations",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 139 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [HOOK_PATH, REGION_PATH, FRAME_PATH, RUNNER_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 139 — no new dependencies were introduced (no react-spring / react-use-gesture / framer-motion)", () => {
  // The package.json under apps/web must not mention any animation /
  // gesture library. The hook is pure DOM + React.
  const pkg = read("apps/web/package.json");
  assert.ok(!/react-use-gesture/.test(pkg), "apps/web must not depend on react-use-gesture");
  assert.ok(!/@use-gesture\//.test(pkg), "apps/web must not depend on @use-gesture/*");
  assert.ok(!/react-spring/.test(pkg), "apps/web must not depend on react-spring");
  assert.ok(!/framer-motion/.test(pkg), "apps/web must not depend on framer-motion");
});

test("spec 139 — hook documents that swipes are ADDITIVE, not a replacement for tap", () => {
  // The "additive" contract is the spec's accessibility promise — encode it
  // as a literal comment in the source so a future contributor can't quietly
  // refactor it away.
  const src = read(HOOK_PATH);
  assert.match(
    src,
    /ADDITIVE/,
    "use-swipe.ts must document that swipes are ADDITIVE (gesture supplements tap, never replaces it)",
  );
});
