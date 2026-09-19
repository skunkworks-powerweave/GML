// Governance test for spec 156 — Client-component hardening
// (Workflow Run 14 audit-closure, MEDIUM severity).
//
// Five files under audit:
//
//   1. apps/web/src/components/quickfind/QuickFind.tsx (EDITED)
//      — createPortal call wrapped in try/catch returning null on
//        SSR hydration mismatch / document.body teardown.
//
//   2. apps/web/src/components/video/HlsPlayer.tsx (EDITED)
//      — import("hls.js") gets a .catch arm that surfaces a
//        user-visible error instead of a silent black video.
//
//   3. apps/web/src/components/video/UploadProgress.tsx (EDITED)
//      — UploadState gains errorMessage; both tus-load-failed paths
//        populate the literal "Upload library unavailable. Please
//        try the WhatsApp PRIMARY path instead." string; a
//        role="alert" div renders the message inline.
//
//   4. apps/web/src/components/AntiDownloadGuard.tsx (EDITED)
//      — devtools heuristic gets a 1-second debounce; transient
//        window-maximize / restore no longer false-positives.
//
//   5. apps/web/src/components/help/HelpPanel.tsx (EDITED)
//      — ? shortcut handler swaps the narrow tagName check for
//        target.closest('input, textarea, [contenteditable="true"]').
//
// Plus the five spec-kit files under specs/156-client-component-hardening/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const QUICKFIND_PATH = "apps/web/src/components/quickfind/QuickFind.tsx";
const HLS_PATH = "apps/web/src/components/video/HlsPlayer.tsx";
const UPLOAD_PATH = "apps/web/src/components/video/UploadProgress.tsx";
const GUARD_PATH = "apps/web/src/components/AntiDownloadGuard.tsx";
const HELP_PATH = "apps/web/src/components/help/HelpPanel.tsx";
const SPEC_DIR = "specs/156-client-component-hardening";

// ---------- Spec-kit + plan.md contract ----------

test("spec 156 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the client-component-hardening spec`,
    );
  }
});

test("spec 156 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // All five edited files must be named in plan.md so a reader auditing
  // the contract knows where the surface area actually lives.
  for (const file of [
    "QuickFind.tsx",
    "HlsPlayer.tsx",
    "UploadProgress.tsx",
    "AntiDownloadGuard.tsx",
    "HelpPanel.tsx",
  ]) {
    assert.match(
      src,
      new RegExp(file),
      `plan.md must call out the ${file} edit so the surface is discoverable`,
    );
  }
});

// ---------- (1) QuickFind portal try/catch ----------

test("spec 156 — QuickFind wraps createPortal in try/catch returning null on failure", () => {
  const src = read(QUICKFIND_PATH);
  // The portal call MUST be inside a try block — without this an SSR
  // hydration mismatch or document.body teardown crashes the whole
  // authenticated route tree.
  assert.match(
    src,
    /try\s*\{\s*return\s+createPortal\(\s*overlay\s*,\s*document\.body\s*\)\s*;?\s*\}\s*catch\s*\{\s*return\s+null\s*;?\s*\}/,
    "QuickFind must wrap `return createPortal(overlay, document.body)` in `try { ... } catch { return null }` so a portal throw never crashes the route tree",
  );
});

test("spec 156 — QuickFind carries an inline Spec 156 reference so the fix is self-documenting", () => {
  const src = read(QUICKFIND_PATH);
  // Soft contract — but every previous LMS race / hardening fix has
  // carried an inline spec reference so a future contributor reading the
  // file knows to consult the spec before reverting.
  assert.match(
    src,
    /Spec 156/,
    "QuickFind must carry an inline `Spec 156` comment so the try/catch wrapper is self-documenting",
  );
});

// ---------- (2) HlsPlayer dynamic-import .catch ----------

