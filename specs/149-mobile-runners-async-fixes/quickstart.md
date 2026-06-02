# Quickstart 149 — Mobile runners async / race fixes

Two manual smoke checks, each ~3 minutes. Both require Chrome
DevTools network throttling to surface the races in dev.

## (A) MobileFormRunner — autosave/submit race

1. Boot `pnpm dev` + the docker-compose db / redis / minio.
2. Sign in as a `mentor` on a viewport ≤ 768 px (device cookie / mql
   fork mounts the mobile runner).
3. Open any feedback form via `/forms/<slug>`. Fill the first
   question, then tap forward to the review screen.
4. DevTools → Network tab → throttling preset → "Slow 3G".
5. Tap Submit. The runner now:
   - calls `await flushSave()` — you'll see a PATCH to
     `/api/forms/drafts` complete in the Network panel,
   - THEN posts the FormData to the server action.
   The order is deterministic now; the PATCH always lands before
   the POST.
6. Regression check (pre-fix): with the throttling on, you used to
   be able to refresh the page during the brief window between the
   POST starting and the PATCH completing — the resurrected draft
   would be the OLD response, not the new one. With this fix the
   PATCH is guaranteed to land first; a refresh now reads the
   just-submitted shape.

## (B) MobileUploadRunner — unmount / redirect / callback races

7. On the same mentor session, open the mobile uploads page
   (`/uploads/new` under the mobile shell, spec 135).
8. Pick a small video file (≥ 5 MB so chunking actually happens).
   The Preview screen renders the first-frame thumb + the caption
   textarea.
9. Throttle to "Slow 3G" again. Tap Start upload. The progress bar
   begins ticking.
10. **Race 1 — unmount mid-upload:** tap the browser back arrow
    while the progress bar is between 20 % and 80 %. The runner
    unmounts. The console no longer shows a setState warning
    (previously you'd see "Can't perform a React state update on
    an unmounted component" for the in-flight `onProgress` /
    `onError` callbacks). Navigate back to the upload page — the
    error banner reads "Upload cancelled — try again" and the
    runner is back at the choose screen.
11. **Race 2 — success-then-unmount:** start a new upload, let it
    reach 100 %. The "✓ Uploaded" screen appears. In the 1200 ms
    window before redirect, tap the browser back arrow. The
    redirect timer is cancelled; `router.push("/uploads")` never
    fires. Console is clean — no setState warning.
12. **Race 3 — redirect rejection:** open DevTools console, paste:
    ```js
    Object.defineProperty(window, 'next', { get: () => { throw new Error("router torn down") }})
    ```
    (synthetic — a real teardown is hard to provoke in dev). Start
    a new upload, let it reach 100 %. After the 1200 ms timer the
    try/catch catches the rejection and the screen switches to the
    failed state with a Back + Retry pair. The user is never
    stuck.

## Desktop regression

13. Resize the browser back to > 768 px (or hard-set the cookie
    `gml-device=desktop`). The desktop FormRenderer + the desktop
    UploadProgress tray mount instead. Both flows still post a
    form / start a tus upload exactly as before — this spec
    touches neither. Verify by submitting a feedback form on the
    desktop: the submit completes normally; the autosave PATCH
    lands before the form POST (it already did pre-spec).

## Test gate

14. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 149"
    ```
    All assertions green. Full suite still passes (1083 / 1083
    pre-spec; this spec adds new tests but does not regress
    existing ones — the two edits are internal to the runners and
    no current test reaches into the modified lines).
