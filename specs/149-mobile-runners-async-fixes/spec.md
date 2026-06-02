# Spec 149 — Mobile runners async / race fixes (Workflow Run 13 audit closure)

## Why

The 7-agent code audit at the close of Workflow Run 13 flagged three HIGH
severity race conditions inside the two mobile runner components shipped
during Workflow Run 12 (specs 133 and 135). Each race is the kind that
hides in normal-network development and only surfaces on the 2G / 3G
links field mentors actually use in Ladakh:

1. **`MobileFormRunner.tsx` — `flushSave` not awaited before
   `requestSubmit`.** The desktop sibling (`FormRenderer.tsx`, spec 072
   line 534) awaits the final autosave before posting the FormData so
   the saved-draft row is byte-identical to the data the server is
   about to ingest. The mobile runner shipped with `void flushSave();
   formRef.current?.requestSubmit();` — the autosave PATCH and the
   submit POST race. On a slow link the POST can land first; if the
   user then refreshes mid-submit, the resurrected draft is the
   prior-response shape, not the just-submitted one, and the user
   sees their old answers come back. The fix is one keyword: `await`.

2. **`MobileUploadRunner.tsx` — `router.push` fires unconditionally on
   `onSuccess`.** Currently `onSuccess` schedules
   `window.setTimeout(() => router.push("/uploads"), 1200)` with no
   cancellation token and no try/catch. Three failure modes:
   (a) The user navigates away in the 1200 ms window — the timer still
   fires, `router.push` runs on an unmounted component, React logs a
   warning and the navigation races whatever click the user just made
   on the new page.
   (b) The `router.push` itself rejects (router torn down, navigation
   blocked) — the user is left staring at a "✓ Uploaded" screen with
   no way out.
   (c) The tus `onError` / `onProgress` callbacks can also fire after
   unmount because the tus instance is captured in a closure that
   outlives the React tree. setState-after-unmount warnings ensue.

3. **`MobileUploadRunner.tsx` — unmount mid-upload aborts the tus
   instance but never surfaces an error.** Lines 235-239 of the
   shipped file do `useEffect(() => () => uploadRef.current?.abort())`.
   When the parent unmounts mid-upload the abort runs, but the user's
   last-seen state is a stalled progress bar — they don't know whether
   the file made it. On remount they have to guess.

## What we ship

### `apps/web/src/components/forms/MobileFormRunner.tsx` (EDITED)

- `onSubmitClick` becomes `async`. The `void flushSave()` line becomes
  `await flushSave()`. The function continues to call
  `formRef.current?.requestSubmit()` after the autosave resolves so
  the FormData posted to the server-action is guaranteed to match the
  saved draft row. Mirrors `FormRenderer.tsx::onSubmitForm` from spec
  072 (which already awaits its `flushSave` before posting). The
  callback identity stays in the existing `useCallback` deps array;
  no React rules-of-hooks violation.

### `apps/web/src/components/video/MobileUploadRunner.tsx` (EDITED)

Three closure-discipline fixes layered onto the existing component:

- **`mountedRef` + `redirectTimerRef`**. Two new refs. `mountedRef`
  starts `true` and flips to `false` in the unmount cleanup. Every tus
  callback (onError / onProgress / onSuccess) guards `if
  (!mountedRef.current) return` so a post-unmount fire is a no-op
  instead of a setState warning. `redirectTimerRef` holds the handle
  for the success-screen `setTimeout` so the unmount cleanup can
  `clearTimeout` it before it fires.
- **`onSuccess` chains the redirect through the mount flag and a
  try/catch.** If the component is still mounted at the 1200 ms mark
  we `try { router.push("/uploads") } catch { setErrorMsg(...) ;
  setStep("failed") }`. The user always has somewhere to go — either
  /uploads on success, or the failed screen with a Back / Retry pair
  if the redirect itself rejects.
- **Unmount cleanup surfaces an explicit error.** The cleanup function
  now (1) flips `mountedRef`, (2) clears the redirect timer, (3)
  `setErrorMsg("Upload cancelled — try again")` BEFORE aborting the
  tus instance (so on a strict-mode double-mount cycle the sibling
  render reads the error from the same state slot), then (4) aborts
  the tus instance and clears `uploadRef.current`. Guarded on
  `uploadRef.current` being truthy so a clean teardown (user pressed
  the Cancel button first) doesn't leave a stale error.

The PRIMARY-path WhatsApp reminder and the explicit Cancel button are
unchanged — this spec is only about closing the races, not redesigning
the flow.

## Acceptance criteria

- `MobileFormRunner.tsx::onSubmitClick` is declared `async` and
  contains the literal `await flushSave()` before
  `formRef.current?.requestSubmit()`.
- `MobileFormRunner.tsx` no longer contains `void flushSave()`.
- `MobileUploadRunner.tsx` declares `mountedRef` and
  `redirectTimerRef` at the top of the component body.
- Each of the three tus callbacks (`onError`, `onProgress`,
  `onSuccess`) guards on `mountedRef.current` before any setState.
- The `onSuccess` redirect is stored in `redirectTimerRef` and runs
  through `try { router.push("/uploads") } catch { ... }`.
- The unmount cleanup effect:
  - flips `mountedRef.current = false`,
  - clears `redirectTimerRef.current` if set,
  - calls `setErrorMsg("Upload cancelled — try again")` when
    `uploadRef.current` is truthy,
  - then aborts the tus instance and clears the ref.
- All five spec-kit files exist under
  `specs/149-mobile-runners-async-fixes/`.
- `tests/governance/test_149_mobile_runners_async_fixes.test.mjs`
  passes with at least seven assertions covering the above.

## Non-goals

- **No schema change.** The races live entirely in the browser; the
  server-side autosave / tus endpoints are unchanged.
- **No new dependencies.** Pure closure / ref hygiene — no
  abort-controller polyfills, no react-use-async etc.
- **No flow redesign.** The Record / Pick / Preview / Upload / Done
  screens stay exactly as spec 135 ships them. The WhatsApp PRIMARY
  reminder card is untouched.
- **No reconciliation with desktop UploadProgress.** The desktop
  `<UploadProgress />` tray has its own teardown semantics (it's a
  long-lived element on /uploads, not a per-screen runner) and is
  out of scope here. Audit follow-up if needed.
- **No automated test for the timing itself.** Browser-fake-timers
  inside Playwright are flaky; the governance test pins the source
  shape (the literal `await`, the ref guards, the cleanup body) which
  is the contract that closes the race.
