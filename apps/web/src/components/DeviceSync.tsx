"use client";

// Keeps the `gml-device` cookie in step with the actual viewport.
//
// ── WHAT WAS AND WAS NOT BROKEN ──────────────────────────────────────────────
//
// `lib/use-device.ts` had ZERO call sites, and line 22 of it is the only writer
// of the `gml-device` cookie. So the cookie was never set, and every request
// fell through to `getDeviceType()`'s User-Agent sniff.
//
// That sniff WORKS -- verified against real UA strings for iPhone Safari,
// Android Chrome and iPad, all of which resolve to "mobile". So the mobile
// shell has always rendered on actual phones, and the claim that the whole
// mobile branch was unreachable is wrong.
//
// What genuinely did not work is viewport-based selection:
//
//   * A desktop browser narrowed to phone width keeps the desktop shell, which
//     hardcodes `gridTemplateColumns: "248px 1fr"` as an inline style and so
//     cannot respond to width at all. That is the layout a teacher gets on a
//     small laptop or a tablet in split-screen.
//   * A device whose UA is not in the regex -- a foldable, a newer tablet, a
//     browser with UA reduction -- gets the desktop shell regardless of how
//     narrow it is. UA reduction is the direction browsers are moving, so this
//     gets worse over time rather than better.
//   * Rotating a tablet never changes anything.
//
// Mounting this in the authenticated layout sets the cookie on first paint and
// updates it when the viewport crosses the breakpoint, so the NEXT server
// render picks the right shell. It renders nothing.

import { useDeviceType } from "@/lib/use-device";
import type { DeviceType } from "@/lib/device";

export function DeviceSync({ initial }: { initial: DeviceType }) {
  // The hook owns the matchMedia listener and the cookie write. Seeding it with
  // what the server decided means the first client render agrees with the HTML
  // that was just delivered, so there is no hydration mismatch -- and the
  // correction, if any, lands on the following navigation rather than as a
  // flash of the wrong shell.
  useDeviceType(initial);
  return null;
}
