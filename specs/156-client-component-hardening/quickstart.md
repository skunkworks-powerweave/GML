# Quickstart 156 — Client-component hardening

Five manual smoke checks, ~2 minutes each. None requires anything
exotic beyond Chrome DevTools.

## (A) QuickFind portal try/catch

1. Boot `pnpm dev` + the docker-compose db / redis / minio stack.
2. Sign in as any role. Press Cmd+K (or Ctrl+K on Win/Linux). The
   QuickFind overlay opens.
3. Open DevTools → Console. Paste:
   ```js
   const realPortal = ReactDOM.createPortal;
   ReactDOM.createPortal = () => { throw new Error("synthetic"); };
   ```
   (Synthetic — a real hydration mismatch is hard to provoke.)
4. Press Escape, then Cmd+K again. Pre-fix this would crash the
   authenticated route tree (the error propagates up to the layout).
   With this fix the overlay simply doesn't render that tick; the
   route tree is intact.
5. Restore: `ReactDOM.createPortal = realPortal`. Cmd+K again — the
   overlay returns.

## (B) HlsPlayer import-failure surfaces an error message

6. Navigate to any video page (`/videos/<id>` for any seeded video).
   The HLS player renders.
7. Open DevTools → Network → right-click any chunk → Block request
   URL. Pick a hls.js-shaped chunk (it'll be named something like
   `hls.js-<hash>.js`).
8. Hard reload the page. Pre-fix the player would render a black
   `<video>` with no message. With this fix the error overlay shows
   "Failed to load HLS player: <error>" so the user knows to refresh.
9. Unblock the URL; reload; player works again.

## (C) UploadProgress tus-load failure points to WhatsApp

10. Open `/uploads` (any role with the upload widget mounted).
11. DevTools → Network → block any tus-js-client chunk URL.
12. Pick a file from the file picker. Pre-fix the upload row showed
    "failed" with no reason. With this fix the row carries an inline
    `role="alert"` div reading "Upload library unavailable. Please
    try the WhatsApp PRIMARY path instead."
13. Unblock; pick again; upload succeeds.

## (D) AntiDownloadGuard debounce — no false positive on resize

14. Sign in as any role. Open DevTools → Application → Storage →
    `sessionStorage` → clear all keys (in particular delete
    `antiDownloadGuard.devtoolsLogged` if present so the audit can
    fire).
15. Maximize then restore the window quickly (Windows: Win+Up, then
    Win+Down). Watch the Network panel for a POST to
    `/api/audit/client`. Pre-fix this would fire on every maximize.
    With the 1s debounce the request does NOT fire — the resize
    delta clears before the timer can.
16. Open devtools fully (F12 / Cmd+Opt+I) and leave it open for 2
    seconds. NOW the audit fires (one POST to `/api/audit/client`
    with `action: "anti_download.devtools.detected"`).
17. Close devtools; open it again same session. No new audit row —
    the session throttle still works.

## (E) HelpPanel `?` shortcut skips nested contenteditable

18. Navigate to a page with a help-bound rich-text widget (or any
    contenteditable demo — open DevTools, paste:
    `document.body.innerHTML = '<div contenteditable="true"><p>type here</p></div>'`).
19. Click into the inner `<p>`. Type `?`. Pre-fix the help panel
    would open on top of the editing surface. With the closest()
    walk the panel does NOT open; the `?` character is inserted
    into the rich-text content as expected.
20. Click outside the contenteditable. Press `?`. Help panel opens
    correctly.

## Test gate

21. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 156"
    ```
    All assertions green. Full suite still passes (1197 / 1197
    pre-spec).
