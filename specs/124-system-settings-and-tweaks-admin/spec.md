# Spec 124 — System settings & tweaks admin (Workflow Run 10 frontend-parity)

## Why

The JSX prototype tweaks-panel.jsx ships an admin system-settings panel
covering five sections (Programme, Video pipeline, Notifications,
Backups & retention, status display). Spec 071 originally noted a
deviation: there was no `system_settings` table, so the live port
shipped only the *user-scoped* slice of settings (the `/settings`
page bound to `user_prefs`) and the programme-wide knobs were left
on a footnote pointing at `/admin`. The footnote linked to nothing
real. Spec 124 closes the deviation by introducing the singleton
`system_settings` table, the API route, the admin page, and the
seed bootstrap so the JSX surface ships end-to-end.

## What ships

- **Schema**: `system_settings` singleton table. One sentinel row
  pinned by a CHECK constraint to id `00000000-0000-0000-0000-000000000001`.
  Columns: programmeName, academicYear, videoDefaultQuality,
  videoMaxUploadMb, notificationsEnabled (jsonb array of category keys),
  backupRetentionDays, updatedAt.

- **Migration**: 0015_system_settings.sql — CREATE TABLE + the
  singleton CHECK + an idempotent INSERT seed-row so a migrate-only
  deployment still has the bootstrap row.

- **Seed helper**: `bootstrapSystemSettings(db)` in
  packages/db/src/scripts/seed.ts. Called from `main()` after
  `bootstrapSuperAdmin(db)`. Idempotent: SELECT-then-INSERT with
  ON CONFLICT DO NOTHING.

- **API route**: `/api/admin/system-settings` with GET + PUT.
  Both gated by super_admin (programme_admin gets 403 — the knobs
  are deployment-global). PUT validates with zod and audits
  `system_settings.update` with the list of changed keys.

- **Admin page**: `/admin/system-settings` — server component, five
  sections matching the JSX prototype:
  1. Programme (programmeName, academicYear)
  2. Video pipeline (default quality dropdown — 480p only, 720p/1080p
     disabled with tooltip explaining spec 041 deferral; max upload MB)
  3. Notifications (checkbox grid over 7 category keys)
  4. Backups & retention (retention days int)
  5. Read-only status — last backup audit timestamp + last restore
     audit timestamp from `audit_log` (action LIKE 'backup.%' / 'restore.%').
     The backup script does not yet emit these audit rows; the UI shows
     "never" until they ship.

- **Admin index link**: replaces the "Lands in spec 071" dead chip
  with a real `<Link>` to /admin/system-settings.

- **Audit taxonomy**: `system_settings.*`, `backup.*`, `restore.*`
  prefixes documented in docs/audit-actions.md.

## Substrate moats touched

- **SM-1 (audit moat)**: every PUT audits with the changed keys list.
  Surface view also audits (`system_settings.surface_viewed`). 
  Backup/restore taxonomy reserved for the script-side emission spec.

- **SM-2 (gate moat)**: super_admin only at three layers — page
  `requireRole(["super_admin"])`, server-action `requireRole(["super_admin"])`,
  API route `hasAnyRole(role, ["super_admin"])`. Belt-and-braces.

- **SM-4 (anti-download / quality ceiling)**: videoDefaultQuality
  is constrained to "480p" at the zod layer. The dropdown shows 720p
  and 1080p as disabled options. A future drive-by edit can't quietly
  enable them without also touching the zod allow-list and the worker.

## What we do NOT do

- No client component. The page uses an inline server action
  (`updateSystemSettings`) wrapped around `revalidatePath` for the
  refresh-after-save UX. No "use client" file ships.

- No multi-tenant scoping. The deployment is single-tenant today
  (Goldenmile RTT only). When multi-tenant lands, the singleton id
  pattern needs to become a per-tenant row keyed on tenant_id — that
  is explicitly out of scope here.

- No backup audit emission. scripts/backup.sh writes
  `/backups/last-backup.txt` on the host today; wiring it to also
  insert a `backup.complete` audit row is a deferred spec.

- No 720p / 1080p quality. SM-4 + spec 041 deferral hold.

## Acceptance criteria

- `packages/db/src/schema/systemSettings.ts` exports `systemSettings`
  and the `SYSTEM_SETTINGS_ID` sentinel.
- `packages/db/src/migrations/0015_system_settings.sql` exists,
  creates the table with the singleton CHECK, and INSERTs the seed row.
- `packages/db/src/migrations/meta/_journal.json` includes the 0015
  entry.
- `packages/db/src/migrations/meta/0015_snapshot.json` exists and
  chains off the 0014 snapshot id.
- `packages/db/src/scripts/seed.ts` exports/runs
  `bootstrapSystemSettings(db)` from main().
- `apps/web/src/app/api/admin/system-settings/route.ts` exposes
  GET + PUT, gates by super_admin, zod-validates, audits
  `system_settings.update`.
- `apps/web/src/app/(authenticated)/admin/system-settings/page.tsx`
  renders the five sections, posts to a server action that audits.
- `apps/web/src/app/(authenticated)/admin/page.tsx` no longer
  declares the "Lands in spec 071" placeholder; it links to
  /admin/system-settings.
- `tests/governance/test_124_system_settings_and_tweaks_admin.test.mjs`
  has at least 8 assertions covering the above and passes.

## Non-goals

- No bulk import/export of system_settings.
- No history table of changes — the audit log carries the trail.
- No feature flags. The notifications checkbox-grid is the closest
  thing to flags; broader feature-flag scaffolding is its own spec.
