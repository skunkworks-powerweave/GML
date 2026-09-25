// "Try again" on an error page re-fetches the page, not only re-renders it.
//
// ── THE DEFECT (F130) ────────────────────────────────────────────────────────
//
// All three error boundaries wired "Try again" to Next's `reset` prop. In the
// installed Next (16.2), reset is `setState({ error: null })`: it re-renders
// the boundary's children from the RSC payload the client already holds. For
// a Server Component failure that payload IS the error, so the page throws
// again at once, and no request reaches the server -- a database timeout on a
// flaky Ladakh link that has since cleared can never be picked up. Measured
// live: three presses, zero requests, the error page stayed while the server
// answered 200. `unstable_retry` (router.refresh() and reset inside a
// transition, node_modules/next/dist/client/components/error-boundary.js) is
// the prop that recovers; the docs say to use it "in most cases".
//
// Executed: each real boundary component, through its own button's handler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mount, hostElements, textOf } from "./_ui.js";

const BOUNDARIES = [
  ["(authenticated)/error.tsx", () => import("../../apps/web/src/app/(authenticated)/error.tsx")],
  ["error.tsx", () => import("../../apps/web/src/app/error.tsx")],
  ["global-error.tsx", () => import("../../apps/web/src/app/global-error.tsx")],
] as const;

for (const [name, load] of BOUNDARIES) {
  test(`F130: ${name} — "Try again" re-fetches the failed segment (unstable_retry), not only re-renders it`, async () => {
    const { default: Boundary } = await load();
    const calls: string[] = [];
    const m = mount(Boundary as (p: unknown) => unknown, {
      error: Object.assign(new Error("x"), { digest: "d1" }),
      reset: () => calls.push("reset"),
      unstable_retry: () => calls.push("unstable_retry"),
    });
    const button = hostElements(m.tree).find((el) => el.type === "button" && textOf(el).includes("Try again"));
    assert.ok(button, `${name} must offer Try again`);
    (button.props.onClick as () => void)();
    assert.deepEqual(calls, ["unstable_retry"], "reset() replays the payload that failed; only a re-fetch can recover from a server error that has cleared");
  });
}
