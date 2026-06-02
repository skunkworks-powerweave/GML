# Plan 135

CREATED: `specs/135-mobile-upload-runner/{spec,plan,research,quickstart,tasks}.md`, `apps/web/src/components/video/MobileUploadRunner.tsx`, `tests/governance/test_135_mobile_upload_runner.test.mjs`
EDITED: `apps/web/src/app/(authenticated)/uploads/page.tsx` (import `MobileUploadRunner` + `getDeviceType`, call `getDeviceType()` server-side, conditionally render the mobile runner in place of the three-card explainer + `UploadProgress` tray when the cookie / UA reports mobile, leave the recent-uploads table on both shells)
MIGRATED: none — the runner posts to the same `/api/uploads/tus` endpoint with the same metadata contract as `UploadProgress` (spec 045 / 038), the WhatsApp fallback link reuses the `GML_WHATSAPP_NUMBER` ?? `WHATSAPP_PHONE_NUMBER_ID` env chain from spec 132, and `tus-js-client` is already a dep on the graph — no schema, no API route, no env addition
