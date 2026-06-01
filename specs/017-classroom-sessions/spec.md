# Spec 017 — Classroom sessions

**Status:** in_progress · **Date:** 2026-06-01

## Overview

Classroom `sessions` — actual teaching sessions a teacher delivers to a class. Distinct from `rtt_sessions` (training cohort sessions). Optionally links to an `outline_lesson` (curriculum spine) and an `observation_cycle`.

## FRs

- **FR-001**: `packages/db/src/schema/sessions.ts` exports `sessions` (pgTable `sessions`). Columns: id, `school_id`, `class_id`, `subject_id`, `teacher_id` (all FK NOT NULL), `outline_lesson_id` FK SET NULL nullable, `scheduled_date date`, `scheduled_time time`, `duration_min int`, `topic varchar(240)`, `status varchar(16) DEFAULT 'planned'` (CHECK IN planned|in_progress|complete|cancelled), `attended_count int`, `total_count int`, `observed boolean DEFAULT false`, `observation_cycle_id` FK SET NULL, timestamps. Indexes `(school_id, scheduled_date)`, `(teacher_id, scheduled_date)`, `(class_id, scheduled_date)`. CHECK `attended_count <= total_count` and both `>= 0`; duration_min > 0 when not null.
- **FR-002**: barrel + admin entity slug `sessions`.
- **FR-003**: `0005_classroom_sessions.sql` via drizzle-kit + descriptive rename.
- **FR-004**: governance test.
