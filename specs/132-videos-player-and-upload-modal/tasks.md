# Tasks 132

- [x] T1 → write governance test (red) covering: SPEED_PRESETS const,
  player-controls JSX block, speed buttons & quality select, 720p
  disabled option + tooltip, UploadModal client component existence,
  Esc close, backdrop close, UploadProgress embed with
  contextType="generic", videos/page.tsx imports UploadModal and
  removes the `<Link href="/uploads">` Upload trigger. Run suite → red.
- [x] T2 → edit `apps/web/src/components/video/HlsPlayer.tsx`: lift
  SPEED_PRESETS to a module const, store `playbackRate` + `quality`
  in useState, render `.player-controls` div below the existing
  video shell, wire `applyPlaybackRate(rate)` and `applyQuality(next)`
  helpers, keep an `hlsRef` so the quality switch can flip
  `currentLevel` without re-attaching MediaSource.
- [x] T3 → create `apps/web/src/components/video/UploadModal.tsx`:
  `"use client"`, exports `UploadModal({ whatsappPhone })`, mounts
  trigger button + dialog with Esc handler + backdrop handler,
  renders WhatsApp section (Copy button) and direct-upload section
  (embeds UploadProgress with `contextType="generic"`).
- [x] T4 → edit `apps/web/src/app/(authenticated)/videos/page.tsx`:
  import `UploadModal`, replace `<Link href="/uploads">` with
  `<UploadModal whatsappPhone={env-or-null} />` using
  GML_WHATSAPP_NUMBER ?? WHATSAPP_PHONE_NUMBER_ID ?? null, comment the
  deviation from spec 044.
- [x] T5 → author all five spec-kit files under
  `specs/132-videos-player-and-upload-modal/`.
- [x] T6 → run the scoped governance suite (`pnpm test -- --grep
  "spec 132"`) → green. Run the full suite to confirm no
  regression in the broader chrome.
- [ ] T7 (future) → wire keyboard shortcuts for speed (J/K/L) once the
  cmdK Quick Find shortcut grammar in spec 121 has room. Out of
  scope for this run.
- [ ] T8 (future) → expose a per-cycle Upload Modal entry point on
  cycle detail pages with `contextType="observation_cycle"` so the
  modal attaches uploads to a known entity. Out of scope here
  (videos library is generic by design).
