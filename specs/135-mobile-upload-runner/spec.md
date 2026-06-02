# Spec 135 — Mobile upload runner (Workflow Run 12 final frontend-parity)

## Why

The JSX prototype at `LMS GML Frontend/mobile-runners.jsx::MobUpload`
(lines 181-294) ships a full-screen mobile upload flow that the live
`/uploads` page at `apps/web/src/app/(authenticated)/uploads/page.tsx`
does not render on phone viewports. Today both shells (mobile + desktop)
get the same three-column explainer grid + inline `UploadProgress` tray
(spec 045). On a 360-wide screen the cards collapse below the fold, the
upload tray's hidden file input opens a generic file picker (so a
teacher gets a document picker, not the camera), and the WhatsApp
fallback CTA is buried six scrolls deep.

The prototype solves all three problems by:

1. Replacing the three-card row with two **enormous tiles** — "Record
   now" (opens the camera via `capture="environment"` on the hidden
   file input) and "Pick from gallery" (regular file picker). Both
   tiles are ≥ 56px tall so they meet Apple HIG / Material Design
   touch-target rules.
2. After a file is chosen, a **Preview** screen shows the first frame
   of the video (extracted client-side via a hidden canvas) so the
   teacher can confirm they grabbed the right take, plus a caption
   textarea that hints at the OBS-/TB-/MM- code conventions.
3. The **Upload** screen is a full-bleed progress bar with a watermark
   instruction card and a sticky WhatsApp fallback link
   (`wa.me/<phone>`) so a teacher on a 2G connection can bail to the
   PRIMARY ingest path without losing the file.
4. On success, redirects to `/uploads` so the teacher lands on their
   My Uploads grid and sees the new row.

Run 12 closes the JSX-prototype <-> production gap that's been open
since the mobile shell shipped in spec 023.

## What we ship

### 1. `apps/web/src/components/video/MobileUploadRunner.tsx` (CREATED)

New `"use client"` component. Five-state state machine:
`choose -> preview -> uploading -> done | failed`.

- **Choose** — renders two big tiles (Record / Pick). Both delegate to
  hidden `<input type="file" accept="video/*">` elements that differ
  only in the `capture="environment"` attribute. Below the tiles, a
  WhatsApp PRIMARY-path reminder card with an "Open WhatsApp" link
  (lichen-soft so it reads as "use this if your link is slow").
- **Preview** — thumbnail (first decoded frame) + filename + size +
  caption textarea (defaults to `OBS-<activeCycleCode>` when supplied).
  Back / Start upload buttons (48px tall, ink primary).
- **Uploading** — full-width progress bar bound to the tus
  `onProgress` callback, percentage label, watermark instructions
  card, sticky WhatsApp fallback card with the `wa.me/<phone>` link
  duplicated here so a frustrated teacher mid-upload can copy the
  href. Cancel button bound to `tus.abort()`.
- **Done** — large lichen check, "Uploaded" + "Transcoding now"
  message, auto-redirects to `/uploads` after a 1.2s beat.
- **Failed** — error message in rust, Back + Retry CTAs.

All paddings respect `env(safe-area-inset-*)` so the sticky CTA
doesn't hide under the iOS home indicator or get clipped by an
Android punch-hole.

Module-level `MOBILE_TILES` const lists the two tiles so the
governance test can pin the contract without parsing JSX.

### 2. `apps/web/src/app/(authenticated)/uploads/page.tsx` (EDITED)

- Import `MobileUploadRunner` and `getDeviceType`.
- Call `getDeviceType()` (server-side) at the top of the page handler.
- On `device === "mobile"`: render `<MobileUploadRunner />` in place
  of the three explainer cards + `UploadProgress` tray.
- On `device === "desktop"`: keep the existing three-card +
  `UploadProgress` layout exactly as it is today.
- The "My recent uploads" table is rendered on both shells (no
  behaviour difference there).
- Wire `whatsappPhone` from `GML_WHATSAPP_NUMBER` ?? `WHATSAPP_PHONE_NUMBER_ID`
  — same env contract as spec 132's UploadModal so no new env vars.

## Acceptance criteria

- `MobileUploadRunner.tsx` exists and declares `"use client"`.
- `MOBILE_TILES` is a module-level const with two entries (record + pick).
- Two hidden file inputs exist — one with `capture="environment"`,
  one without.
- The two main tiles have `min-height: 56` (touch-target rule).
- A `data-testid="mobile-upload-runner"` root is present.
- The component imports `tus-js-client` (lazy) and posts to
  `/api/uploads/tus`.
- The component imports `useRouter` from `next/navigation` and
  redirects to `/uploads` on success.
- The uploads page imports `MobileUploadRunner` + `getDeviceType`.
- The uploads page conditionally renders `MobileUploadRunner` on
  `device === "mobile"` and the legacy explainer cards on
  `device === "desktop"`.
- The uploads page does NOT remove the existing `UploadProgress`
  import or component (desktop still uses it).
- `env(safe-area-inset-` appears in the source so notch devices are
  handled.
- All five spec-kit files exist under `specs/135-mobile-upload-runner/`.
- `tests/governance/test_135_mobile_upload_runner.test.mjs` passes.

## Non-goals

- **No new schema.** The tus metadata channel reuses the existing
  `filename / filetype / context_type / context_id / caption` keys
  the worker (spec 038 + 043) already understands.
- **No new dependencies.** `tus-js-client` was added in spec 045.
- **No changes to `UploadProgress`.** Desktop continues to use it
  unchanged.
- **No mobile-specific tus endpoint.** Single `/api/uploads/tus`
  serves both flows; the only browser-side difference is the file
  picker UX.
- **No re-skin of "My recent uploads" table.** Tier I of the
  Workflow Run 12 mobile-detail port (spec 136+) handles that.
- **No camera permissions prompt.** Modern browsers handle the prompt
  via the file input, not a separate `getUserMedia` call.
