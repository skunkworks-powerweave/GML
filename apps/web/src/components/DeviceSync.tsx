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

//
// ── A WRONG FIRST GUESS IS CORRECTED AT ONCE ────────────────────────────────
//
// On a device's first visit there is no cookie, so the shell comes from the
// User-Agent sniff, and it can be wrong for the width: an iPad in portrait
// (it sends a Mac UA), an Android tablet in landscape, a narrow desktop
// window. The correction used to wait for "the next navigation". But a server
// action that writes a cookie re-renders the layout in its own response, and
// that render read the corrected cookie and swapped the shell -- remounting
// the whole page under it and dropping the action's result. A new teacher's
// first password change did exactly that: password changed, no confirmation,
// no way on, the form back as if nothing happened (review, 9 Oct 2026).
//
// So a guess the viewport contradicts is replaced straight away, once per
// device (the cookie is right from then on), before anyone has typed anything.
// A later rotation still waits for the next navigation: refreshing then could
// throw away what someone is typing.

import { useRouter } from "next/navigation";
import { useDeviceType } from "@/lib/use-device";
import type { DeviceType } from "@/lib/device";

export function DeviceSync({ initial }: { initial: DeviceType }) {
  const router = useRouter();
  // The hook owns the matchMedia listener and the cookie write. Seeding it with
  // what the server decided means the first client render agrees with the HTML
  // that was just delivered, so there is no hydration mismatch; the refresh
  // then re-renders with the cookie it has just written.
  useDeviceType(initial, () => router.refresh());
  return null;
}
