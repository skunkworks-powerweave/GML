# Plan 088

CREATED: `apps/web/src/components/AntiDownloadGuard.tsx`, `tests/governance/test_088_anti_download_polish.test.mjs`, `specs/088-anti-download-polish/{spec,plan,research,quickstart,tasks}.md`
EDITED: `apps/web/src/app/globals.css` (appended `.no-select` / `.no-context` / `.media-frame::after` / `@media print` rules; no existing tokens touched), `apps/web/src/app/(authenticated)/layout.tsx` (imported and mounted `<AntiDownloadGuard />` alongside existing shells)
MIGRATED: none (no schema change; rides existing `audit_log.action` varchar(64) from spec 021 with new free-form `anti_download.*` action strings)
