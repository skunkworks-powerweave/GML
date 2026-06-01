# Spec 088 — Anti-download deterrence polish

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 10 (Hardening — Tier 1)

## Overview

Layers a holistic, app-wide **anti-download deterrence** chrome on top of the per-asset protections already built (HLS signed-URL playback in spec 040, PDFViewer watermark in spec 058, ConfidentialityFooter in spec 027). This spec ships **three loosely-coupled deterrents** that work together but are each independently honest about being deterrence, not DRM:

1. **CSS-level frustrations** — appended to `globals.css`. `.no-select` strips text selection on media frames; `.no-context` neutralizes long-press callouts on touch devices; `.media-frame::after` paints a sub-1.5%-opacity 45° diagonal hatch over media regions so screenshots carry a faint visible texture that resists clean cropping; an `@media print` rule blanks all `video`, `iframe`, `[data-pdf-viewer]`, and `.no-print` regions and stamps a "Printing of confidential materials is prohibited." banner on the printed page in the GML serif/rust palette.
2. **AntiDownloadGuard component** — a `'use client'` module mounted once at the authenticated-route layout. It attaches global `keydown` listeners that `preventDefault()` on **Ctrl/Cmd+S** (save page), **Ctrl/Cmd+P** (print), and **PrintScreen** (best-effort). On PrintScreen it surfaces a 2-second toast through a `document.body` portal reading "Screenshots are logged." It also runs a one-shot DevTools-open heuristic (`window.outerHeight − window.innerHeight > 200`) and, if detected, emits a single `anti_download.devtools.detected` audit (throttled via `sessionStorage`).
3. **Layout integration** — `apps/web/src/app/(authenticated)/layout.tsx` mounts `<AntiDownloadGuard />` once at the top of the protected shell, alongside the existing `ConfidentialityFooter` (which the shells already render). This guarantees coverage on every authenticated route without per-page wiring.

### Honest disclosure (load-bearing)

The component's JSDoc and the README-IT.md sign-in copy both explicitly state: **this is deterrence, not prevention.** A determined adversary with browser DevTools, OS-level screen capture, or a proxy interception tool can still capture content. We bias toward raising the cost of casual exfiltration, not the impossible task of stopping a motivated attacker on a general-purpose computing platform. SM-4 (watermark on playback) and SM-9 (audit trail) remain the load-bearing defences; this spec adds friction on top.

## Functional Requirements

- **FR-001** — `apps/web/src/components/AntiDownloadGuard.tsx` exists, declares `'use client'` on line 1, exports a default React component that renders no visible chrome on mount and `null` from its render function unless a toast is active.
- **FR-002** — On mount, attaches a `window.addEventListener('keydown', handler)` that intercepts (a) `Ctrl+S` / `Cmd+S`, (b) `Ctrl+P` / `Cmd+P`, (c) `PrintScreen`. For each match it calls `event.preventDefault()` and `event.stopPropagation()`, then fires a best-effort `navigator.sendBeacon('/api/audit/client', body)` with `action: "anti_download.attempt.<key>"` (where `<key>` is one of `save | print | printscreen`). Beacon failure must not throw.
- **FR-003** — On `PrintScreen` key (caveat: browsers don't always expose it; the listener is best-effort), the guard renders a transient toast `"Screenshots are logged."` via `createPortal(..., document.body)` for 2000ms. The toast uses the GML rust accent (`var(--rust)` on paper background) and a `--shadow-3` lift; it is `pointer-events: none` so it never blocks clicks.
- **FR-004** — A `setInterval` runs at 1500ms intervals checking `window.outerHeight - window.innerHeight > 200` AND `window.outerWidth - window.innerWidth > 200`. Either condition (PC-friendly heuristic for an undocked DevTools panel) triggers a single `anti_download.devtools.detected` audit per session. Throttling uses `sessionStorage.setItem("antiDownloadGuard.devtoolsLogged", "1")`. The interval clears on unmount.
- **FR-005** — All event listeners and intervals are unbound in the `useEffect` cleanup. Re-mounts (e.g. fast-refresh in dev) must not leak listeners.
- **FR-006** — Component-level JSDoc (above the export) contains the **"deterrence"** literal and explicitly enumerates DevTools / OS screen capture / proxy interception as ways an adversary can still bypass it. This is asserted by the governance test as a permanent reminder against future "lockdown" rewrites.
- **FR-007** — `apps/web/src/app/globals.css` is **edited (not rewritten)** with appended classes — `.no-select`, `.no-context`, `.media-frame`, `.media-frame::after` — and a single `@media print { ... }` block. The CSS is additive; no existing tokens, theme rules, or a11y body-class overrides are touched.
- **FR-008** — `apps/web/src/app/(authenticated)/layout.tsx` is **edited (not rewritten)** to (a) import `AntiDownloadGuard` from `@/components/AntiDownloadGuard` and (b) mount `<AntiDownloadGuard />` inside the rendered tree so it lives for the lifetime of every authenticated route. The shell-switching desktop/mobile branch is preserved.

## Acceptance Criteria

| Behaviour | Verification |
| --- | --- |
| Ctrl/Cmd+S blocked | Open any authenticated page, press Ctrl+S → browser save dialog does NOT open; sendBeacon fires with action `anti_download.attempt.save` |
| Ctrl/Cmd+P blocked | Press Ctrl+P → browser print dialog does NOT open |
| PrintScreen surfaces toast | Press PrintScreen → ephemeral "Screenshots are logged." toast appears for 2s and fades |
| Print stylesheet blanks media | Trigger print preview (DevTools → Rendering → emulate print media) → all `<video>`, `<iframe>`, `[data-pdf-viewer]`, `.no-print` elements are hidden; serif rust banner reading the prohibition text is visible at top of paginated output |
| DevTools heuristic one-shot | Open DevTools, refresh, dock it on the side → exactly one `anti_download.devtools.detected` audit fires; closing/reopening DevTools in the same session does NOT re-fire (sessionStorage throttle) |
| No listener leak | Navigate between authenticated pages 10x → `window.getEventListeners(window).keydown.length` (Chrome DevTools) remains 1 |
| Layout still device-switches | `/login` (unauthenticated) renders without the guard; authenticated mobile request renders MobileShell with the guard mounted; desktop renders DesktopShell with the guard mounted |

## Audit hooks (SM-9)

Three free-form actions land in `audit_log.action` (varchar(64) since spec 021):

- `anti_download.attempt.save`
- `anti_download.attempt.print`
- `anti_download.attempt.printscreen`
- `anti_download.devtools.detected`

These ride the existing `/api/audit/client` route (added in spec 087 as part of the Tier-1 hardening pass — out of scope here; if absent, sendBeacon failures are silent by design and the deterrent CSS/UX still functions).

## Out of scope

- DRM / EME / encrypted-media playback — covered by signed-URL HLS in spec 040; we deliberately do not block screen capture at the OS level.
- Mobile screen-recording detection — the iOS/Android `requestVideoFrameCallback` heuristic is fragile and produces too many false positives; deferred.
- Disabling right-click globally — produces a worse UX without meaningful deterrence on a determined user (DevTools bypasses it in 2 keystrokes); we only neutralize the long-press callout on `.no-context` media regions.
- Watermarking PDFs at render time — already shipped in spec 058 (`PDFViewer` overlays viewer name + UTC timestamp).
- Server-side request-rate anomaly detection — separate Tier-2 hardening track.

## Design deviations

None. The CSS hatch opacity is tuned to ~1.2% — visible on a clean screenshot but invisible in normal viewing on the GML paper background.
