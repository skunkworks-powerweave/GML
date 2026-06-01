# Quickstart 124 — System settings admin

Manual smoke (2 minutes after `pnpm migrate` lands the 0015 migration):

1. Boot the app: `pnpm dev`. Sign in as the seeded `super_admin`.
2. Navigate to `/admin`. The "System settings" link card appears
   under the System section (it replaces the dashed-border
   "Lands in spec 071" placeholder).
3. Click through to `/admin/system-settings`. Five sections render:
   - Programme: `Goldenmile RTT` / `2026-27`.
   - Video pipeline: dropdown shows `480p (current)` selected,
     `720p (deferred — spec 041)` and `1080p (out of scope)`
     disabled. Max upload defaults to 500 MB.
   - Notifications: three checkboxes pre-checked (`cycle.assigned`,
     `video.transcoded`, `meeting.scheduled`), four unchecked.
   - Backups & retention: `14` days.
   - Backup & restore status: both rows show "never".
4. Change programme name to e.g. `Goldenmile RTT (smoke)`.
   Tick the `digest.weekly` checkbox. Click Save changes.
5. Page refreshes. Programme name shows new value. Checkbox stays
   ticked. The "Last updated" timestamp updates to current time.
6. Open `/admin/audit?action=system_settings.update`. The new row
   appears with the changed keys (`programmeName`,
   `notificationsEnabled`) in the metadata column.

Negative smoke (1 minute):

7. Sign in as a `programme_admin`. Visit `/admin/system-settings`.
   The requireRole guard redirects to `/forbidden`.
8. Curl `PUT /api/admin/system-settings` with no session cookie:
   expect 401.
9. Curl `PUT /api/admin/system-settings` with a `programme_admin`
   session: expect 403.
10. Curl `PUT /api/admin/system-settings` with `videoDefaultQuality: "720p"`
    as super_admin: expect 400 (validation_failed). The zod allow-list
    only permits "480p" today.

CI gates:

- `pnpm test` runs governance, including
  `test_124_system_settings_and_tweaks_admin.test.mjs` — should be green.
- `pnpm build` should be clean.
- `pnpm --filter @gml/db generate` (if rerun) should not produce a
  diff against the shipped snapshot.
