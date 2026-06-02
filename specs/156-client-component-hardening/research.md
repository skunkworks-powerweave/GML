# Research 156

Five design choices, documented inline in the touched files and
expanded here.

## (1) `try/catch` around `createPortal` vs an `<ErrorBoundary>` wrapper

Two viable patterns for catching a synchronous throw from `createPortal`:

- **`try/catch` around the return statement.** Cheap, zero extra
  components, returns `null` on failure. The next render retries the
  portal — if the underlying condition has cleared (hydration completes,
  print-preview ends, the extension stops mutating `document.body`),
  the overlay shows up on the very next state update.
- **Inline `<ErrorBoundary>` wrapping the portal call.** Adds a class
  component (or React 19's error-boundary hook once stable), routes
  errors through `componentDidCatch`. Better when you want to report
  the failure to telemetry.

We chose the try/catch because:

- The QuickFind overlay is non-load-bearing chrome. A render miss is
  not worth a sentry event; the user will press Cmd+K again and the
  overlay will retry.
- An ErrorBoundary swallows ALL render errors inside its tree — too
  broad. The try/catch is scoped to the literal portal call.
- The LMS doesn't carry an ErrorBoundary helper today (spec 087
  considered one and deferred it). Introducing one for a single call
  site would be churn.

A future spec that adds a project-wide ErrorBoundary helper can
demote this try/catch back to a plain return — the contract that
matters is "QuickFind never crashes the route tree", and either
implementation honours that.

## (2) Surfacing the hls.js load failure to state, not to console

The `.catch` arm could equivalently have logged to console and stayed
silent in the UI. We surface to state for three reasons:

- **Discoverability.** Users on slow Ladakh links don't open the
  console. A message in the player viewport is the only signal they'll
  see.
- **Consistency with the existing error states.** `HlsPlayer` already
  renders an overlay `<div>` when `error` is truthy (lines 189-206).
  Routing the load failure through that same slot means the user gets
  the same visual treatment as a fatal stream error.
- **Audit-friendly.** Pre-fix a load failure was invisible to QA. The
  error message in the DOM means a Playwright run that scrolls past
  the player can scrape it and report.

The literal prefix `"Failed to load HLS player: "` is chosen so an
operator searching the page for `Failed to load HLS` lands directly on
the failure. `String(err)` appends the original error message — enough
context for triage without leaking stack traces or internals.

## (3) Why surface the tus-load-failed message at the UPLOAD-ROW level

UploadProgress can have multiple rows in flight. A single shared
banner (e.g. a sticky top alert) would be ambiguous — which row
failed? Per-row error messages are unambiguous and they survive a
later upload starting underneath without clobbering the failed row's
context.

The literal message `"Upload library unavailable. Please try the
WhatsApp PRIMARY path instead."` is chosen carefully:

- "Upload library unavailable" — honest, doesn't blame the user or the
  network.
- "Please try the WhatsApp PRIMARY path instead" — directs to the
  load-bearing fallback. WhatsApp PRIMARY is the LMS's first-class
  path (specs 036-045); the direct-browser tus upload is a secondary
  option for users with desktops, faster links, and bigger files.
  Pointing the user there is the correct escape valve.

`role="alert"` so screen-readers announce immediately. `data-testid`
so future Playwright tests can scrape. Inline `style={{ color:
"var(--rust)" }}` so the message visually matches the failed-bar
colour — the row reads as a coherent failure unit.

## (4) Debounce shape — re-check inside the timer

The audit notes said "use setTimeout + clearTimeout pattern". The
naive implementation:

```ts
const interval = setInterval(() => {
  const dh = window.outerHeight - window.innerHeight;
  if (dh > 200) {
    if (!timer) timer = setTimeout(() => emitAudit(...), 1000);
  } else if (timer) { clearTimeout(timer); timer = null; }
}, 1500);
```

…has a subtle bug. If the user opens devtools and the delta exceeds
200 px, then closes devtools BEFORE the 1s timer fires, the polling
interval clears the timer correctly (the `else if` branch). Good.

But if the user opens devtools, the size oscillates briefly (Chrome
sometimes briefly shows a different outerHeight as devtools docks)
back below 200 px and then settles above, the interval might clear
the timer at one tick and re-arm at the next. The re-armed timer
fires 1s later — correct, but the audit row will fire on a delta that
might have cleared in the meantime if the user closes devtools fast.

Re-checking the delta INSIDE the timer (the `dh2` / `dw2` reads in
the `setTimeout` body) closes this: even if the timer fires, we only
emit if the delta is STILL > 200 px at the moment of emission. Belt
and suspenders.

The other choice is the "ARM once, never reset" pattern — once the
timer is armed, do NOT cancel it on a falling delta within the
debounce window. We rejected this because it'd false-positive on a
quick window-maximize-and-restore (delta exceeds for 800 ms, drops,
timer fires 200 ms after it dropped). The re-check-inside pattern
catches that.

## (5) `closest()` vs `event.composedPath()` for the contenteditable check

Two viable patterns:

- **`target.closest('input, textarea, [contenteditable="true"]')`** —
  walks the ancestor chain of the actual target. Cheap. Misses
  shadow-DOM-encapsulated inputs but the LMS has none today and is
  unlikely to grow them (we ship server-rendered React, not web
  components).
- **`event.composedPath()`** — flattens the full path including shadow
  roots. Newer, slightly more expensive, handles every case.

We chose `closest()` because:

- Zero shadow-DOM in the LMS today.
- `closest()` is the idiom the rest of the codebase uses (HelpDot,
  HelpTip in spec 122 use it).
- Simpler to test — the regex pin in the governance test just looks
  for the literal selector.

A future spec that introduces shadow-DOM (unlikely) can upgrade to
`composedPath()` without changing the contract.

## (6) Why the governance test pins literal strings rather than behaviour

The five fixes are all "the code MUST say X" contracts. Examples:

- The portal try/catch — we can't write a Playwright test that forces
  `createPortal` to throw without monkey-patching React internals.
- The hls.js .catch — we can't easily provoke a dynamic-import
  rejection in dev without breaking the test runner's module resolver.
- The tus error message — we'd need to mock `import("tus-js-client")`
  to return null, which the LMS test gate doesn't have a hook for.
- The devtools debounce — `setTimeout` mocking in `node:test` is
  reliable but the test then proves only that the mock fires, not
  that the production heuristic works.
- The HelpPanel closest() — easy to test in JSDOM but requires
  importing the component and rendering it; the rest of the
  governance suite uses string-pin tests because they're zero-runtime.

Across the board the source-shape pin is the practical contract. A
contributor can't silently revert any of these fixes without the
governance test catching the diff.
