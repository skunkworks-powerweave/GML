# Spec 156 — Client-component hardening (Workflow Run 14 audit closure, MEDIUM)

## Why

The 7-agent code audit at the close of Workflow Run 13 flagged five
MEDIUM-severity edge cases inside five separate client components that
together form the authenticated-route chrome. None is a security hole
on its own; together they degrade UX on slow or hostile environments
(the same Ladakh field-mentor 2G/3G links spec 149 closed for) and
pollute the audit log:

1. **`QuickFind.tsx` line 350 — `createPortal` without try/catch.**
   On an SSR hydration mismatch (or the transient print-preview
   teardown of `document.body` that some browser extensions trigger)
   `createPortal` throws synchronously. Pre-fix that propagated up to
   the authenticated layout and crashed the whole route tree. Wrapping
   the call in try/catch and returning `null` on failure means a
   single render miss is silently absorbed — the next state update
   retries the portal cleanly.

2. **`HlsPlayer.tsx` line 68 — `import("hls.js")` with no `.catch`.**
   If the hls.js dynamic chunk fails to load (corrupted bundle, offline
   page cached without the chunk, CDN 404), the import rejects, the
   `.then` never fires, and the user sees a silent black `<video>`
   element. No error message, no log. Chaining a `.catch` that calls
   `setError("Failed to load HLS player: " + String(err))` gives the
   user a clear failure mode and a hint to refresh.

3. **`UploadProgress.tsx` lines 46-75 — tus fallback path is silent.**
   When `import("tus-js-client")` returns null (the lazy chunk failed)
   the upload row is marked `failed` with no explanation. The user has
   no idea why or what to try next. Pre-fix this would also fire on
   the catch arm of the outer try block — also silent. Both paths now
   set an `errorMessage` on the upload row pointing the user at the
   WhatsApp PRIMARY path. The message renders inline below the
   progress bar in a `role="alert"` div so screen-readers announce it
   and `data-testid="upload-error-message"` makes it scrapable for the
   Playwright suite if a future spec wants integration coverage.

4. **`AntiDownloadGuard.tsx` lines 81-106 — DevTools heuristic false
   positives on resize.** The 200 px outerHeight-innerHeight delta
   fires during the OS's window-maximize / window-restore animation
   (Windows snaps, macOS green-button transitions). Pre-fix each
   transient maximize emitted an `anti_download.devtools.detected`
   audit row, polluting the log and burning the once-per-session
   throttle on a non-event. The 1-second debounce below requires the
   delta to PERSIST for >1s before we audit; transient resize
   animations clear the timer without firing. Re-checks the delta
   INSIDE the timer because the user may have closed devtools during
   the debounce window.

5. **`HelpPanel.tsx` lines 75-88 — input/textarea check too narrow.**
   The `?` shortcut handler checked `target.tagName === "INPUT" ||
   "TEXTAREA" || target.isContentEditable`. This misses nested
   contenteditable widgets (a `<p>` inside a `<div
   contenteditable="true">` — the rich-text comment box pattern) and
   any future input nested inside a custom shadow-DOM-style wrapper.
   Switching to `target.closest('input, textarea,
   [contenteditable="true"]')` walks the DOM tree and matches the
   browser's own built-in-shortcut behaviour.

## What we ship

### `apps/web/src/components/quickfind/QuickFind.tsx` (EDITED)

- The `createPortal(overlay, document.body)` return-site is wrapped in
  `try { return createPortal(...); } catch { return null; }`. An inline
  comment marks the fix as Spec 156 so a future contributor knows why
  the wrapper is there.

### `apps/web/src/components/video/HlsPlayer.tsx` (EDITED)

- The `import("hls.js").then(...)` chain gains a `.catch((err) => { if
  (!cancelled) setError("Failed to load HLS player: " + String(err)); })`.
  The `cancelled` flag is the existing one declared two lines above —
  no new state, no new ref. An inline Spec 156 comment notes the
  contract.

### `apps/web/src/components/video/UploadProgress.tsx` (EDITED)

- `UploadState` gains an optional `errorMessage?: string` field.
- The tus-load-failed path (both the `else` branch when `tus` is null
  AND the outer `catch` arm) sets `status: "failed"` AND `errorMessage:
  "Upload library unavailable. Please try the WhatsApp PRIMARY path
  instead."` so the user has both a state and a reason.
- A `role="alert"` `<div>` renders below the progress bar when
  `u.status === "failed" && u.errorMessage` is truthy. Carries
  `data-testid="upload-error-message"` for future integration tests.

### `apps/web/src/components/AntiDownloadGuard.tsx` (EDITED)

- A new `let pendingDevtoolsTimer` captured by the `useEffect` body.
  When the size delta exceeds 200 px AND `pendingDevtoolsTimer == null`,
  arm a `setTimeout(... , 1000)` that re-checks the delta and (if
  still exceeded) emits the audit through the existing throttle path.
- When the delta CLEARS while a timer is pending, the polling tick
  `clearTimeout`s the pending timer and nulls the ref — that resize
  animation never gets audited.
- The cleanup function clears the pending timer alongside the existing
  `clearInterval` so a fast unmount doesn't leave a timer to fire on
  an unmounted component.

### `apps/web/src/components/help/HelpPanel.tsx` (EDITED)

- The `?` / Shift+/ / ⌘? handler swaps the `tag === "INPUT"`-style
  branch for `if (target?.closest('input, textarea,
  [contenteditable="true"]')) return`. Single line change, walks the
  DOM tree, matches browser-builtin behaviour. Inline Spec 156 comment.

## Acceptance criteria

- `QuickFind.tsx` contains the literal `try { return createPortal` and
  `catch { return null` sequence at the bottom of the component body.
- `HlsPlayer.tsx` chains `.catch((err) =>` onto the `import("hls.js")`
  promise and the catch arm calls `setError("Failed to load HLS player: "`.
- `UploadProgress.tsx` declares `errorMessage?: string` on `UploadState`,
  both fallback paths (the `else` branch and the outer catch) populate
  it with `"Upload library unavailable. Please try the WhatsApp PRIMARY
  path instead."`, and the rendered list shows a `role="alert"` div
  carrying that message.
- `AntiDownloadGuard.tsx` declares `let pendingDevtoolsTimer` and arms
  a `setTimeout(..., 1000)` inside the polling interval; the cleared
  branch calls `clearTimeout(pendingDevtoolsTimer)`; the unmount
  cleanup also clears the pending timer.
- `HelpPanel.tsx` contains the literal `closest('input, textarea,
  [contenteditable="true"]')` check.
- All five spec-kit files exist under
  `specs/156-client-component-hardening/`.
- `tests/governance/test_156_client_component_hardening.test.mjs`
  passes with at least 10 assertions covering the above.

## Non-goals

- **No schema change.** All five fixes are purely client-side; no API,
  no migrations directory delta (next idx 0018 is still reserved for
  spec 153).
- **No new dependencies.** No error-boundary library, no debounce util
  (the LMS already has hand-rolled debounce in QuickFind itself).
- **No fix for the underlying tus / hls dynamic-import flakiness.** If
  those chunks fail to load it's an infrastructure problem (CDN, build
  output) that this spec only surfaces, not resolves. The audit
  follow-up that fixes the build pipeline is a separate spec.
- **No "did the audit emission actually fire" Playwright test.** The
  devtools heuristic is intentionally a weak signal; pinning the
  source-shape of the debounce in the governance test is the contract.
