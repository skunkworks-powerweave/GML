# Tasks 149

- [x] T1 → write the governance test (red) covering:
  - `MobileFormRunner.tsx` declares `onSubmitClick` as async and
    contains the literal `await flushSave()`;
  - `MobileFormRunner.tsx` no longer contains `void flushSave()`;
  - `MobileUploadRunner.tsx` declares `mountedRef` and
    `redirectTimerRef`;
  - the three tus callbacks (onError / onProgress / onSuccess)
    each guard on `mountedRef.current`;
  - the onSuccess body stores the redirect in `redirectTimerRef`
    and wraps `router.push("/uploads")` in `try { ... } catch`;
  - the unmount cleanup body contains `mountedRef.current = false`,
    `clearTimeout(redirectTimerRef.current)`,
    `setErrorMsg("Upload cancelled — try again")`, and the abort
    branch is guarded on `uploadRef.current` being truthy.
  Run suite → red.
- [x] T2 → edit `apps/web/src/components/forms/MobileFormRunner.tsx`:
  switch `onSubmitClick` from sync to async, replace
  `void flushSave()` with `await flushSave()`. Existing
  `useCallback` deps array unchanged. Run scoped governance test
  → submit-race assertion green.
- [x] T3 → edit `apps/web/src/components/video/MobileUploadRunner.tsx`:
  add the two new refs, guard every tus callback on
  `mountedRef.current`, wrap the onSuccess redirect in a
  try/catch + stored timer handle, expand the unmount cleanup to
  flip the mount flag, clear the timer, set the error message,
  then abort. Run scoped governance test → unmount-race and
  redirect-race assertions green.
- [x] T4 → author all five spec-kit files under
  `specs/149-mobile-runners-async-fixes/`.
- [x] T5 → run the full governance suite. Confirm no regression —
  the only state-shape change is to `onSubmitClick` (now async,
  callers only need to fire-and-forget) and the additions are
  internal refs that no test reaches into.
- [ ] T6 (future, out of scope) → audit `UploadProgress.tsx` (the
  desktop tray) for the same unmount-during-upload semantics.
  The desktop tray is long-lived so the race window is smaller,
  but the same try/catch around router-aware callbacks would
  still be a worthwhile hardening.
- [ ] T7 (future, out of scope) → consider exposing a
  `useMountedRef` lib helper so the pattern is one import. Three
  uses across the LMS today is below the threshold where the
  abstraction pays for itself; revisit when the pattern hits ~6
  call sites.
- [ ] T8 (future, out of scope) → add a Playwright integration test
  that pauses a tus upload via `page.route` and navigates away
  mid-upload to verify the error message reaches the
  remount. Out of scope here because Playwright fixtures for
  tus mid-upload are heavyweight; the source-shape pin in the
  governance test is the practical contract.
