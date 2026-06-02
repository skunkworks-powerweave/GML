# Quickstart 132 — Videos player controls + upload modal

Manual smoke (3 minutes):

1. Boot the stack: `pnpm dev` (web) + `pnpm --filter @gml/worker dev`
   (transcode worker) + the docker-compose db / redis / minio.
2. Sign in as a `mentor`. Open a video that has reached
   `status='ready'` (the seed dataset ships a few; spec 086 seeds
   them via the demo fixture).
3. Below the player you now see a row labelled "Speed" with four
   buttons (1× / 1.25× / 1.5× / 2×). Click 1.5×. The video continues
   from the current timestamp at 1.5× pace; the button takes the
   black `var(--ink)` highlight. Click 1× to return.
4. To the right of the speed row, find the "Quality" dropdown. It
   has Auto / 480p / 720p (disabled). Hover the 720p row — the
   browser tooltip reads "720p disabled per programme settings".
   Switch between Auto and 480p; playback continues uninterrupted
   (spec 041 ships a single rendition so the bytes on the wire are
   identical, but hls.js logs the level change).
5. Navigate back to `/videos`. The Upload button in the header now
   opens a modal instead of routing to /uploads. The modal shows
   two sections:
   - **Send via WhatsApp** (Recommended) — programme phone number,
     Copy phone number button, and the three caption codes.
   - **Or upload from this browser** (Admin / mentor) — the existing
     UploadProgress widget with the resumable tus picker.
6. Press `Escape` — the modal closes. Click Upload again, then
   click the dimmed background outside the panel — the modal
   closes. Click Upload again, click the WhatsApp Copy button —
   the phone number lands on the clipboard (verify via Cmd-V into
   an empty input).
7. Click "Upload video" inside the modal, pick a small .mp4 file.
   The UploadProgress bar fills, the tus upload reports success,
   and the modal auto-closes. Refresh `/videos` — the new
   submission row is visible at the top with `status='queued'`.

Sign in as a `teacher` and repeat — the modal works the same way.
The WhatsApp ingest log button (spec 126) is gated to programme
admin / super admin, so teachers see only the Upload button.

Sign in as a `super_admin` and replay step 5 — the modal still
shows both paths. Direct browser upload is the operator's escape
hatch when WhatsApp is down.
