# Research 013

## D-001: Hand-write the ALTER TABLE RENAME migration

drizzle-kit's `generate` in non-interactive mode emits `DROP TABLE … ; CREATE TABLE …` when it sees a renamed table, because it can't infer the rename from a schema diff alone (it sees a removed-table + an added-table that happen to share columns). Interactive mode prompts "did you rename X to Y?" but the Bash tool can't drive interactive prompts cleanly.

Solution: write the ALTER TABLE RENAME SQL by hand. Then run `drizzle-kit generate` once to refresh the snapshot — when prompted, it'll either accept the rename or report "no diff" if we've already authored both the SQL and the snapshot manually.

## D-002: Migration file numbering

`0000_colorful_gauntlet.sql` (created in spec 004) defines the initial schema with the v1 names. Don't rewrite it — that would invalidate the git history's reproducibility. Add `0001_rename_rtt_tables.sql` that ALTERs the names. Both migrations apply in sequence on a fresh database; the end state matches the v2 schema.

## D-003: Admin entity file renames

`apps/web/src/admin/entities/attendance.ts` becomes `rtt-attendance.ts` (hyphen-cased filename matches existing convention like `mentor-pairings.ts`). The Drizzle import becomes `rttAttendance`. The entity's `slug` field stays `attendance` for now — spec 018 ships the new curriculum `attendance` table? No: v2 has `rtt_attendance` (training attendance) and per-classroom-session attendance lives ON the `sessions` table (`attended_count` / `total_count`). So `rtt-attendance` is the only attendance table. Slug renames to `rtt-attendance` in admin URL — `/admin/data/rtt-attendance`.

Same for subjects: `subjects.ts` → `rtt-subjects.ts`, slug `subjects` → `rtt-subjects`. Spec 014 introduces the curriculum `subjects` entity which will own the `subjects` slug.

## D-004: Don't run drizzle-kit generate yet

We'll author the migration + snapshot by hand, then verify via a governance test that the schema names match the file contents. Running `drizzle-kit generate` later (in spec 014) will then produce an additional migration for the NEW curriculum tables — by that point, the rename is already captured in 0001's snapshot.
