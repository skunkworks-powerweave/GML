# Plan 099

CREATED: `apps/web/src/app/api/audit/resource-view/route.ts`, `tests/governance/test_099_api_audit_resource_view.test.mjs`, `specs/099-api-audit-resource-view/{spec,plan,research,quickstart,tasks}.md`
EDITED: none (UI caller in `apps/web/src/components/pdf/PdfViewer.tsx` from spec 087 stays untouched — route accepts both `{ resourceId }` and legacy `{ id }` body shapes)
MIGRATED: none (rides existing `audit_log.action` varchar(64) from spec 021 with the new free-form `resource.view.client_ping` action string)
