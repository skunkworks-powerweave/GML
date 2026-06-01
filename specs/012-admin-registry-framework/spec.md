# Spec 012 — Admin Registry Framework

**Status:** in_progress · **Constitution:** SM-1 (every admin edit writes to audit_log via `withAudit`).

## Overview
Generic no-code admin: a registry that maps entity-slug → Drizzle table + Zod schema + label + scope; one `/admin/data/[entity]` route that renders TanStack-Table-style grid with inline edit, add, delete. All mutations go through `withAudit()`.

## User Stories
- **US1**: programme_admin visits `/admin/data/teachers` → sees the teachers table; edits a row inline → audit_log row created
- **US2**: adding a new admin-editable entity = adding a registry entry + Drizzle table + (optional) Zod schema; no developer needed for UI changes
- **US3**: forbidden roles get 403

## Functional Requirements
- **FR-001**: `apps/web/src/admin/registry.ts` exports `ADMIN_ENTITIES` map: `slug → { label, drizzleTable, displayColumns, formSchema (Zod), scopeRoles }`
- **FR-002**: `apps/web/src/app/admin/data/[entity]/page.tsx` renders the grid for `params.entity` (server component fetches rows; client island handles inline edit)
- **FR-003**: `apps/web/src/app/admin/data/[entity]/actions.ts` exposes `createRow`, `updateRow`, `deleteRow` server actions, all wrapped with `withAudit({entityType: slug, action: 'edit'|'delete'|'upload'})`
- **FR-004**: Zod validates input before insert/update
- **FR-005**: Pagination (50 rows/page) + simple sort by `updatedAt desc`
