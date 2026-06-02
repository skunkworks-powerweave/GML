# Quickstart 135 — Mobile upload runner

## Try it on desktop

```bash
# 1. Run the app
pnpm --filter @gml/web dev

# 2. Open Chrome DevTools and toggle device toolbar (Cmd-Shift-M).
# 3. Pick "iPhone 14 Pro" or any mobile preset.
# 4. Hard-reload the page to clear the `gml-device` cookie. On reload
#    Next.js will sniff the user-agent and set `gml-device=mobile`.
# 5. Navigate to /uploads. You should see the full-screen runner
#    instead of the three-card explainer.
```

## Try it on a real phone

```bash
# 1. Run the app on your dev machine.
# 2. From your phone (same wifi), browse to http://<dev-host>:3000/uploads.
# 3. Sign in.
# 4. You should see two big "Record now" + "Pick from gallery" tiles.
# 5. Tap Record now — your phone opens the camera. Record, hit done.
# 6. Preview screen appears with first-frame thumbnail. Type a caption.
# 7. Hit Start upload. Watch progress.
# 8. On done, the app redirects you to /uploads (recent-uploads table).
```

## Run the governance test

```bash
node --test tests/governance/test_135_mobile_upload_runner.test.mjs
```

## What if the user is on an iPhone with a weak signal?

- The "On a slow 2G/3G link?" reminder on the choose screen renders
  an `Open WhatsApp` button → opens `wa.me/<programme phone>`.
- Mid-upload, the same fallback card sits beneath the progress bar
  so the user can bail to WhatsApp without losing the local file
  (it stays in the OS file picker history).
- Cancel mid-upload → tus instance is `.abort()`-ed and the user is
  returned to the choose screen with the file cleared.

## What if the codec can't be decoded for preview?

The Preview screen renders "Preview unavailable (codec not
browser-decodable)" but the upload still works. The file is still in
the picker buffer; the user just doesn't get a thumbnail.

## What if the user navigates away mid-upload?

A `useEffect` cleanup function calls `uploadRef.current?.abort()` so
we don't leak a hanging XHR. The partial chunks tusd has already
received are kept on disk per the tusd `--cleanup-on-startup`
contract (spec 038); resumability is preserved if the user comes
back within the tusd retention window.
