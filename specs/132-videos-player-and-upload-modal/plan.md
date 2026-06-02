# Plan 132

CREATED: `specs/132-videos-player-and-upload-modal/{spec,plan,research,quickstart,tasks}.md`, `apps/web/src/components/video/UploadModal.tsx`, `tests/governance/test_132_videos_player_and_upload_modal.test.mjs`
EDITED: `apps/web/src/components/video/HlsPlayer.tsx` (add speed presets + quality select below the video element, lift SPEED_PRESETS to module-level const), `apps/web/src/app/(authenticated)/videos/page.tsx` (swap the `<Link href="/uploads">` Upload trigger for `<UploadModal whatsappPhone={...} />`, import UploadModal, comment the deviation from spec 044)
MIGRATED: none — speed + quality controls are pure browser-side UI state on `video.playbackRate` / `hls.currentLevel`; the upload modal reuses the existing UploadProgress component (spec 045) + tus-js-client pipeline + WHATSAPP_PHONE_NUMBER_ID env contract (spec 043), so no schema, no API route, no env addition
