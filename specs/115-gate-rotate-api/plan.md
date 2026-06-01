# Plan 115

CREATED: `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts`, `apps/web/src/app/api/admin/gates/[slug]/share/route.ts`, `apps/web/src/app/(authenticated)/admin/gates/page.tsx`, `apps/web/src/app/(authenticated)/admin/gates/rotate-controls.tsx`, `tests/governance/test_115_gate_rotate_api.test.mjs`, `specs/115-gate-rotate-api/{spec,plan,research,quickstart,tasks}.md`
EDITED: `apps/web/src/app/(authenticated)/admin/page.tsx` (replaces the "Section gates" placeholder tile with a real `<Link href="/admin/gates">`)
MIGRATED: none — rides existing `section_gates` / `section_gate_grants` / `users` / `audit_log` tables; `audit_log.action` has been `varchar(64)` since spec 021 so the three new action strings land without enum migration
