# Research 020

## D-001: schools.code NOT NULL + UNIQUE
For a fresh deploy this is safe. For any production migration with existing rows, would need a 3-step (nullable add → backfill → tighten). v2 ships before deploy; we set NOT NULL directly.

## D-002: SM-7 enforcement
Every `hindi_name` column on teachers/mentors/users is NULLABLE. Test asserts no `.notNull()` on those columns. Captures Hindi-optional invariant at code level.

## D-003: mentor_pairings.meetings_count denormalized
Real count comes from `mentor_meetings` (count of pairing_id rows). Denormalized for fast pairing-list views. Spec 094 hardening adds a backfill cron to keep in sync.

## D-004: observation_cycles.subject_id → curriculum subjects
The cycle was previously subject-less. Now we add an OPTIONAL FK to curriculum subjects. Cycles with no subject are still valid (covers fully-general observations).
