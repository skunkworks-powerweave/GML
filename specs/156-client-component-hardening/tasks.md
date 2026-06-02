# Tasks 156

- [x] T1 → write the governance test (red) covering:
  - `QuickFind.tsx` wraps `createPortal(overlay, document.body)` in a
    `try { ... } catch { return null }`;
  - `HlsPlayer.tsx` chains a `.catch((err) =>` arm onto the
    `import("hls.js")` promise and the arm calls
    `setError("Failed to load HLS player: " + String(err))`;
  - `UploadProgress.tsx` declares `errorMessage?: string` on
    `UploadState`, both fallback paths populate the literal message
    `"Upload library unavailable. Please try the WhatsApp PRIMARY path instead."`, and the rendered list shows a `role="alert"` div
    bound to that message;
  - `AntiDownloadGuard.tsx` declares `let pendingDevtoolsTimer`,
    arms a `setTimeout(..., 1000)`, the delta-cleared branch +
    cleanup both `clearTimeout` it;
  - `HelpPanel.tsx` contains the literal
    `closest('input, textarea, [contenteditable="true"]')` check.
  Run suite → red.
- [x] T2 → edit `apps/web/src/components/quickfind/QuickFind.tsx`:
  wrap the `createPortal` return call in a try/catch returning
  null on failure. Inline Spec 156 comment.
  Run scoped governance test → portal-wrapper assertion green.
- [x] T3 → edit `apps/web/src/components/video/HlsPlayer.tsx`:
  chain a `.catch` arm onto the dynamic import. Inline Spec 156
  comment.
  Run scoped governance test → hls-load assertion green.
- [x] T4 → edit `apps/web/src/components/video/UploadProgress.tsx`:
  add `errorMessage` to UploadState, populate both fallback paths,
  render the alert div. Inline Spec 156 comment.
  Run scoped governance test → tus-fallback assertions green.
- [x] T5 → edit `apps/web/src/components/AntiDownloadGuard.tsx`:
  add the 1-second debounce. Re-check the delta inside the timer.
  Clear on cleanup. Inline Spec 156 comment.
  Run scoped governance test → debounce assertions green.
- [x] T6 → edit `apps/web/src/components/help/HelpPanel.tsx`:
  swap the narrow input check for `closest()`. Inline Spec 156
  comment.
  Run scoped governance test → closest assertion green.
- [x] T7 → author all five spec-kit files under
  `specs/156-client-component-hardening/`.
- [x] T8 → run the full governance suite. Confirm no regression —
  all five edits are internal to client components; no test
  reaches into the modified lines.
- [ ] T9 (future, out of scope) → introduce a project-wide
  `<ErrorBoundary>` helper and consider rewriting the QuickFind
  try/catch on top of it. Three viable call sites today (QuickFind,
  HelpPanel, AntiDownloadGuard portal) — below the threshold where
  the abstraction pays for itself; revisit when the pattern hits
  ~6 sites.
- [ ] T10 (future, out of scope) → fix the build-pipeline flakiness
  that allows hls.js / tus-js-client dynamic chunks to fail loading.
  This spec only SURFACES the failure; the root cause (probably a
  CDN cache key issue) is infra-team work.
- [ ] T11 (future, out of scope) → add a Playwright integration test
  that monkey-patches `createPortal` to throw and verifies the
  authenticated route tree stays mounted. Out of scope here because
  the Playwright fixture for portal-monkey-patching is heavy; the
  source-shape pin in the governance test is the practical contract.
