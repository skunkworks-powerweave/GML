# Research 149

Four design choices, documented inline in the touched files and
expanded here.

## (1) Why `await flushSave()` and not a chained promise

The mobile runner could equivalently have written:

```ts
flushSave().then(() => formRef.current?.requestSubmit());
```

We chose the `await` form for three reasons:

- **Symmetry with desktop.** `FormRenderer.tsx::onSubmitForm` (spec
  072, line 534) writes `if (autosaveEnabled) await flushSave()`. A
  reader auditing the two runners side-by-side reads the same shape.
  A `.then` chain would invite divergence — the test gate would still
  pass but a future contributor refactoring one would forget the
  other.
- **Try/catch composition.** `flushSave` is implemented with a
  try/catch INSIDE the function (it never throws — failures land in
  `setSaveState("error")`). But if a future contributor wires a
  network-level rejection back out, an awaited call composes cleanly
  with a surrounding try/catch around the whole submit; a `.then`
  chain would need a `.catch` that nobody adds at first.
- **Single useCallback closure.** Awaiting keeps the dependency array
  unchanged; `.then` would require a second nested callback whose
  identity would be hidden from the deps linter. The lint rule would
  still pass but the dependency tracking would silently degrade.

The `submitting` state acts as a re-entry guard: a rapid double-tap on
the Submit button while `flushSave` is in flight returns at line 582
(`if (submitting) return`). The submit button is also `disabled={submitting}`
so the second tap shouldn't fire in the first place; the guard is a
belt-and-suspenders fallback for keyboard-Enter + tap collisions in
the brief enabled window.

## (2) `mountedRef` vs `AbortController`

Two viable patterns for cancelling in-flight work on unmount:

- **`mountedRef.current` + guards** — every async callback checks the
  ref before calling setState. Cheap (one boolean), works for any
  callback shape including third-party library callbacks (tus's
  `onProgress` etc.).
- **`AbortController`** — wire `controller.signal` into the work; the
  library aborts cleanly. Better when the underlying library accepts
  a signal.

`tus-js-client` doesn't accept an AbortSignal — it has its own
`.abort()` instance method. That collapses to "we hold a ref to the
upload, the unmount cleanup calls `.abort()` on it". The mountedRef
is the cleanest way to gate the THREE callbacks (`onError`,
`onProgress`, `onSuccess`) that fire AFTER abort because abort is
async inside tus. Without the ref guard the callbacks fire on the
unmounted React tree and React logs a warning.

A future refactor where tus exposes a signal could collapse both
refs into a single `controller`. For now the two-ref pattern is the
minimum surgical fix.

## (3) Why surface the unmount-error before aborting

Order matters in the cleanup body:

```ts
return () => {
  mountedRef.current = false;   // 1. gate all setState branches off
  clearTimeout(redirectTimer);  // 2. cancel pending redirect
  if (uploadRef.current) {
    setErrorMsg("Upload cancelled — try again");  // 3. surface error
    uploadRef.current.abort();                    // 4. tear down tus
    uploadRef.current = null;                     // 5. drop the ref
  }
};
```

Step 3 happens BEFORE step 4 because in React's StrictMode the cleanup
runs and then the same `useEffect` re-runs immediately. The second
mount reads the `errorMsg` state slot set in step 3. If we aborted
first and the abort's onError fired synchronously, the `!mountedRef`
guard would skip the setErrorMsg branch (correct — we don't want to
double-set), and step 3 would never execute. By setting the error
BEFORE the abort we ensure the message reaches the state slot before
any callback can race the cleanup.

Guard: `if (uploadRef.current)` — a clean teardown (user pressed the
explicit Cancel button, which calls `uploadRef.current = null` itself,
then the component unmounts) skips the error so the user doesn't see
a confusing "cancelled" message on a flow they explicitly cancelled.

## (4) Why `try/catch` around `router.push` and not `router.replace`

`router.push` can reject if the router is torn down (in App Router this
manifests as a thrown promise from internal navigation). The race
window is small — between the 1200 ms timer firing and the user's
next interaction — but real on a phone where backgrounding the tab
mid-success can tear the router down.

`router.replace("/uploads")` would have the same teardown issue.
`window.location.assign("/uploads")` would bypass the App Router
entirely but lose all the prefetched route segments and feel like a
full reload — a regression for users on the 2G links this whole
spec is optimising for.

The try/catch around `router.push` is the minimum-surface escape
valve: if push throws, we set an explicit error and step back to the
"failed" screen, which renders a Back + Retry pair. The user is
never stuck.

## (5) Why no automated test for the timing itself

Browser-fake-timers in Playwright (`page.clock.fastForward`) are
unreliable for promises composed with `setTimeout` — the test would
be flaky in CI. Instead the governance test pins the SOURCE shape:

- the literal `await flushSave()` token order,
- the presence of `mountedRef.current` in every tus callback,
- the cleanup body's setErrorMsg + abort + null sequence.

This is the "encode the contract in the test" pattern used throughout
the LMS test gate — the test verifies that the code says the right
thing, not that the runtime behaves a certain way under simulated
clocks. Behaviour is validated by the manual quickstart on a real
slow link.