test("spec 156 — HlsPlayer chains a .catch onto the import('hls.js') promise", () => {
  const src = read(HLS_PATH);
  // The import chain MUST include a `.catch` arm — without this a
  // bundle-load failure (corrupted chunk, offline cache) renders a
  // silent black <video> element. The error param + setError() call
  // surface the failure to the existing error-overlay slot.
  assert.match(
    src,
    /import\(\s*"hls\.js"\s*\)[\s\S]{0,1500}\.catch\(\s*\(\s*err\s*\)\s*=>/,
    "HlsPlayer must chain a .catch((err) => ...) onto the import('hls.js') promise so bundle-load failures surface a user-visible error",
  );
  // The catch body MUST call setError with the literal prefix "Failed
  // to load HLS player: " — the prefix is what an operator searches the
  // page for when triaging a load failure.
  assert.match(
    src,
    /setError\(\s*"Failed to load HLS player: "\s*\+\s*String\(\s*err\s*\)\s*\)/,
    'HlsPlayer .catch arm must call setError("Failed to load HLS player: " + String(err)) so the failure has both a discoverable prefix and the original error detail',
  );
  // The setError call must be GUARDED on !cancelled so the unmount
  // cleanup (which flips `cancelled = true`) doesn't fire a setState on
  // an unmounted component.
  assert.match(
    src,
    /\.catch\(\s*\(\s*err\s*\)\s*=>\s*\{\s*if\s*\(\s*!\s*cancelled\s*\)\s*setError/,
    "HlsPlayer .catch arm must guard the setError call on !cancelled so a post-unmount rejection doesn't setState on a torn-down component",
  );
});

test("spec 156 — HlsPlayer carries an inline Spec 156 reference", () => {
  const src = read(HLS_PATH);
  assert.match(
    src,
    /Spec 156/,
    "HlsPlayer must carry an inline `Spec 156` comment so the .catch arm is self-documenting",
  );
});

// ---------- (3) UploadProgress tus error message ----------

test("spec 156 — UploadProgress declares errorMessage on UploadState", () => {
  const src = read(UPLOAD_PATH);
  // The optional field MUST be declared on UploadState — without it the
  // updateUpload patch ({ status: 'failed', errorMessage: ... }) would
  // be a type error.
  assert.match(
    src,
    /errorMessage\?\s*:\s*string/,
    "UploadProgress UploadState must declare `errorMessage?: string` so the failure-with-reason patch typechecks",
  );
});

test("spec 156 — the tus-load-failed path still tells the user to fall back to WhatsApp", () => {
  // INVERTED. This required the literal WhatsApp-fallback string to appear at
  // least TWICE inside UploadProgress.tsx -- once for the `else` branch when
  // the dynamic import resolved to nothing, once for the outer `catch`.
  //
  // Counting occurrences was a proxy for "every failure path says something
  // actionable", and it was the right instinct at the time: the component owned
  // its own copy of the tus wiring, so the two arms could and did drift. The
  // duplication is gone. UploadProgress and MobileUploadRunner now share one
  // implementation in @/lib/video/tus-upload -- they previously had separate
  // copies with separately-wrong chunk sizes -- and that module has a single
  // try/catch around a single import, so there is exactly one place for the
  // message to live and nothing left to keep in sync.
  //
  // Asserting ">= 2" against the new code would force a contributor to
  // duplicate a string to satisfy a test, which is the opposite of what the
  // original was protecting. So this pins the message where it now is, and
  // pins that UploadProgress surfaces it rather than swallowing it.
  const shared = read("apps/web/src/lib/video/tus-upload.ts");
  assert.match(
    shared,
    /"Upload library unavailable\. Please send the video over WhatsApp instead\."/,
    "the tus-import failure must still name WhatsApp as the fallback -- on a corrupted " +
      "bundle or an offline-cached page a field mentor needs to be told what to do next, " +
      "not shown a row that silently failed",
  );
  // It must be routed out through onError, not logged and dropped. That is the
  // property the original's occurrence-count was really enforcing.
  assert.match(
    shared,
    /catch\s*\{[\s\S]{0,400}?opts\.onError\("Upload library unavailable/,
    "the failed import must call back through onError so the caller can render it",
  );
  const src = read(UPLOAD_PATH);
  // The onError handler is now a BLOCK body rather than a single expression --
  // it also calls router.refresh(), because the tray used to leave the uploads
  // table beneath it stale after a finished or failed transfer. The old regex
  // pinned the arrow-expression shape, which is syntax rather than behaviour,
  // so adding a second statement broke it while improving the component.
  //
  // What is pinned now is the property the original was after: the shared
  // module's message lands on the failed row rather than being swallowed.
  assert.match(
    src,
    /onError:\s*\(message\)\s*=>[\s\S]{0,200}?errorMessage:\s*message/,
    "UploadProgress must put the shared module's message onto the failed row -- the " +
      "assertions below then pin that the row actually renders it",
  );
});

test("spec 156 — UploadProgress renders the error message inline in a role='alert' div", () => {
  const src = read(UPLOAD_PATH);
  // The message MUST be rendered to the DOM — otherwise the spec's
  // promise of a user-visible failure mode is unfulfilled.
  assert.match(
    src,
    /role="alert"/,
    'UploadProgress must render the error message inside a role="alert" element so screen-readers announce it',
  );
  // The render must be gated on `u.status === "failed" && u.errorMessage`
  // — without the guard a successful upload would render an empty alert
  // div, and a row without a message (legacy uploads from before this
  // spec) would render a broken empty alert.
  assert.match(
    src,
    /u\.status\s*===\s*"failed"\s*&&\s*u\.errorMessage/,
    'UploadProgress must gate the alert render on `u.status === "failed" && u.errorMessage` so only failed rows with an actionable reason show the message',
  );
  // The data-testid handle so future Playwright tests can scrape the
  // message without fragile CSS selectors.
  assert.match(
    src,
    /data-testid="upload-error-message"/,
    'UploadProgress must carry `data-testid="upload-error-message"` on the alert div so integration tests can scrape it',
  );
});

// ---------- (4) AntiDownloadGuard 1-second debounce ----------

test("spec 156 — AntiDownloadGuard declares the pendingDevtoolsTimer cancellation token", () => {
  const src = read(GUARD_PATH);
  // The let-binding MUST be inside the useEffect (captured by the
  // closure, not at module scope) so the polling tick + cleanup share
  // the same handle and a remount doesn't leak across instances.
  assert.match(
    src,
    /let\s+pendingDevtoolsTimer\s*:\s*ReturnType<typeof\s+setTimeout>\s*\|\s*null\s*=\s*null/,
    "AntiDownloadGuard must declare `let pendingDevtoolsTimer: ReturnType<typeof setTimeout> | null = null` inside the useEffect so the polling tick + cleanup share the same cancellation token",
  );
});

test("spec 156 — AntiDownloadGuard arms a 1000ms setTimeout on the devtools-delta-detected branch", () => {
  const src = read(GUARD_PATH);
  // The setTimeout MUST be 1000 ms — the spec literally requires "1
  // second" debounce. Anything shorter (e.g. 500) would still false-
  // positive on slow OS resize animations; anything longer would miss
  // a real devtools-open that the user quickly closed.
  assert.match(
    src,
    /pendingDevtoolsTimer\s*=\s*setTimeout\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,2000}\}\s*,\s*1000\s*\)/,
    "AntiDownloadGuard must arm a `setTimeout(..., 1000)` and store the handle in pendingDevtoolsTimer so the unmount/clear-on-delta-drop branches can cancel it",
  );
  // The timer body MUST re-check the size delta — if the user closed
  // devtools during the 1s window the delta has dropped and we must
  // NOT emit the audit (false-positive).
  assert.match(
    src,
    /setTimeout\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,500}const\s+dh2\s*=\s*window\.outerHeight/,
    "AntiDownloadGuard debounce timer must re-check `dh2 = window.outerHeight - window.innerHeight` inside the timer body so a closed-devtools-during-debounce doesn't false-positive",
  );
});

test("spec 156 — AntiDownloadGuard clears the pending timer on delta-clears AND on unmount", () => {
  const src = read(GUARD_PATH);
  // The delta-cleared branch (the `else if` inside the polling tick)
  // MUST clearTimeout the pending timer — without this a transient
  // window-maximize-then-restore would fire the audit 1s after the
  // window already returned to normal.
  assert.match(
    src,
    /else if\s*\(\s*pendingDevtoolsTimer\s*!=\s*null\s*\)\s*\{[\s\S]{0,500}clearTimeout\(\s*pendingDevtoolsTimer\s*\)/,
    "AntiDownloadGuard polling tick must clearTimeout(pendingDevtoolsTimer) when the size delta has cleared so transient resize animations don't fire a delayed audit",
  );
  // The useEffect cleanup MUST also clear the pending timer — a fast
  // unmount with a timer in flight would otherwise fire the audit on
  // an unmounted component and contaminate the cross-page audit log.
  assert.match(
    src,
    /return\s*\(\s*\)\s*=>\s*\{[\s\S]{0,1000}if\s*\(\s*pendingDevtoolsTimer\s*!=\s*null\s*\)\s*\{[\s\S]{0,200}clearTimeout\(\s*pendingDevtoolsTimer\s*\)/,
    "AntiDownloadGuard unmount cleanup must clearTimeout(pendingDevtoolsTimer) so a fast unmount doesn't leave a timer to fire on a torn-down component",
  );
});

test("spec 156 — AntiDownloadGuard carries an inline Spec 156 reference", () => {
  const src = read(GUARD_PATH);
  assert.match(
    src,
    /Spec 156/,
    "AntiDownloadGuard must carry an inline `Spec 156` comment so the debounce is self-documenting",
  );
});

// ---------- (5) HelpPanel closest() DOM-tree walk ----------

test("spec 156 — HelpPanel uses target.closest() to check for nested input/textarea/contenteditable", () => {
  const src = read(HELP_PATH);
  // The literal closest() selector — pinning so a future contributor
  // can't silently drop the [contenteditable="true"] entry (which is
  // the load-bearing addition; the LMS already covered INPUT /
  // TEXTAREA pre-fix).
  assert.match(
    src,
    /target\?\.closest\(\s*['"]input,\s*textarea,\s*\[contenteditable="true"\]['"]\s*\)/,
    'HelpPanel must use `target?.closest(\'input, textarea, [contenteditable="true"]\')` to walk the DOM tree so nested contenteditable widgets correctly suppress the ? shortcut',
  );
  // The closest() result MUST short-circuit the handler with `return`
  // — otherwise the ? key still preventDefault()s the user's input.
  assert.match(
    src,
    /if\s*\(\s*target\?\.closest\([^)]+\)\s*\)\s*return/,
    "HelpPanel closest() check must `return` when matched so the ? key event passes through to the focused input",
  );
});

test("spec 156 — HelpPanel no longer relies solely on tag === 'INPUT' for the input check", () => {
  const src = read(HELP_PATH);
  // The pre-fix shape was `if (tag === "INPUT" || tag === "TEXTAREA" ||
  // target?.isContentEditable) return;`. We pin its ABSENCE so a future
  // contributor reading the file doesn't reintroduce the narrow check
  // alongside the closest() walk.
  //
  // Note: the literal string "INPUT" CAN appear inside a code-comment
  // as documentation reference to the pre-fix shape — we only forbid
  // the `tag === "INPUT"` check pattern outside comments.
  const lines = src.split(/\r?\n/);
  const offendingLine = lines.find((line) => {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return false;
    return /tag\s*===\s*"INPUT"/.test(line) || /tag\s*===\s*"TEXTAREA"/.test(line);
  });
  assert.equal(
    offendingLine,
    undefined,
    'HelpPanel must not contain `tag === "INPUT"` / `tag === "TEXTAREA"` as live code — the spec 156 fix replaced it with closest() (offending line: ' +
      (offendingLine ?? "<none>") +
      ")",
  );
});

test("spec 156 — HelpPanel carries an inline Spec 156 reference", () => {
  const src = read(HELP_PATH);
  assert.match(
    src,
    /Spec 156/,
    "HelpPanel must carry an inline `Spec 156` comment so the closest() walk is self-documenting",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 156 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [QUICKFIND_PATH, HLS_PATH, UPLOAD_PATH, GUARD_PATH, HELP_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 156 — no new dependencies were introduced (no error-boundary library, no debounce util)", () => {
  // The fix is pure DOM / closure / render-shape changes. No
  // ErrorBoundary library, no lodash.debounce, no use-debounce should
  // have crept into apps/web/package.json as a side-effect.
  const pkg = read("apps/web/package.json");
  assert.ok(
    !/"react-error-boundary"/.test(pkg),
    "apps/web must not depend on react-error-boundary — the QuickFind fix is a scoped try/catch instead",
  );
  assert.ok(
    !/"lodash\.debounce"/.test(pkg),
    "apps/web must not depend on lodash.debounce — the AntiDownloadGuard fix is a hand-rolled setTimeout pattern",
  );
  assert.ok(
    !/"use-debounce"/.test(pkg),
    "apps/web must not depend on use-debounce — same reason",
  );
});
