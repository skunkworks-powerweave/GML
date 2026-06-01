# Plan 087

CREATED: `apps/web/src/components/pdf/PdfViewer.tsx`, `apps/web/src/app/(authenticated)/repo/resource/[id]/view/page.tsx`, `tests/governance/test_087_pdf_canvas_viewer.test.mjs`, `specs/087-pdf-canvas-viewer/{spec,plan,research,quickstart,tasks}.md`
EDITED: `apps/web/src/app/(authenticated)/repo/resource/[id]/page.tsx` (button label `Download PDF` → `View PDF`; deferred-feature comment refreshed)
MIGRATED: none (no schema changes; reuses `resources.fileKey`, `audit_log`, and the `/api/media/[token]` route from spec 037 + 041)
