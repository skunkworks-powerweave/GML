# Spec 020 — Schema additions migration

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-7 lands here (Hindi name fields stay optional everywhere).

## Overview

Add the columns the frontend prototype assumes but the v1 schema didn't have:

| Table | Columns added |
|---|---|
| `schools` | `code varchar(16) UNIQUE NOT NULL` |
| `users` | `hindi_name varchar(160) NULL` |
| `teachers` | `hindi_name varchar(160) NULL`, `current_phase_id uuid NULL REFERENCES phases.id ON DELETE SET NULL` |
| `mentors` | `hindi_name varchar(160) NULL`, `base_location varchar(80) NULL` |
| `mentor_pairings` | `current_quarter smallint NULL CHECK 1..4`, `meetings_count int NOT NULL DEFAULT 0`, `last_meeting_at timestamptz NULL` |
| `observation_cycles` | `subject_id uuid NULL REFERENCES subjects.id ON DELETE SET NULL`, `topic varchar(240) NULL`, `video_min int NULL CHECK >= 0` |

## FRs

- **FR-001**: Schema files edited: geography.ts (schools.code, teachers.hindi_name + current_phase_id), mentorship.ts (mentors.hindi_name + base_location, mentor_pairings additions), observation.ts (observation_cycles additions), identity.ts (users.hindi_name).
- **FR-002**: Migration `0009_schema_additions.sql` via drizzle-kit + descriptive rename.
- **FR-003**: SM-7 lands: every `hindi_name` column is NULLABLE. Governance test asserts this.
- **FR-004**: Existing entity files updated to include new columns in their displayColumns + formSchema where appropriate.
- **FR-005**: schools.code becomes a NEW required field in the schools admin entity.
