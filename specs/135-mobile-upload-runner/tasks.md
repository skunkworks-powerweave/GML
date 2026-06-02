# Tasks 135

- [x] **t1** — Audit `apps/web/src/components/video/UploadProgress.tsx`
      to confirm the tus-js-client integration pattern (lazy import,
      chunkSize, onProgress/onSuccess hooks, metadata keys).
- [x] **t2** — Audit `LMS GML Frontend/mobile-runners.jsx` lines
      181-294 to confirm the prototype's three states + visual
      hierarchy.
- [x] **t3** — Audit `apps/web/src/lib/device.ts` to confirm the
      server-side `getDeviceType()` cookie / UA contract.
- [x] **t4** — Create `apps/web/src/components/video/MobileUploadRunner.tsx`
      as a `"use client"` component with five states
      (`choose | preview | uploading | done | failed`), two file
      inputs (with / without `capture="environment"`), a
      `MOBILE_TILES` module-level const, first-frame thumbnail
      extraction via a hidden canvas, lazy tus-js-client import,
      `useRouter` redirect on success, abort on unmount.
- [x] **t5** — Edit `apps/web/src/app/(authenticated)/uploads/page.tsx`
      to import `MobileUploadRunner` + `getDeviceType`, call
      `getDeviceType()` server-side, wire `whatsappPhone` from the
      env chain (`GML_WHATSAPP_NUMBER` ?? `WHATSAPP_PHONE_NUMBER_ID`),
      and conditionally render the mobile runner vs the
      desktop explainer cards + `UploadProgress` tray. The recent-
      uploads table stays on both shells.
- [x] **t6** — Write `tests/governance/test_135_mobile_upload_runner.test.mjs`
      with at least five assertions covering: component exists +
      `"use client"`; `MOBILE_TILES` is a module-level const with
      two entries; both file inputs exist with the correct
      `capture` attribute split; tus endpoint is `/api/uploads/tus`;
      `next/navigation` import; safe-area env() usage; uploads page
      device-aware branching.
- [x] **t7** — Write the five spec-kit files
      (`spec.md`, `plan.md`, `research.md`, `quickstart.md`,
      `tasks.md`).
- [x] **t8** — Run the governance test and confirm it passes.
