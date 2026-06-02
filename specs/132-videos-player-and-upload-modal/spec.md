# Spec 132 — Videos player controls + upload modal (Workflow Run 11 frontend parity)

## Why

The JSX prototype at `LMS GML Frontend/videos.jsx` ships two affordances
that the live Next.js port at `apps/web/src/components/video/HlsPlayer.tsx`
and `apps/web/src/app/(authenticated)/videos/page.tsx` left as stubs:

1. **Player speed + quality controls** (videos.jsx lines 169-191) — a
   row of speed chips (0.75× / 1× / 1.5×) and a 480p quality pill
   beneath the video. The live HlsPlayer renders the watermark and
   handles the HLS handshake but has no UI for either control. Mentors
   reviewing 38-minute lessons reasonably want to skim at 1.5×; the
   prototype JSON shows this is the most-asked feature in field tests.

2. **Upload button + modal** (videos.jsx line 32) — the library header
   renders an Upload button. The current port at
   `apps/web/src/app/(authenticated)/videos/page.tsx:89` routes the
   button at `/uploads`, which is the teacher's own My-Uploads tray.
   That works for an already-known user, but does nothing to surface
   the PRIMARY WhatsApp ingest path. A first-time teacher who clicks
   "Upload" should see the WhatsApp number + caption codes first,
   with the direct-browser path as a fallback for admin / mentor use.

Spec 132 closes both gaps without adding schema, dependencies, or new
API surface.

## What we ship

### 1. `apps/web/src/components/video/HlsPlayer.tsx` (EDITED)

Add a `<div className="player-controls">` row below the video element:

- **Speed buttons** — 1× / 1.25× / 1.5× / 2× toggle row. Active speed
  highlighted with the same `var(--ink)` background pattern the rest
  of the chrome uses. Click sets `video.playbackRate` directly; works
  on both the hls.js code path and Safari native HLS without
  re-fetching segments.
- **Quality select** — `<select>` with Auto / 480p / 720p options.
  720p is rendered `disabled` with a `title` tooltip reading
  "720p disabled per programme settings" — this honors spec 041
  which dropped the 720p rendition ladder. Auto sets
  `hls.currentLevel = -1`, 480p sets `hls.currentLevel = 0`.
- Both controls are inside the existing `"use client"` component so
  the rest of the player surface stays unchanged.
- `SPEED_PRESETS` lifted to a module-level const so the test can
  assert the four expected speeds without parsing JSX trees.

### 2. `apps/web/src/components/video/UploadModal.tsx` (CREATED)

New client component. Exports `UploadModal({ whatsappPhone })`.

- Renders the Upload trigger button (matches the existing
  `btn btn-primary` styling so the library header looks identical).
- On click, mounts a fixed-position dialog with `role="dialog"` +
  `aria-modal="true"`.
- Two sections inside the dialog:
  1. **WhatsApp path (Recommended chip)** — programme phone number
     displayed with a "Copy phone number" button (uses
     `navigator.clipboard.writeText`), plus the three caption codes
     (`OBS-<code>`, `TB-<uuid>`, `MM-<uuid>`) with one-line
     explanations of which entity each attaches to.
  2. **Browser path (Admin / mentor chip)** — embeds the existing
     `UploadProgress` client component with `contextType="generic"`.
     The `onComplete` callback closes the modal so the user sees
     the new row land in the grid.
- Close semantics match the rest of the chrome:
  - `Escape` key closes (global keydown listener mounted only while
    open).
  - Click on the backdrop closes (the inner panel calls
    `stopPropagation` to keep clicks inside).
  - On `UploadProgress` `onComplete`, closes.

### 3. `apps/web/src/app/(authenticated)/videos/page.tsx` (EDITED)

Replace the `<Link href="/uploads">` Upload button with
`<UploadModal whatsappPhone={...} />`. The number is read from
`process.env.GML_WHATSAPP_NUMBER` with a fallback to
`process.env.WHATSAPP_PHONE_NUMBER_ID` (already set by the spec 043
webhook deployment) so no new env contract is required.

## Acceptance criteria

- `HlsPlayer.tsx` exports a `SPEED_PRESETS` const containing
  `[1, 1.25, 1.5, 2]`.
- `HlsPlayer.tsx` renders a `className="player-controls"` div
  containing four speed buttons and a quality `<select>`.
- The quality select has options for `auto`, `480p`, and a
  `disabled` `720p` option.
- `UploadModal.tsx` exists, declares `"use client"`, accepts a
  `whatsappPhone` prop, and exports `UploadModal`.
- `UploadModal.tsx` mounts an `Escape`-handling effect and a
  backdrop click handler that both call `setOpen(false)`.
- `UploadModal.tsx` embeds `UploadProgress` with
  `contextType="generic"`.
- `videos/page.tsx` imports `UploadModal` and renders
  `<UploadModal whatsappPhone={...} />` in the header (no more
  `<Link href="/uploads">` for the Upload affordance).
- All five spec-kit files exist under
  `specs/132-videos-player-and-upload-modal/`.
- `tests/governance/test_132_videos_player_and_upload_modal.test.mjs`
  passes with at least seven assertions covering the above.

## Non-goals

- **No new env vars.** The WhatsApp number reuses the existing
  `WHATSAPP_PHONE_NUMBER_ID` contract from spec 043 (with the
  optional `GML_WHATSAPP_NUMBER` for human-formatted display).
- **No schema changes.** Speed + quality are pure UI state; the
  upload modal reuses the existing `UploadProgress` + tus-js-client
  pipeline.
- **No new dependencies.** hls.js, tus-js-client, and the chrome
  primitives are already on the dep graph.
- **No 720p re-enable.** Spec 041 dropped the ladder for bandwidth
  reasons; the dropdown option is `disabled` here as a visible
  reminder that flipping it requires a worker pipeline change too.
- **No keyboard shortcuts for speed (J/K/L).** Adding them would
  collide with the spec 121 cmdK Quick Find global key map; punt to
  a future spec if mentors ask for it.
- **No mobile-specific upload flow.** The mobile-runners.jsx
  pattern lands in Run 12 (spec 133+).
