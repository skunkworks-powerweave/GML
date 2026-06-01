# Tasks 124

- [x] T1 → write the singleton schema in packages/db/src/schema/systemSettings.ts; export SYSTEM_SETTINGS_ID sentinel; barrel from schema/index.ts
- [x] T2 → 0015_system_settings.sql migration + meta/_journal.json entry + meta/0015_snapshot.json (chained off 0014 prevId)
- [x] T3 → bootstrapSystemSettings(db) helper in packages/db/src/scripts/seed.ts; called from main() after bootstrapSuperAdmin
- [x] T4 → /api/admin/system-settings/route.ts with GET + PUT; super_admin gated; zod-validated; audits system_settings.update
- [x] T5 → /admin/system-settings/page.tsx — server component, server action, five sections, Save Changes flow with revalidatePath
- [x] T6 → swap the "Lands in spec 071" placeholder on /admin/page.tsx for a real Link
- [x] T7 → docs/audit-actions.md — register system_settings.*, backup.*, restore.* prefixes
- [x] T8 → governance test_124 with 8+ assertions (schema/table, singleton CHECK, route GET+PUT+audit, page presence of all 5 sections, audit registration, journal entry presence)
- [ ] T9 (deferred) → wire scripts/backup.sh to emit backup.complete / backup.failed audit rows; once done, the status panel populates without code changes
- [ ] T10 (deferred) → multi-tenant migration — drop the singleton CHECK and turn id into a tenant_id FK; covered by the tenant-introduction spec, not this one
