# Spec 013 — RTT-content table renames (v2)

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-1 unaffected (audit_log untouched). All renamed tables had no v1 deployment yet.

## Overview

Rename the v1 RTT-content tables in the schema layer to free the bare names for curriculum-side concepts that arrive in specs 014-019. **Reality check**: the v1 names (`subjects`, `lessons`, …) were defined in TS but only the *identity* tables made it into a Drizzle migration (`0000_colorful_gauntlet.sql`). The geography/mentorship/observation/rtt schemas existed in TS without a migration. So this spec ships migration **0001** that CREATEs every non-identity table — with v2 names from the start. No ALTER TABLE RENAME is needed because no DB ever saw the v1 names. The "rename" is a TS-layer reshape.

| Old (v1) | New (v2) |
|---|---|
| `subjects` | `rtt_subjects` |
| `subject_modules` | `rtt_modules` |
| `lessons` | `rtt_lessons` |
| `sessions_rtt` | `rtt_sessions` |
| `readings` | `rtt_readings` |
| `attendance` | `rtt_attendance` |

Drizzle exports rename too: `subjects → rttSubjects`, `subjectModules → rttModules`, `lessons → rttLessons`, `sessionsRtt → rttSessions`, `readings → rttReadings`, `attendance → rttAttendance`.

## User Stories

**US1**: After migration, the freed names (`subjects`, `sessions`) are available for spec 014 (curriculum subjects) + spec 017 (classroom sessions). The old RTT-content tables are still there, just under the `rtt_` prefix.

**Independent Test**: `pnpm test` green; `pnpm --filter @gml/db generate` produces no new schema diff (all renames captured in migration `0001`).

## Functional Requirements

- **FR-001**: `packages/db/src/schema/rtt.ts` exports `rttSubjects`, `rttModules`, `rttLessons`, `rttSessions`, `rttReadings`, `rttAttendance` (renamed Drizzle exports with `pgTable("rtt_subjects", …)` etc).
- **FR-002**: Migration `0001_v2_rtt_rename_plus_geography_mentorship_observation.sql` CREATEs all v2-named RTT tables + the geography/mentorship/observation tables that lacked migrations. No ALTER TABLE — these tables never existed on disk.
- **FR-003**: Drizzle snapshot files at `meta/0001_snapshot.json` reflect the v2 table names. `_journal.json` has the 0001 entry with the migration's friendly tag.
- **FR-004**: `apps/web/src/admin/entities/attendance.ts` renamed to `rtt-attendance.ts`; `subjects.ts` renamed to `rtt-subjects.ts`. Exports + slugs use the `rtt-` prefix. Registry imports updated.
- **FR-005**: 66 prior governance tests stay green. New test asserts schema names + migration file presence + admin registry slugs.

## Independent Test

```powershell
pnpm install
pnpm --filter @gml/db generate   # should report "no schema changes" (the rename is already captured in 0001)
pnpm test                        # 66 + new ≥ 4 pass
```

## Out of scope

- Adding the curriculum `subjects` table (spec 014)
- Adding the classroom `sessions` table (spec 017)
- Any data migration beyond pure table renames
